import { randomUUID } from "node:crypto";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { freezeNotification, NOTIFICATION_DELIVERY_POLICY, notificationBindingIdentity, projectNativeNotificationResult,
  validateNotificationBinding, validateNotificationTarget, type FrozenNotification, type NativeNotificationResult,
  type NotificationBinding, type NotificationReservation, type NotificationScope, type NotificationTarget } from "@grokbox/runtime-kernel/observation";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { noticeForWork, readIncidentEvidence } from "./incident-evidence.node.ts";
import type { MonitorSqlite, SqlRow } from "./monitor-sqlite.node.ts";
import { monitorWriteAdmission } from "./monitor-storage.node.ts";

const failure = (reason: string): never => { throw new BoxRuntimeError("invalid_usage", `notification_${reason}`); };
const timestamp = (n: number) => Number.isSafeInteger(n) && n > 0;
const state = (v: unknown) => ["reserved", "attempting", "native-accepted", "definitely-not-accepted", "unknown"].includes(String(v)) ? String(v) : failure("attempt_corrupt");
type AttemptRecord = { schemaVersion: 1; frozen: FrozenNotification; result: NativeNotificationResult | null };
type Access = { rootId: string; maxDatabaseBytes: number;
  read: <T>(f: (db: MonitorSqlite) => Promise<T>) => Promise<T>;
  mutate: <T>(f: (db: MonitorSqlite) => Promise<T>) => Promise<T> };
function decode(row: SqlRow): AttemptRecord {
  try {
    const value = JSON.parse(String(row.receipt_json)) as AttemptRecord, f = value.frozen;
    if (value.schemaVersion !== 1 || f.schemaVersion !== 1 || f.attemptId !== row.id || f.workId !== row.work_id
      || f.binding.agentId !== row.target_id || f.binding.revision !== row.binding_revision || !monitorUuid(f.incidentId)
      || !Number.isSafeInteger(f.evidenceRevision) || f.evidenceRevision < 1 || !timestamp(f.expiresAtMs)
      || !/^[a-f0-9]{64}$/.test(f.envelopeDigest) || !Number.isSafeInteger(f.envelopeBytes) || f.envelopeBytes < 1
      || f.envelopeBytes > NOTIFICATION_DELIVERY_POLICY.maxBytes) return failure("attempt_corrupt");
    const binding = validateNotificationBinding(f.binding, validateNotificationTarget(f.target), f.scope, Number(row.reserved_at));
    if (notificationBindingIdentity(binding) !== f.bindingDigest) return failure("attempt_corrupt");
    state(row.state);
    return { schemaVersion: 1, frozen: f, result: value.result === null ? null : projectNativeNotificationResult(value.result) };
  } catch { return failure("attempt_corrupt"); }
}
async function scope(db: MonitorSqlite, rootId: string): Promise<NotificationScope> {
  const meta = await db.first("SELECT database_id,root_id,version FROM meta WHERE singleton=1");
  if (!meta || meta.root_id !== rootId || !monitorUuid(meta.database_id) || meta.version !== 3) return failure("store_unavailable");
  return { databaseId: meta.database_id, scopeId: rootId };
}
async function pending(db: MonitorSqlite, workId: string, nowMs: number) {
  const work = await db.first("SELECT w.*,i.acknowledged,i.snooze_until FROM notification_work w LEFT JOIN incidents i ON i.id=w.incident_id WHERE w.id=?", [workId]);
  if (!work) return { reason: "not_found" } as const;
  if (!["ready", "blocked", "preparing", "attempting"].includes(String(work.state))) return { reason: String(work.state) === "expired" ? "expired" : "not_pending" } as const;
  if (Number(work.created_at) > nowMs) return { reason: "clock_reversed" } as const;
  if (Number(work.expires_at) <= nowMs) return { reason: "expired" } as const;
  if (await db.first("SELECT 1 FROM events WHERE incident_id=? AND kind='notification_export_unknown' LIMIT 1", [String(work.incident_id)])) return { reason: "prior_export_unknown" } as const;
  if (work.acknowledged === null || work.acknowledged === undefined) return { reason: "incident_missing" } as const;
  if (work.acknowledged === 1) return { reason: "acknowledged" } as const;
  if (work.snooze_until !== null && Number(work.snooze_until) > nowMs) return { reason: "snoozed" } as const;
  const snapshot = await db.first("SELECT tier,expires_at FROM incident_snapshots WHERE incident_id=? AND revision=?", [String(work.incident_id), Number(work.evidence_revision)]);
  if (!snapshot || snapshot.tier !== "detail" || Number(snapshot.expires_at) <= nowMs) return { reason: "evidence_unavailable" } as const;
  return { work } as const;
}

/** Uses the original monitor transaction and tables. One attempt per work in
 * this lane; unknown and even definite rejection are never automatically reset.
 * All reservations (including lost pre-send acknowledgements) consume the cap.
 * Not a generic network queue, native sender or bot action authority. */
export function notificationOutbox(access: Access) {
  return {
    notificationScope: () => access.read(db => scope(db, access.rootId)),
    acceptedNotificationSeed: (workId: string) => {
      if (!monitorUuid(workId)) return failure("invalid_work");
      return access.read(async db => {
        const rows = await db.all("SELECT a.* FROM notification_attempts a JOIN notification_work w ON w.id=a.work_id WHERE a.work_id=? AND w.state='completed' LIMIT 2", [workId]);
        if (rows.length !== 1) return null;
        const row = rows[0]!, record = decode(row);
        if (row.state !== "native-accepted" || record.result?.state !== "native-accepted" || !timestamp(Number(row.settled_at))) return null;
        if (canonicalJson(record.frozen.scope) !== canonicalJson(await scope(db, access.rootId))) return null;
        return { frozen: record.frozen, acceptedAtMs: Number(row.settled_at) };
      });
    },
    notificationBudgetAvailable: (target: NotificationTarget, nowMs: number) => {
      validateNotificationTarget(target); if (!timestamp(nowMs)) return failure("invalid_window");
      return access.read(async db => {
        const total = await db.first("SELECT COUNT(*) AS n,MAX(reserved_at) AS latest FROM notification_attempts");
        if (Number(total?.n) >= NOTIFICATION_DELIVERY_POLICY.maxAttempts || total?.latest !== null && Number(total?.latest) > nowMs) return false;
        const counted = await db.first("SELECT COUNT(*) AS installation,SUM(CASE WHEN target_id=? THEN 1 ELSE 0 END) AS target FROM notification_attempts WHERE reserved_at>?", [target.agentId, nowMs - NOTIFICATION_DELIVERY_POLICY.budgetWindowMs]);
        return Number(counted?.installation) < target.installationLimit && Number(counted?.target ?? 0) < target.targetLimit;
      });
    },
    /** A bounded index lookup, not permission to send. Authorization excludes all
     * pre-existing work; eligibility is checked again in the start transaction. */
    nextAutomaticNotification: (afterMs: number, nowMs: number) => {
      if (!timestamp(afterMs) || !timestamp(nowMs)) return failure("invalid_window");
      if (nowMs < afterMs) return Promise.resolve(null);
      return access.read(async db => {
        const row = await db.first(`SELECT w.id FROM notification_work w JOIN incidents i ON i.id=w.incident_id
          JOIN incident_snapshots s ON s.incident_id=w.incident_id AND s.revision=w.evidence_revision
          WHERE w.state IN ('ready','blocked','preparing') AND w.created_at>? AND w.created_at<=? AND w.expires_at>?
          AND i.first_seen>? AND i.first_seen<=?
          AND i.acknowledged=0 AND (i.snooze_until IS NULL OR i.snooze_until<=?) AND s.tier='detail' AND s.expires_at>?
          AND NOT EXISTS(SELECT 1 FROM notification_attempts a WHERE a.work_id=w.id)
          AND NOT EXISTS(SELECT 1 FROM events e WHERE e.incident_id=w.incident_id AND e.kind='notification_export_unknown')
          ORDER BY w.created_at,w.id LIMIT 1`, [afterMs, nowMs, nowMs, afterMs, nowMs, nowMs, nowMs]);
        return row ? String(row.id) : null;
      });
    },
    notificationDelivery: async (workId: string) => {
      if (!monitorUuid(workId)) return failure("invalid_work");
      return access.read(async db => {
        const work = await db.first("SELECT w.id,w.incident_id,w.evidence_revision,w.state,w.created_at,w.expires_at,i.first_seen AS incident_first_seen FROM notification_work w LEFT JOIN incidents i ON i.id=w.incident_id WHERE w.id=?", [workId]);
        if (!work) return { state: "not_found", automaticRetry: false, botReport: "not_observed", userRead: "not_observed" };
        const rows = await db.all("SELECT * FROM notification_attempts WHERE work_id=? ORDER BY reserved_at LIMIT 2", [workId]);
        if (rows.length > 1) return failure("attempt_conflict");
        const attempt = rows[0], decoded = attempt ? decode(attempt) : null;
        return { state: attempt && ["reserved", "attempting", "unknown"].includes(String(attempt.state)) ? "unknown" : String(work.state),
          workId, incidentId: String(work.incident_id), evidenceRevision: Number(work.evidence_revision),
          createdAtMs: Number(work.created_at), expiresAtMs: Number(work.expires_at),
          incidentFirstSeenAtMs: work.incident_first_seen === null || work.incident_first_seen === undefined ? null : Number(work.incident_first_seen),
          attempt: attempt && decoded ? { attemptId: String(attempt.id), state: state(attempt.state),
            targetAgentId: String(attempt.target_id), bindingRevision: Number(attempt.binding_revision),
            envelopeDigest: decoded.frozen.envelopeDigest, envelopeBytes: decoded.frozen.envelopeBytes,
            reservedAtMs: Number(attempt.reserved_at), settledAtMs: attempt.settled_at === null ? null : Number(attempt.settled_at), result: decoded.result } : null,
          automaticRetry: false, botReport: "not_observed", userRead: "not_observed", transportAvailability: "not_checked" };
      });
    },
    reserveNotification: async (input: { workId: string; target: NotificationTarget; binding: NotificationBinding; nowMs: number }): Promise<NotificationReservation> => {
      if (!monitorUuid(input.workId) || !timestamp(input.nowMs)) return failure("invalid_reservation");
      return access.mutate(async db => {
        const destination = validateNotificationTarget(input.target), installation = await scope(db, access.rootId);
        const binding = validateNotificationBinding(input.binding, destination, installation, input.nowMs);
        const previous = await db.first("SELECT state FROM notification_attempts WHERE work_id=? LIMIT 1", [input.workId]);
        if (previous) return { state: "already_attempted", attemptState: state(previous.state) };
        const eligibility = await pending(db, input.workId, input.nowMs);
        if (!eligibility.work) return { state: "blocked", reason: eligibility.reason };
        const totals = await db.first("SELECT COUNT(*) AS n,MAX(reserved_at) AS latest FROM notification_attempts");
        if (Number(totals?.n) >= NOTIFICATION_DELIVERY_POLICY.maxAttempts) return { state: "blocked", reason: "attempt_capacity" };
        if (totals?.latest !== null && Number(totals?.latest) > input.nowMs) return { state: "blocked", reason: "clock_reversed" };
        const cutoff = input.nowMs - NOTIFICATION_DELIVERY_POLICY.budgetWindowMs;
        const counters = await db.first("SELECT COUNT(*) AS installation,SUM(CASE WHEN target_id=? THEN 1 ELSE 0 END) AS target FROM notification_attempts WHERE reserved_at>?", [destination.agentId, cutoff]);
        if (Number(counters?.installation) >= destination.installationLimit || Number(counters?.target ?? 0) >= destination.targetLimit)
          return { state: "blocked", reason: "wake_budget" };
        if (!(await monitorWriteAdmission(db, access.maxDatabaseBytes, 32768)).accepted) return { state: "blocked", reason: "storage_pressure" };
        const evidence = await readIncidentEvidence(db, String(eligibility.work.incident_id), Number(eligibility.work.evidence_revision));
        if (evidence.state !== "available") return { state: "blocked", reason: "evidence_unavailable" };
        const notice = await noticeForWork(db, input.workId), attemptId = randomUUID();
        const prepared = freezeNotification({ scope: installation, target: destination, binding, workId: input.workId, attemptId,
          createdAtMs: input.nowMs, expiresAtMs: Number(eligibility.work.expires_at), notice });
        await db.run("INSERT INTO notification_attempts(id,work_id,target_id,binding_revision,state,reserved_at,receipt_json) VALUES(?,?,?,?,'reserved',?,?)",
          [attemptId, input.workId, destination.agentId, binding.revision, input.nowMs, canonicalJson({ schemaVersion: 1, frozen: prepared.frozen, result: null })]);
        await db.run("UPDATE notification_work SET state='attempting',last_reason='delivery_reserved' WHERE id=?", [input.workId]);
        return { state: "reserved", frozen: prepared.frozen, envelope: prepared.envelope };
      });
    },
    beginNotification: async (input: { workId: string; attemptId: string; envelopeDigest: string; bindingDigest: string; nowMs: number }) => {
      if (!monitorUuid(input.workId) || !monitorUuid(input.attemptId) || !timestamp(input.nowMs)) return failure("invalid_start");
      return access.mutate(async db => {
        const row = await db.first("SELECT * FROM notification_attempts WHERE id=? AND work_id=?", [input.attemptId, input.workId]);
        if (!row) return failure("attempt_missing");
        const record = decode(row);
        if (record.frozen.envelopeDigest !== input.envelopeDigest || record.frozen.bindingDigest !== input.bindingDigest) return failure("attempt_conflict");
        if (row.state !== "reserved") return { dispatch: false, reason: "already_attempted" };
        const valid = await pending(db, input.workId, input.nowMs);
        if (!valid.work || input.nowMs < Number(row.reserved_at)) return { dispatch: false, reason: valid.reason ?? "clock_reversed" };
        await db.run("UPDATE notification_attempts SET state='attempting' WHERE id=?", [input.attemptId]);
        return { dispatch: true, reason: "reserved_transition" };
      });
    },
    settleNotification: async (input: { workId: string; attemptId: string; nowMs: number; result: NativeNotificationResult }) => {
      if (!monitorUuid(input.workId) || !monitorUuid(input.attemptId) || !timestamp(input.nowMs)) return failure("invalid_settlement");
      const observed = projectNativeNotificationResult(input.result);
      return access.mutate(async db => {
        const row = await db.first("SELECT * FROM notification_attempts WHERE id=? AND work_id=?", [input.attemptId, input.workId]);
        if (!row) return failure("attempt_missing");
        const record = decode(row);
        if (input.nowMs < Number(row.reserved_at)) return failure("clock_reversed");
        if (!["reserved", "attempting"].includes(String(row.state))) {
          if (record.result && canonicalJson(record.result) === canonicalJson(observed)) return { state: String(row.state), duplicate: true };
          return failure("settlement_conflict");
        }
        if (row.state === "reserved" && observed.state === "native-accepted") return failure("attempt_not_started");
        await db.run("UPDATE notification_attempts SET state=?,settled_at=?,receipt_json=? WHERE id=?",
          [observed.state, input.nowMs, canonicalJson({ schemaVersion: 1, frozen: record.frozen, result: observed }), input.attemptId]);
        await db.run("UPDATE notification_work SET state=?,last_reason=? WHERE id=?", [observed.state === "native-accepted" ? "completed" : observed.state === "unknown" ? "unknown" : "blocked", observed.state, input.workId]);
        return { state: observed.state, duplicate: false };
      });
    },
  };
}
