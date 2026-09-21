import { randomUUID } from "node:crypto";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { freezeNotification, NOTIFICATION_DELIVERY_POLICY, notificationBindingIdentity, projectNativeNotificationResult,
  validateNotificationBinding, validateNotificationTarget, notificationTestNotice, type FrozenNotification, type NativeNotificationResult,
  type NotificationBinding, type NotificationReservation, type NotificationScope, type NotificationTarget } from "@grokbox/runtime-kernel/observation";
import { monitorUuid } from "@grokbox/runtime-kernel/monitor";
import { noticeForWork, readIncidentEvidence } from "./incident-evidence.node.ts";
import type { MonitorSqlite, SqlRow } from "./monitor-sqlite.node.ts";
import { monitorWriteAdmission } from "./monitor-storage.node.ts";
import { MONITOR_SCHEMA_VERSION } from "./monitor-schema.node.ts";

export const NOTIFICATION_SCHEMA = `
CREATE TABLE notification_tests(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,
  target_alias TEXT NOT NULL,binding_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,model_revision TEXT NOT NULL,
  created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,last_reason TEXT);
CREATE INDEX notification_tests_created ON notification_tests(created_at,id);
CREATE TABLE notification_sends(operation_id TEXT PRIMARY KEY,work_id TEXT NOT NULL UNIQUE,request_digest TEXT NOT NULL,
  binding_id TEXT NOT NULL,binding_revision INTEGER NOT NULL,model_revision TEXT NOT NULL,created_at INTEGER NOT NULL,
  attempt_id TEXT UNIQUE,reason TEXT);
`;
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
      || f.binding.agentId !== row.target_id || f.binding.revision !== row.binding_revision
      || (f.incidentId === null ? f.evidenceRevision !== null : !monitorUuid(f.incidentId) || !Number.isSafeInteger(f.evidenceRevision) || Number(f.evidenceRevision) < 1)
      || !timestamp(f.expiresAtMs)
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
  if (!meta || meta.root_id !== rootId || !monitorUuid(meta.database_id) || meta.version !== MONITOR_SCHEMA_VERSION) return failure("store_unavailable");
  return { databaseId: meta.database_id, scopeId: rootId };
}
async function pending(db: MonitorSqlite, workId: string, nowMs: number) {
  const work = await db.first("SELECT w.*,i.acknowledged,i.snooze_until FROM notification_work w LEFT JOIN incidents i ON i.id=w.incident_id WHERE w.id=?", [workId]);
  if (!work) {
    const test = await db.first("SELECT * FROM notification_tests WHERE id=?", [workId]);
    if (!test) return { reason: "not_found" } as const;
    if (Number(test.created_at) > nowMs) return { reason: "clock_reversed" } as const;
    if (Number(test.expires_at) <= nowMs) return { reason: "expired" } as const;
    if (!["ready", "attempting"].includes(String(test.state))) return { reason: "not_pending" } as const;
    return { work: { ...test, incident_id: null, evidence_revision: null } as SqlRow, test } as const;
  }
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
    notificationSend: (databaseId: string, operationId: string) => access.read(async db => {
      if (!/^[a-f0-9]{64}$/.test(operationId) || (await scope(db, access.rootId)).databaseId !== databaseId) return failure("scope_changed");
      const row = await db.first("SELECT * FROM notification_sends WHERE operation_id=?", [operationId]);
      if (!row) return null;
      if (!monitorUuid(row.work_id) || !monitorUuid(row.binding_id) || !timestamp(Number(row.binding_revision))
        || typeof row.request_digest !== "string" || !/^[a-f0-9]{64}$/.test(row.request_digest)
        || typeof row.model_revision !== "string" || !/^[a-f0-9]{64}$/.test(row.model_revision)
        || !timestamp(Number(row.created_at)) || row.reason !== null && !["not-dispatched", "already-attempted", "permission-revoked", "cancelled-before-dispatch"].includes(String(row.reason))) return failure("send_corrupt");
      const attempt = row.attempt_id === null ? null : await db.first("SELECT * FROM notification_attempts WHERE id=? AND work_id=?", [String(row.attempt_id), row.work_id]);
      if (row.attempt_id !== null && !attempt) return failure("send_corrupt");
      const decoded = attempt ? decode(attempt) : null;
      if (decoded && (decoded.frozen.binding.bindingId !== row.binding_id || decoded.frozen.binding.revision !== row.binding_revision
        || decoded.frozen.binding.modelRevision !== row.model_revision || decoded.frozen.scope.databaseId !== databaseId || row.reason !== null)) return failure("send_corrupt");
      return { operationId, requestDigest: row.request_digest, workId: row.work_id, bindingId: row.binding_id,
        bindingRevision: Number(row.binding_revision), modelRevision: row.model_revision,
        reason: row.reason as "not-dispatched" | "already-attempted" | "permission-revoked" | "cancelled-before-dispatch" | null,
        attempt: attempt && decoded ? { attemptId: String(attempt.id), state: state(attempt.state), targetAgentId: String(attempt.target_id),
          bindingRevision: Number(attempt.binding_revision), envelopeDigest: decoded.frozen.envelopeDigest, envelopeBytes: decoded.frozen.envelopeBytes,
          reservedAtMs: Number(attempt.reserved_at), settledAtMs: attempt.settled_at === null ? null : Number(attempt.settled_at) } : null };
    }),
    /** An immutable management claim over existing incident work. Its lost ACK
     * cannot authorize a later caller to run the delivery program again. */
    createNotificationSend: (input: { databaseId: string; workId: string; operationId: string; requestDigest: string;
      bindingId: string; bindingRevision: number; modelRevision: string; nowMs: number }) => access.mutate(async db => {
      if (!monitorUuid(input.workId) || !monitorUuid(input.bindingId) || !/^[a-f0-9]{64}$/.test(input.operationId)
        || !/^[a-f0-9]{64}$/.test(input.requestDigest) || !/^[a-f0-9]{64}$/.test(input.modelRevision)
        || !timestamp(input.bindingRevision) || !timestamp(input.nowMs)) return failure("invalid_send");
      if ((await scope(db, access.rootId)).databaseId !== input.databaseId) return failure("scope_changed");
      const prior = await db.first("SELECT * FROM notification_sends WHERE operation_id=? OR work_id=?", [input.operationId, input.workId]);
      if (prior) {
        if (prior.operation_id !== input.operationId || prior.work_id !== input.workId || prior.request_digest !== input.requestDigest
          || prior.binding_id !== input.bindingId || prior.binding_revision !== input.bindingRevision || prior.model_revision !== input.modelRevision) return failure("send_conflict");
        return { created: false, dispatch: false };
      }
      // Tests have a separate authority and request owner; incident send cannot
      // be used to repeat or hijack an optional test.
      if (!await db.first("SELECT 1 FROM notification_work WHERE id=?", [input.workId])) return failure("work_not_found");
      if (Number((await db.first("SELECT COUNT(*) AS n FROM notification_sends"))?.n) >= NOTIFICATION_DELIVERY_POLICY.maxAttempts) return failure("send_capacity");
      if (!(await monitorWriteAdmission(db, access.maxDatabaseBytes, 32768)).accepted) return failure("storage_pressure");
      const attempted = await db.first("SELECT 1 FROM notification_attempts WHERE work_id=?", [input.workId]);
      const eligibility = attempted ? null : await pending(db, input.workId, input.nowMs);
      const reason = attempted ? "already-attempted" : !eligibility?.work ? "not-dispatched" : null;
      await db.run("INSERT INTO notification_sends(operation_id,work_id,request_digest,binding_id,binding_revision,model_revision,created_at,reason) VALUES(?,?,?,?,?,?,?,?)",
        [input.operationId, input.workId, input.requestDigest, input.bindingId, input.bindingRevision, input.modelRevision, input.nowMs, reason]);
      return { created: true, dispatch: reason === null };
    }),
    finishNotificationSendWithoutAttempt: (databaseId: string, operationId: string,
      reason: "not-dispatched" | "already-attempted" | "permission-revoked" | "cancelled-before-dispatch") => access.mutate(async db => {
      if (!/^[a-f0-9]{64}$/.test(operationId) || !["not-dispatched", "already-attempted", "permission-revoked", "cancelled-before-dispatch"].includes(reason)) return failure("invalid_send");
      if ((await scope(db, access.rootId)).databaseId !== databaseId) return failure("scope_changed");
      // Only the actual original invocation may report this zero-dispatch
      // boundary. Reconciliation never invokes this method to guess an outcome.
      await db.run("UPDATE notification_sends SET reason=? WHERE operation_id=? AND attempt_id IS NULL AND reason IS NULL", [reason, operationId]);
    }),
    notificationTest: (databaseId: string, workId: string) => access.read(async db => {
      if (!monitorUuid(workId) || (await scope(db, access.rootId)).databaseId !== databaseId) return failure("scope_changed");
      const row = await db.first("SELECT * FROM notification_tests WHERE id=?", [workId]);
      return row ? { workId: String(row.id), operationId: String(row.operation_id), requestDigest: String(row.request_digest),
        alias: String(row.target_alias), bindingId: String(row.binding_id), bindingRevision: Number(row.binding_revision), modelRevision: String(row.model_revision),
        createdAtMs: Number(row.created_at), expiresAtMs: Number(row.expires_at) } : null;
    }),
    createNotificationTest: (input: { databaseId: string; workId: string; operationId: string; requestDigest: string; alias: string;
      bindingId: string; bindingRevision: number; modelRevision: string; nowMs: number }) => access.mutate(async db => {
      if (!monitorUuid(input.workId) || !/^[a-f0-9]{64}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.requestDigest)
        || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.alias) || !monitorUuid(input.bindingId) || !timestamp(input.bindingRevision)
        || !/^[a-f0-9]{64}$/.test(input.modelRevision) || !timestamp(input.nowMs)) return failure("invalid_test");
      if ((await scope(db, access.rootId)).databaseId !== input.databaseId) return failure("scope_changed");
      const prior = await db.first("SELECT * FROM notification_tests WHERE id=? OR operation_id=?", [input.workId, input.operationId]);
      if (prior) {
        if (prior.id !== input.workId || prior.operation_id !== input.operationId || prior.request_digest !== input.requestDigest) return failure("test_conflict");
        return { created: false, workId: input.workId };
      }
      if (Number((await db.first("SELECT COUNT(*) AS n FROM notification_tests"))?.n) >= 128) return failure("test_capacity");
      if (!(await monitorWriteAdmission(db, access.maxDatabaseBytes, 32768)).accepted) return failure("storage_pressure");
      await db.run("INSERT INTO notification_tests(id,operation_id,request_digest,target_alias,binding_id,binding_revision,model_revision,created_at,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,'ready')",
        [input.workId, input.operationId, input.requestDigest, input.alias, input.bindingId, input.bindingRevision, input.modelRevision, input.nowMs, input.nowMs + 15 * 60_000]);
      return { created: true, workId: input.workId };
    }),
    settleNotificationTestWithoutAttempt: (workId: string) => access.mutate(async db => {
      if (!monitorUuid(workId)) return failure("invalid_test");
      await db.run("UPDATE notification_tests SET state='blocked',last_reason='preflight_blocked' WHERE id=? AND state='ready' AND NOT EXISTS(SELECT 1 FROM notification_attempts WHERE work_id=?)", [workId, workId]);
    }),
    notificationPage: (after: string | undefined, limit: number) => access.read(async db => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return failure("invalid_page");
      const current = await scope(db, access.rootId);
      let before = Number.MAX_SAFE_INTEGER, id = "";
      if (after) {
        const parts = after.split(":");
        if (parts.length !== 3 || parts[0] !== current.databaseId || !/^[1-9][0-9]*$/.test(parts[1]!) || !Number.isSafeInteger(Number(parts[1])) || !monitorUuid(parts[2])) return failure("cursor_gap");
        before = Number(parts[1]); id = parts[2]!;
      }
      const rows = await db.all(`SELECT id,created_at FROM (SELECT id,created_at FROM notification_work UNION ALL SELECT id,created_at FROM notification_tests)
        WHERE created_at<? OR (created_at=? AND id>?) ORDER BY created_at DESC,id LIMIT ?`, [before, before, id, limit + 1]);
      const selected = rows.slice(0, limit), last = selected.at(-1);
      return { databaseId: current.databaseId, ids: selected.map(row => String(row.id)), nextCursor: rows.length > limit && last ? `${current.databaseId}:${last.created_at}:${last.id}` : null };
    }),
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
          AND NOT EXISTS(SELECT 1 FROM notification_sends d WHERE d.work_id=w.id)
          AND NOT EXISTS(SELECT 1 FROM events e WHERE e.incident_id=w.incident_id AND e.kind='notification_export_unknown')
          ORDER BY w.created_at,w.id LIMIT 1`, [afterMs, nowMs, nowMs, afterMs, nowMs, nowMs, nowMs]);
        return row ? String(row.id) : null;
      });
    },
    quarantineRestoredNotification: async (workId: string, occurrenceIdentity: string) => {
      if (!monitorUuid(workId) || !/^[a-f0-9]{64}$/.test(occurrenceIdentity)) return failure("invalid_work");
      return access.mutate(async db => {
        const work = await db.first(`SELECT w.state,i.scope,i.rule,i.occurrence_key,i.first_seen FROM notification_work w
          JOIN incidents i ON i.id=w.incident_id WHERE w.id=?`, [workId]);
        if (!work || sha256Text(canonicalJson([work.scope, work.rule, work.occurrence_key, work.first_seen])) !== occurrenceIdentity)
          return { state: "unavailable" as const };
        if (await db.first("SELECT 1 FROM notification_attempts WHERE work_id=?", [workId])) return { state: "already_attempted" as const };
        // A live sender remembers the occurrence, but the restored database has
        // lost its attempt. Preserve unknown instead of fabricating acceptance
        // or letting this oldest work starve unrelated new notifications.
        if (["ready", "blocked", "preparing"].includes(String(work.state)))
          await db.run("UPDATE notification_work SET state='unknown',last_reason='live_attempt_missing_after_restore' WHERE id=?", [workId]);
        return { state: "quarantined" as const };
      });
    },
    notificationDelivery: async (workId: string, databaseId?: string) => {
      if (!monitorUuid(workId)) return failure("invalid_work");
      return access.read(async db => {
        if (databaseId !== undefined && (await scope(db, access.rootId)).databaseId !== databaseId) return failure("scope_changed");
        let work = await db.first("SELECT w.id,w.incident_id,w.evidence_revision,w.state,w.created_at,w.expires_at,i.first_seen AS incident_first_seen,i.scope AS incident_scope,i.occurrence_key,i.rule FROM notification_work w LEFT JOIN incidents i ON i.id=w.incident_id WHERE w.id=?", [workId]);
        const test = work ? null : await db.first("SELECT * FROM notification_tests WHERE id=?", [workId]);
        if (!work && test) work = { ...test, incident_id: null, evidence_revision: null, incident_first_seen: null, incident_scope: null, occurrence_key: null, rule: null };
        if (!work) return { state: "not_found", automaticRetry: false, botReport: "not_observed", userRead: "not_observed" };
        const rows = await db.all("SELECT * FROM notification_attempts WHERE work_id=? ORDER BY reserved_at LIMIT 2", [workId]);
        if (rows.length > 1) return failure("attempt_conflict");
        const attempt = rows[0], decoded = attempt ? decode(attempt) : null;
        const manual = test ? null : await db.first("SELECT attempt_id,reason FROM notification_sends WHERE work_id=?", [workId]);
        if (manual?.attempt_id !== null && manual?.attempt_id !== undefined && manual.attempt_id !== attempt?.id) return failure("send_corrupt");
        // A durable send claim with no attempt is still unresolved. Lists and
        // detail readers must not offer that work as fresh ready-to-send work.
        return { state: attempt && ["reserved", "attempting", "unknown"].includes(String(attempt.state)) ? "unknown"
          : !attempt && manual ? manual.reason === null ? "unknown" : "blocked" : String(work.state),
          purpose: test ? "test" : "incident", workId, incidentId: work.incident_id === null ? null : String(work.incident_id), evidenceRevision: work.evidence_revision === null ? null : Number(work.evidence_revision),
          createdAtMs: Number(work.created_at), expiresAtMs: Number(work.expires_at),
          incidentFirstSeenAtMs: work.incident_first_seen === null || work.incident_first_seen === undefined ? null : Number(work.incident_first_seen),
          occurrenceIdentity: typeof work.incident_scope === "string" && typeof work.occurrence_key === "string"
            ? sha256Text(canonicalJson([work.incident_scope, work.rule, work.occurrence_key, work.incident_first_seen])) : null,
          attempt: attempt && decoded ? { attemptId: String(attempt.id), state: state(attempt.state),
            targetAgentId: String(attempt.target_id), bindingRevision: Number(attempt.binding_revision),
            envelopeDigest: decoded.frozen.envelopeDigest, envelopeBytes: decoded.frozen.envelopeBytes,
            reservedAtMs: Number(attempt.reserved_at), settledAtMs: attempt.settled_at === null ? null : Number(attempt.settled_at), result: decoded.result } : null,
          automaticRetry: false, botReport: "not_observed", userRead: "not_observed", transportAvailability: "not_checked" };
      });
    },
    reserveNotification: async (input: { workId: string; target: NotificationTarget; binding: NotificationBinding; nowMs: number; managementOperationId?: string }): Promise<NotificationReservation> => {
      if (!monitorUuid(input.workId) || !timestamp(input.nowMs)) return failure("invalid_reservation");
      return access.mutate(async db => {
        const destination = validateNotificationTarget(input.target), installation = await scope(db, access.rootId);
        const binding = validateNotificationBinding(input.binding, destination, installation, input.nowMs);
        const previous = await db.first("SELECT state FROM notification_attempts WHERE work_id=? LIMIT 1", [input.workId]);
        if (previous) return { state: "already_attempted", attemptState: state(previous.state) };
        const management = await db.first("SELECT * FROM notification_sends WHERE work_id=?", [input.workId]);
        if (management || input.managementOperationId !== undefined) {
          if (!management || management.operation_id !== input.managementOperationId || management.attempt_id !== null || management.reason !== null
            || management.binding_id !== binding.bindingId || management.binding_revision !== binding.revision || management.model_revision !== binding.modelRevision)
            return { state: "blocked", reason: "management_send_owned_or_changed" };
        }
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
        const test = "test" in eligibility ? eligibility.test : undefined;
        if (test && (test.binding_id !== binding.bindingId || test.binding_revision !== binding.revision || test.target_alias !== destination.alias || test.model_revision !== binding.modelRevision))
          return { state: "blocked", reason: "test_target_changed" };
        if (!test) {
          const evidence = await readIncidentEvidence(db, String(eligibility.work.incident_id), Number(eligibility.work.evidence_revision));
          if (evidence.state !== "available") return { state: "blocked", reason: "evidence_unavailable" };
        }
        const notice = test ? notificationTestNotice(input.workId, Number(test.created_at), Number(test.expires_at)) : await noticeForWork(db, input.workId), attemptId = randomUUID();
        const prepared = freezeNotification({ scope: installation, target: destination, binding, workId: input.workId, attemptId,
          createdAtMs: input.nowMs, expiresAtMs: Number(eligibility.work.expires_at), notice });
        await db.run("INSERT INTO notification_attempts(id,work_id,target_id,binding_revision,state,reserved_at,receipt_json) VALUES(?,?,?,?,'reserved',?,?)",
          [attemptId, input.workId, destination.agentId, binding.revision, input.nowMs, canonicalJson({ schemaVersion: 1, frozen: prepared.frozen, result: null })]);
        if (management) await db.run("UPDATE notification_sends SET attempt_id=? WHERE operation_id=?", [attemptId, String(management.operation_id)]);
        await db.run(`UPDATE ${test ? "notification_tests" : "notification_work"} SET state='attempting',last_reason='delivery_reserved' WHERE id=?`, [input.workId]);
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
        await db.run(`UPDATE ${record.frozen.incidentId === null ? "notification_tests" : "notification_work"} SET state=?,last_reason=? WHERE id=?`, [observed.state === "native-accepted" ? "completed" : observed.state === "unknown" ? "unknown" : "blocked", observed.state, input.workId]);
        return { state: observed.state, duplicate: false };
      });
    },
  };
}
