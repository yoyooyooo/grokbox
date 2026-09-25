import { beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { captureCli } from "../../../test/helpers.ts";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";

let packedCli = "";
beforeAll(() => { packedCli = ensurePackedCli(); }, 90000);
import { defaultConfig, effectiveOps, validateConfig } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { createNoticeReplayFence, selectNotificationTarget, type NotificationBinding, type NotificationScope, type NotificationTarget } from "@grokbox/runtime-kernel/observation";
import { openMonitorStore, type MonitorStoreOptions } from "../src/internal/io/monitor-store.node.ts";
import { acquireConfigurationLease } from "../src/internal/io/config-lock.node.ts";
import { runOpsNotificationDelivery, type PairedNotificationDriver } from "../src/internal/roots/ops-notification.runtime.ts";

const SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", RECEIVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", DAY = 86400000;
async function fixture(max = 10) {
  const root = await mkdtemp(join(tmpdir(), "ops-delivery-")), configPath = join(root, "config.json"), epoch = randomUUID();
  let now = Date.now(), cursor: string | null = null, count = 0;
  let doc = validateConfig({ ...defaultConfig(), ops: { notifications: { maxAutomaticWakeupsPerDay: max },
    targets: { default: { agentId: RECEIVER, routineKey: "ops-notice", maxAutomaticWakeupsPerDay: max } } } });
  await writeFile(configPath, JSON.stringify(doc), { mode: 0o600 });
  const store = openMonitorStore(root); await store.initialize(); await store.begin(epoch, now, [SUBJECT]);
  const scope = await store.notificationScope();
  const selected = () => {
    const route = selectNotificationTarget(effectiveOps(doc.ops)); if (route.state !== "selected") throw Error("fixture_target_unselected"); return route.target;
  };
  const bindingId = randomUUID();
  const bind = (target = selected(), installation = scope): NotificationBinding => ({ bindingId, revision: 1,
    ...installation, targetAlias: target.alias, agentId: target.agentId, routineKey: target.routineKey, routineId: "notice-1",
    routineRevision: "c".repeat(64), modelRevision: "d".repeat(64), qualificationRevision: "e".repeat(64),
    policyRevision: target.policyRevision, dataPolicy: "safe-summary", receiverMode: "notify_then_end", observedAtMs: now, validUntilMs: now + 5000 });
  const emit = async () => {
    count++; const nextCursor = `cursor-${count}`;
    await store.ingestEvidence({ epoch, sourceKey: "f".repeat(64), expectedCursor: cursor, nextCursor, atMs: now,
      events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(now).toISOString(), mode: "route", hostGenerationId: "1".repeat(64),
        agentId: SUBJECT, stepId: `step-${count}`, turnId: `turn-${count}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream",
        raw: "PRIVATE_PROMPT", secret: "PRIVATE_KEY", modelError: "PRIVATE_CONTENT" }] });
    cursor = nextCursor;
    const works = await store.notificationWork(); return String(works.find(w => w.createdAtMs === now && w.incidentId !== undefined && !used.has(String(w.id)))!.id);
  };
  const used = new Set<string>();
  const work = async () => { const id = await emit(); used.add(id); return id; };
  return { root, configPath, store, scope, epoch, bind, selected, work, now: () => now, advance: (ms: number) => { now += ms; },
    update: async (ops: object) => { doc = validateConfig({ ...doc, ops }); await writeFile(configPath, JSON.stringify(doc), { mode: 0o600 }); },
    close: () => rm(root, { recursive: true, force: true }) };
}
const driverFor = (f: Awaited<ReturnType<typeof fixture>>, send: PairedNotificationDriver["send"]): PairedNotificationDriver => ({
  inspect: async ({ target, scope }) => f.bind(target, scope), send,
});

test("automatic definite rejection retries only after backoff with the same frozen receiver and a retained attempt history", async () => {
  const f = await fixture(3);
  try {
    const workId = await f.work(), start = f.now(), replayFence = createNoticeReplayFence(start - 1);
    let calls = 0;
    const driver = driverFor(f, async () => ++calls === 1
      ? { state: "definitely-not-accepted", reason: "native_rejected" }
      : { state: "native-accepted" });
    const input = { durableRoot: f.root, workId, driver, now: f.now, replayFence, automaticRetry: true as const };
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "definitely-not-accepted" });
    expect(await f.store.notificationDelivery(workId, undefined, f.now())).toMatchObject({ retry: { state: "waiting", attempts: 1, notBeforeMs: start + 30000 } });
    expect(await f.store.nextAutomaticNotification(start - 1, f.now())).toBeNull();
    await runOpsNotificationDelivery(input); expect(calls).toBe(1);
    f.advance(30000);
    expect(await f.store.nextAutomaticNotification(start - 1, f.now())).toBe(workId);
    expect(await runOpsNotificationDelivery({ ...input, automaticRetry: undefined })).toMatchObject({ state: "already_attempted" });
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "native-accepted" });
    const status = await f.store.notificationDelivery(workId, undefined, f.now());
    expect(status).toMatchObject({ state: "completed", botReport: "not_observed", userRead: "not_observed",
      attemptHistory: [{ state: "definitely-not-accepted" }, { state: "native-accepted" }] });
    expect(calls).toBe(2);
    expect(await f.store.acceptedNotificationSeed(workId)).not.toBeNull();
  } finally { await f.close(); }
});

test("retry ceiling counts every reservation against the original installation and actual receiver budget", async () => {
  const f = await fixture(3);
  try {
    const workId = await f.work(); let calls = 0;
    const driver = driverFor(f, async () => { calls++; return { state: "definitely-not-accepted", reason: "native_rejected" }; });
    const input = { durableRoot: f.root, workId, driver, now: f.now, automaticRetry: true as const };
    await runOpsNotificationDelivery(input); f.advance(30000);
    await runOpsNotificationDelivery(input); f.advance(120000);
    await runOpsNotificationDelivery(input); f.advance(120000);
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "already_attempted" });
    expect(calls).toBe(3);
    expect(await f.store.notificationDelivery(workId, undefined, f.now())).toMatchObject({ retry: { state: "not_retryable", reason: "retry_limit", attempts: 3 } });
    expect(await f.store.notificationBudgetAvailable(f.selected(), f.now())).toBe(false);
  } finally { await f.close(); }
});

test("a rejected attempt does not permit a changed model or a restored older rejection to repeat an unknown HTTP effect", async () => {
  const f = await fixture();
  try {
    const workId = await f.work(), replayFence = createNoticeReplayFence(f.now() - 1); let calls = 0;
    const driver = driverFor(f, async () => ++calls === 1
      ? { state: "definitely-not-accepted", reason: "native_rejected" }
      : { state: "unknown", reason: "acknowledgement_lost" });
    const input = { durableRoot: f.root, workId, driver, now: f.now, replayFence, automaticRetry: true as const };
    await runOpsNotificationDelivery(input); f.advance(30000);
    const changed = { ...driver, inspect: async () => ({ ...f.bind(), modelRevision: "9".repeat(64) }) };
    expect(await runOpsNotificationDelivery({ ...input, driver: changed })).toMatchObject({ state: "blocked", reason: "retry_binding_changed" });
    expect(calls).toBe(1);
    const rejectedSnapshot = await readFile(f.store.path);
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "unknown" });
    await runOpsNotificationDelivery(input); expect(calls).toBe(2);
    // Only this isolated DB is rolled back; the live sender retains its newest
    // original attempt, so an older durable rejection cannot grant another POST.
    await writeFile(f.store.path, rejectedSnapshot, { mode: 0o600 });
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "unknown" });
    expect(calls).toBe(2);
  } finally { await f.close(); }
});

test("restoring an older rejection quarantines the later unknown dispatch and releases the queue for new work", async () => {
  const f = await fixture();
  try {
    const workId = await f.work(), floor = f.now() - 1, replayFence = createNoticeReplayFence(floor); let calls = 0;
    const driver = driverFor(f, async () => ++calls === 1
      ? { state: "definitely-not-accepted", reason: "native_rejected" }
      : { state: "unknown", reason: "acknowledgement_lost" });
    const input = { durableRoot: f.root, workId, driver, now: f.now, replayFence, automaticRetry: true as const };
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "definitely-not-accepted" });
    f.advance(30000); const rejected = await readFile(f.store.path);
    expect(await runOpsNotificationDelivery(input)).toMatchObject({ state: "unknown" });
    await writeFile(f.store.path, rejected, { mode: 0o600 });
    const restored = await f.store.notificationDelivery(workId, undefined, f.now());
    expect(restored.retry?.state).toBe("ready");
    expect(replayFence.priorAttempt(restored.occurrenceIdentity!, f.now(), { workId, attemptId: restored.attempt!.attemptId })).toBe("prior_lifetime_attempt");
    expect(await f.store.quarantineRestoredNotification(workId, restored.occurrenceIdentity!)).toEqual({ state: "quarantined" });
    expect(await f.store.notificationDelivery(workId, undefined, f.now())).toMatchObject({ state: "unknown",
      attemptHistory: [{ state: "definitely-not-accepted" }], retry: { state: "not_retryable", reason: "work_outcome_unknown" } });
    expect(await f.store.nextAutomaticNotification(floor, f.now())).toBeNull();
    f.advance(1); const next = await f.work();
    expect(await f.store.nextAutomaticNotification(floor, f.now())).toBe(next);
    const accepted = driverFor(f, async () => { calls++; return { state: "native-accepted" }; });
    expect(await runOpsNotificationDelivery({ ...input, workId: next, driver: accepted })).toMatchObject({ state: "native-accepted" });
    expect(calls).toBe(3);
  } finally { await f.close(); }
});

test("single delivery commits its fixed body and budget before network; DB and config locks are free during transport", async () => {
  const f = await fixture();
  try {
    const workId = await f.work(); let calls = 0;
    const driver = driverFor(f, async ({ binding, body, envelopeDigest }) => {
      calls++;
      const witness = await f.store.notificationDelivery(workId);
      expect(witness).toMatchObject({ state: "unknown", evidenceRevision: 1, attempt: { state: "attempting", targetAgentId: RECEIVER } });
      const lock = await acquireConfigurationLease(f.root); await lock.release();
      await f.store.maintain(f.now()); // A real write succeeds, proving network is outside the SQLite transaction.
      const payload = JSON.parse(body);
      expect(sha256Text(body)).toBe(envelopeDigest); expect(Buffer.byteLength(body)).toBeLessThanOrEqual(8192);
      expect(payload.notice).toMatchObject({ automaticDiagnosis: false, automaticIssue: false, behavior: "notify_then_end", replayAuthorized: false });
      expect(payload.target.agentId).toBe(binding.agentId);
      for (const sentinel of ["PRIVATE_PROMPT", "PRIVATE_KEY", "PRIVATE_CONTENT", f.root]) expect(body).not.toContain(sentinel);
      return { state: "native-accepted", receiptId: randomUUID(), extra: "PRIVATE_REPLY" };
    });
    const result = await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now });
    expect(result).toMatchObject({ state: "native-accepted", evidenceRevision: 1, userRead: "not_observed", botReport: "not_observed" });
    const before = await readFile(f.store.path);
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "already_attempted" });
    expect(calls).toBe(1); expect(await readFile(f.store.path)).toEqual(before);
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "completed", attempt: { state: "native-accepted" } });
    expect(JSON.stringify(await f.store.notificationDelivery(workId))).not.toContain("PRIVATE_REPLY");
  } finally { await f.close(); }
});

for (const phase of ["reserved", "attempting", "unknown"] as const) test(`expired ${phase} keeps its exact replay guard without indefinitely pinning incident evidence`, async () => {
  const f = await fixture();
  try {
    const workId = await f.work(), target = f.selected();
    const reservation = await f.store.reserveNotification({ workId, target, binding: f.bind(), nowMs: f.now() });
    expect(reservation.state).toBe("reserved");
    if (reservation.state !== "reserved") throw Error("fixture_not_reserved");
    const { frozen } = reservation;
    if (frozen.incidentId === null) throw Error("fixture_requires_incident_notification");
    if (phase !== "reserved") expect(await f.store.beginNotification({ workId, attemptId: frozen.attemptId,
      envelopeDigest: frozen.envelopeDigest, bindingDigest: frozen.bindingDigest, nowMs: f.now() })).toMatchObject({ dispatch: true });
    if (phase === "unknown") await f.store.settleNotification({ workId, attemptId: frozen.attemptId,
      nowMs: f.now(), result: { state: "unknown", reason: "transport_failure" } });
    await f.store.maintain(f.now());
    for (let day = 0; day < 29; day++) { f.advance(DAY); await f.store.maintain(f.now()); }
    expect(await f.store.incidentEvidence(frozen.incidentId, 1)).toMatchObject({ state: "expired", retention: { tier: "summary" } });
    for (let day = 0; day < 3; day++) { f.advance(DAY); await f.store.maintain(f.now()); }
    const reopened = openMonitorStore(f.root);
    expect(await reopened.incidentEvidence(frozen.incidentId, 1)).toMatchObject({ state: "expired", reason: "snapshot_revision_retired" });
    expect(await reopened.notificationDelivery(workId)).toMatchObject({ state: "unknown", attempt: { state: phase, attemptId: frozen.attemptId } });
    expect(await reopened.reserveNotification({ workId, target, binding: f.bind(), nowMs: f.now() })).toMatchObject({ state: "already_attempted" });
    expect(await reopened.beginNotification({ workId, attemptId: frozen.attemptId, envelopeDigest: frozen.envelopeDigest,
      bindingDigest: frozen.bindingDigest, nowMs: f.now() })).toMatchObject({ dispatch: false });
    const before = await readFile(reopened.path);
    await reopened.incidentEvidence(frozen.incidentId, 1); await reopened.notificationDelivery(workId);
    expect(await readFile(reopened.path)).toEqual(before);
  } finally { await f.close(); }
});

test("unpaired default has no sender, no attempt and no inferred live binding", async () => {
  const f = await fixture();
  try {
    const workId = await f.work(), before = await readFile(f.store.path);
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, now: f.now })).toMatchObject({ state: "unavailable", reason: "target_not_paired" });
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "ready", attempt: null, automaticRetry: false });
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ attempt: null }); expect(await readFile(f.store.path)).toEqual(before);
  } finally { await f.close(); }
});

test("off, unsupported routing and invalid config never invoke the pairing owner or consume a wake", async () => {
  for (const ops of [{ enabled: false }, { notifications: { mode: "off" } }, { routing: { enabled: true } }, { notifications: { digest: true } }]) {
    const f = await fixture(); try {
      const workId = await f.work(); await f.update(ops);
      let inspected = 0;
      const result = await runOpsNotificationDelivery({ durableRoot: f.root, workId, now: f.now, driver: {
        inspect: async () => { inspected++; return f.bind(); }, send: async () => { throw Error("must_not_send"); } } });
      expect(result.state).toBe("blocked"); expect(inspected).toBe(0); expect(await f.store.notificationDelivery(workId)).toMatchObject({ attempt: null });
    } finally { await f.close(); }
  }
});

test("parallel workers reserve only one attempt for the same work", async () => {
  const f = await fixture(); try {
    const workId = await f.work(); let sent = 0;
    const driver = driverFor(f, async () => { sent++; return { state: "native-accepted" }; });
    const results = await Promise.all(Array.from({ length: 12 }, () => runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })));
    expect(sent).toBe(1); expect(results.filter(r => r.state === "native-accepted")).toHaveLength(1);
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "completed" });
  } finally { await f.close(); }
});

for (const phase of [1, 2, 3]) test(`lost local commit acknowledgement at phase ${phase} never repeats native send`, async () => {
  const f = await fixture(); try {
    const workId = await f.work(); let writes = 0, sent = 0;
    const driver = driverFor(f, async () => { sent++; return { state: "native-accepted" }; });
    const storeOptions: MonitorStoreOptions = { afterRename: () => { if (++writes === phase) throw Error("PRIVATE_COMMIT_ERROR"); } };
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now, storeOptions })).toMatchObject({ state: "unknown" });
    expect(sent).toBe(phase === 3 ? 1 : 0);
    const status = await openMonitorStore(f.root).notificationDelivery(workId);
    expect(status).toMatchObject({ state: phase === 3 ? "completed" : "unknown" });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "already_attempted" });
    expect(sent).toBe(phase === 3 ? 1 : 0);
    expect(JSON.stringify(status)).not.toContain("PRIVATE_COMMIT_ERROR");
  } finally { await f.close(); }
});

test("timeout after possible acceptance survives expiry/reopen; terminal uncertainty cannot be reset to success", async () => {
  const f = await fixture(); try {
    const workId = await f.work(); let sends = 0;
    const driver = driverFor(f, async () => { sends++; throw Error("PRIVATE_URL_AND_KEY"); });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "unknown" });
    const status = await f.store.notificationDelivery(workId);
    expect(status).toMatchObject({ state: "unknown", attempt: { state: "unknown", result: { reason: "transport_failure" } } });
    for (let n = 0; n < 32; n++) { f.advance(DAY); await f.store.maintain(f.now()); }
    expect(await openMonitorStore(f.root).notificationDelivery(workId)).toMatchObject({ state: "unknown" });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "already_attempted" });
    expect(sends).toBe(1);
    if (!("attempt" in status) || !status.attempt) throw Error("missing_attempt");
    await expect(f.store.settleNotification({ workId, attemptId: status.attempt.attemptId, nowMs: f.now(), result: { state: "native-accepted" } })).rejects.toBeDefined();
  } finally { await f.close(); }
});

test("aliases of one real recipient share the same wake budget, and unknown attempts still count", async () => {
  const f = await fixture(1); try {
    let sends = 0; const driver = driverFor(f, async () => { sends++; return { state: "unknown", reason: "acknowledgement_lost" }; });
    const first = await f.work(); await runOpsNotificationDelivery({ durableRoot: f.root, workId: first, driver, now: f.now });
    await f.update({ notifications: { maxAutomaticWakeupsPerDay: 10 }, targets: { alias: { agentId: RECEIVER, routineKey: "ops-notice", maxAutomaticWakeupsPerDay: 1 } }, routing: { defaultTarget: "alias" } });
    const next = await f.work();
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId: next, driver, now: f.now })).toMatchObject({ state: "blocked", reason: "wake_budget" });
    expect(sends).toBe(1); expect(await f.store.notificationDelivery(next)).toMatchObject({ attempt: null });
  } finally { await f.close(); }
});

for (const change of ["model", "scope", "policy", "ack", "expired"] as const) test(`pre-send ${change} change blocks native invocation without deleting work or business state`, async () => {
  const f = await fixture(); try {
    const workId = await f.work(); let inspected = 0, sends = 0;
    const driver: PairedNotificationDriver = { inspect: async ({ target, scope }) => {
      inspected++; const binding = f.bind(target, scope);
      if (inspected === 2) {
        if (change === "model") binding.modelRevision = "0".repeat(64);
        if (change === "scope") binding.scopeId = "0".repeat(64);
        if (change === "policy") await f.update({ enabled: false });
        if (change === "expired") f.advance(16 * 60_000);
        if (change === "ack") {
          const work = await f.store.notificationDelivery(workId);
          if (!("incidentId" in work) || typeof work.incidentId !== "string") throw Error("missing_incident");
          await f.store.manage({ requestId: randomUUID(), incidentId: work.incidentId, expectedRevision: 1, action: "ack", nowMs: f.now() });
        }
      }
      return binding;
    }, send: async () => { sends++; return { state: "native-accepted" }; } };
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "definitely-not-accepted" });
    expect(sends).toBe(0);
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ attempt: { state: "definitely-not-accepted" } });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "already_attempted" });
  } finally { await f.close(); }
});

test("distinct concurrent incidents cannot both spend the last installation wake", async () => {
  const f = await fixture(1); try {
    const first = await f.work(), second = await f.work(); let sent = 0;
    const driver = driverFor(f, async () => { sent++; return { state: "native-accepted" }; });
    const results = await Promise.all([first, second].map(workId => runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })));
    expect(sent).toBe(1); expect(results.filter(r => r.state === "native-accepted")).toHaveLength(1);
    expect(results.some(r => r.state === "blocked" && "reason" in r && r.reason === "wake_budget")).toBe(true);
  } finally { await f.close(); }
});

test("a later evidence revision does not replace the notification's frozen incident revision", async () => {
  const f = await fixture(); try {
    const workId = await f.work(), status = await f.store.notificationDelivery(workId);
    if (!("incidentId" in status) || !status.incidentId) throw Error("fixture_incident_missing");
    const original = await f.store.incidentEvidence(status.incidentId, 1); let calls = 0;
    const driver: PairedNotificationDriver = { inspect: async ({ target, scope }) => {
      if (++calls === 2) {
        await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: "9".repeat(64), expectedCursor: null, nextCursor: "additional", atMs: f.now(),
          events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(f.now() + 1).toISOString(), mode: "route", hostGenerationId: "1".repeat(64),
            agentId: SUBJECT, stepId: "step-1", turnId: "turn-1", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }] });
        expect(await f.store.captureIncident(status.incidentId!, f.now())).toMatchObject({ revision: 2 });
      }
      return f.bind(target, scope);
    }, send: async ({ body }) => { expect(JSON.parse(body).notice.evidenceRevision).toBe(1); return { state: "native-accepted" }; } };
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "native-accepted", evidenceRevision: 1 });
    expect(await f.store.incidentEvidence(status.incidentId, 1)).toEqual(original);
  } finally { await f.close(); }
});

test("invalid current config is unavailable before reservation and cannot silently select defaults", async () => {
  const f = await fixture(); try {
    const workId = await f.work(), before = await readFile(f.store.path);
    await writeFile(f.configPath, "{PRIVATE_BROKEN", { mode: 0o600 }); let calls = 0;
    const driver = driverFor(f, async () => { calls++; return { state: "native-accepted" }; });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "unavailable", reason: "preflight_unavailable" });
    expect(calls).toBe(0); expect(await readFile(f.store.path)).toEqual(before);
  } finally { await f.close(); }
});

test("malformed native receipts become unknown without propagating arbitrary fields or free text", async () => {
  const f = await fixture(); try {
    const workId = await f.work(), driver = driverFor(f, async () => ({ state: "native-accepted", receiptId: "https://PRIVATE.invalid/key", body: "PRIVATE_PROMPT" }));
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "unknown" });
    const state = await f.store.notificationDelivery(workId);
    expect(state).toMatchObject({ attempt: { result: { state: "unknown", reason: "invalid_receipt" } } });
    expect(JSON.stringify(state)).not.toContain("PRIVATE");
  } finally { await f.close(); }
});

test("pure status against an absent store neither initializes it nor invents an empty healthy history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ops-absent-"));
  try {
    await expect(openMonitorStore(root).notificationWork()).rejects.toBeDefined();
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const phase of ["reserved", "attempting"] as const) test(`real writer death after ${phase} leaves a durable no-replay guard`, async () => {
  const f = await fixture(); let buildDir: string | undefined;
  try {
    const workId = await f.work();
    const source = fileURLToPath(new URL("./fixtures/notification-attempt-worker.ts", import.meta.url));
    const scratch = fileURLToPath(new URL("../../../.scratch/", import.meta.url));
    await mkdir(scratch, { recursive: true }); buildDir = await mkdtemp(join(scratch, "notification-crash-"));
    const worker = join(buildDir, "worker.mjs");
    // Qualify the published Node/native-SQLite path, not a second Bun runtime's
    // TypeScript loader. Keep the exact durable stage and hard-kill assertions.
    await build({ entryPoints: [source], outfile: worker, bundle: true, platform: "node", target: "node20", format: "esm",
      external: ["sqlite3"], logLevel: "silent", banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" } });
    const child = spawn("node", [worker, f.root, workId, phase], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let output = "", errors = "";
    child.stdout.on("data", value => output += value); child.stderr.on("data", value => errors += value);
    await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    expect(child.signalCode, errors).toBe("SIGKILL"); expect(JSON.parse(output)).toEqual({ phase, committed: true, runtime: "node" });
    let sent = 0; const driver = driverFor(f, async () => { sent++; return { state: "native-accepted" }; });
    expect(await runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now })).toMatchObject({ state: "already_attempted" });
    expect(sent).toBe(0); expect(await openMonitorStore(f.root).notificationDelivery(workId)).toMatchObject({ state: "unknown", attempt: { state: phase } });
  } finally { await f.close(); if (buildDir) await rm(buildDir, { recursive: true, force: true }); }
}, 15000);

test("retired source and packed Node ops queries cannot bypass the management service or change stored evidence", async () => {
  const f = await fixture(); try {
    const workId = await f.work(); await writeFile(f.configPath, "{BROKEN_PRIVATE_CONFIG", { mode: 0o600 });
    const before = await readFile(f.store.path);
    const result = await captureCli(["ops", "notifications", "show", workId, "--json"], { boxRuntimeRoot: f.root, configDir: f.root, env: {},
      fetch: (async () => { throw Error("must_not_contact_gateway"); }) as unknown as typeof fetch });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain("BROKEN_PRIVATE_CONFIG");
    const child = spawn("node", [packedCli, "ops", "notifications", "show", workId, "--json"], { cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit).not.toBe(0);
    expect(stdout + stderr).not.toContain("PRIVATE"); expect(await readFile(f.store.path)).toEqual(before);
  } finally { await f.close(); }
}, 15000);

test("a running transport settles before the enclosing delivery is interrupted; no detached late writer", async () => {
  const f = await fixture(); try {
    const workId = await f.work(), abort = new AbortController(); let entered!: () => void, release!: () => void;
    const began = new Promise<void>(r => entered = r), barrier = new Promise<void>(r => release = r);
    const driver = driverFor(f, async ({ signal }) => { entered(); await barrier; expect(signal.aborted).toBe(true); return { state: "unknown", reason: "acknowledgement_lost" }; });
    let finished = false;
    const task = runOpsNotificationDelivery({ durableRoot: f.root, workId, driver, now: f.now, signal: abort.signal }).catch(() => undefined).finally(() => { finished = true; });
    await began; abort.abort(); await new Promise(r => setTimeout(r, 20)); expect(finished).toBe(false);
    release(); await task;
    expect(await f.store.notificationDelivery(workId)).toMatchObject({ state: "unknown", attempt: { state: "unknown" } });
  } finally { await f.close(); }
});
