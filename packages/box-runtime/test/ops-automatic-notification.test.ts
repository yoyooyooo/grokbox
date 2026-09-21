import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activateOpsNotifications } from "../src/internal/roots/ops-activation.runtime.ts";
import { automaticNoticeCycle, runAutomaticOpsNotification, startOpsNotificationWorker } from "../src/internal/roots/ops-automatic-notification.runtime.ts";
import { projectNoticeWorker, validateNoticeAuthorization, type NoticeAuthorization } from "@grokbox/runtime-kernel/observation";
import { automaticFixture, MODEL, tick } from "./fixtures/automatic-notice.ts";

async function until<T>(read: () => T | Promise<T>, ready: (v: T) => boolean) {
  const end = performance.now() + 5000;
  do { const value = await read(); if (ready(value)) return value; await tick(5); } while (performance.now() < end);
  throw Error("owned_notification_timeout");
}
const active = async (f: Awaited<ReturnType<typeof automaticFixture>>) => (await f.owner.record("default"))!.automatic!;

test("prepared is not authorized; idle worker does not read native state, reserve or initialize anything", async () => {
  const f = await automaticFixture();
  try {
    const work = await f.emit(), before = await readFile(f.store.path), capsule = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "blocked", reason: "automatic_not_authorized" });
    expect(f.reads()).toBe(0); expect(f.requests).toHaveLength(0);
    expect(await f.store.notificationDelivery(work)).toMatchObject({ attempt: null });
    expect(await readFile(f.store.path)).toEqual(before); expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(capsule);
  } finally { await f.close(); }
});

test("HTTP acceptance never grants ongoing permission; enabling requires explicit consent, not a test attestation", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); expect(seed.result.state).toBe("native-accepted");
    const before = await readFile(join(f.root, "state/ops-pairing/bindings.json")), reads = f.reads();
    await expect(activateOpsNotifications({ ...f.input, command: { ...f.command(), confirmed: false } })).rejects.toThrow("automatic_confirmation_required");
    await expect(activateOpsNotifications({ ...f.input, command: { ...f.command(), reminderObserved: true } as never })).rejects.toThrow("invalid_automatic_authorization");
    expect(f.reads()).toBe(reads); expect(f.requests).toHaveLength(1);
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(before);
    expect(await active(f)).toBeUndefined();
  } finally { await f.close(); }
});

test("activation is atomic, redacted and idempotent without renewing the future-work fence", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(), result = await f.activate(seed.workId), authorization = await active(f);
    expect(result).toMatchObject({ state: "authorized", duplicate: false, nativeTurnObserved: false, notificationSent: false, serviceStarted: false,
      userRead: "not_observed", testRequired: false, automaticAuthorization: { testRequired: false, includesExistingWork: false } });
    expect(authorization.bindingRevision).toBe(f.pairing.revision + 1); expect(f.requests).toHaveLength(1);
    const bytes = await readFile(join(f.root, "state/ops-pairing/bindings.json")), reads = f.reads();
    expect(await f.activate(seed.workId)).toMatchObject({ duplicate: true, automaticAuthorization: result.automaticAuthorization });
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(bytes); expect(f.reads()).toBe(reads);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TEST_KEY"); expect(JSON.stringify(await f.owner.status())).not.toContain("PRIVATE_TEST_KEY");
    await expect(activateOpsNotifications({ ...f.input, command: { ...f.command(seed.workId), operationId: "different" } })).rejects.toThrow("authorization_conflict");
  } finally { await f.close(); }
});

for (const prior of ["none", "unknown"] as const) test(`enable is independent of ${prior} prior delivery evidence and performs no send`, async () => {
  const f = await automaticFixture();
  try {
    if (prior === "unknown") { f.reply(res => { res.writeHead(500); res.end("PRIVATE_ERROR"); }); await f.seed(); }
    const requests = f.requests.length;
    const enabled = await activateOpsNotifications({ ...f.input, command: f.command() });
    expect(enabled).toMatchObject({ state: "authorized", notificationSent: false, testRequired: false, userRead: "not_observed" });
    expect(await active(f)).toMatchObject({ version: 2, consent: "explicit-enable" });
    expect(f.requests).toHaveLength(requests);
    if (prior === "none") expect(await f.store.incidents()).toEqual([]);
  } finally { await f.close(); }
});

test("removing the test prerequisite does not weaken the reviewed model and exact binding checks", async () => {
  const f = await automaticFixture();
  try {
    await expect(activateOpsNotifications({ ...f.input, command: { ...f.command(), expectedModelRevision: "a".repeat(64) } })).rejects.toBeDefined();
    expect(await active(f)).toBeUndefined(); expect(f.requests).toHaveLength(0);
    await expect(activateOpsNotifications({ ...f.input, command: { ...f.command(), expectedBindingRevision: 99 } })).rejects.toThrow("binding_revision_changed");
  } finally { await f.close(); }
});

test("concurrent activation of one operation publishes one stable authorization and performs no extra POST", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed();
    const results = await Promise.allSettled([f.activate(seed.workId), f.activate(seed.workId)]);
    const saved = await active(f);
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "fulfilled") expect(result.value.automaticAuthorization.authorizationId).toBe(saved.id);
      else expect(result.reason).toMatchObject({ reason: "activation_busy" });
    }
    expect(saved.bindingRevision).toBe(f.pairing.revision + 1);
    expect(f.requests).toHaveLength(1);
    const before = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    expect(await f.activate(seed.workId)).toMatchObject({ duplicate: true });
    expect(await readFile(join(f.root, "state/ops-pairing/bindings.json"))).toEqual(before);
  } finally { await f.close(); }
});

test("revocation during activation preflight cannot be overwritten by a late permission", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed();
    const readNative: typeof f.readNative = async () => {
      const snapshot = await f.readNative(), prior = (await f.owner.record("default"))!;
      await f.owner.revoke("default", prior.revision, "unbind", true);
      return snapshot;
    };
    await expect(activateOpsNotifications({ ...f.input, readNative, command: f.command(seed.workId) })).rejects.toBeDefined();
    expect((await f.owner.record("default"))!.state).toBe("unbound"); expect(await active(f)).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test("authorization excludes old backlog; future work uses the same durable single-attempt HTTP path", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(), backlog = await f.emit(); await f.activate(seed.workId);
    const authorization = await active(f);
    expect(await runAutomaticOpsNotification({ ...f.input, workId: backlog, authorization }, { request: f.request })).toMatchObject({ state: "blocked", reason: "work_precedes_authorization" });
    const next = await f.emit();
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "processed", workId: next, outcome: "native-accepted" });
    const reads = f.reads(); expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "idle", reason: "no_fresh_work" });
    expect(f.reads()).toBe(reads); expect(f.requests).toHaveLength(2); expect(JSON.parse(f.requests[1]!).workId).toBe(next);
    expect(await f.store.notificationDelivery(backlog)).toMatchObject({ attempt: null });
    expect(await f.store.notificationDelivery(next)).toMatchObject({ attempt: { state: "native-accepted" }, userRead: "not_observed" });
    expect(f.requests[1]).not.toContain("PRIVATE");
  } finally { await f.close(); }
});

test("the running worker picks up a future work and sends it without another caller command", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 5 });
    await until(worker.status, s => s.cycles > 0); const next = await f.emit();
    await until(() => f.store.notificationDelivery(next), s => "attempt" in s && s.attempt?.state === "native-accepted");
    expect(f.requests).toHaveLength(2); expect(JSON.parse(f.requests[1]!).workId).toBe(next);
    await worker.close(); worker = undefined; await f.emit(); await tick(20); expect(f.requests).toHaveLength(2);
  } finally { await worker?.close(); await f.close(); }
});

test("shutdown aborts and settles a real in-flight HTTP request before the worker reports stopped", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    const seed = await f.seed(); await f.activate(seed.workId); f.reply(() => {});
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 5 });
    await until(worker.status, state => state.cycles > 0);
    const work = await f.emit();
    await until(() => f.requests.length, n => n === 2); await worker.close();
    expect(worker.status().state).toBe("stopped"); expect(await f.store.notificationDelivery(work)).toMatchObject({ state: "unknown", attempt: { state: "unknown" } });
    await tick(20); expect(f.requests).toHaveLength(2);
  } finally { await worker?.close(); await f.close(); }
});

test("concurrent workers may inspect but only one can spend and POST the same work", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId); const next = await f.emit();
    await Promise.all([automaticNoticeCycle(f.input, { request: f.request }), automaticNoticeCycle(f.input, { request: f.request })]);
    expect(f.requests.filter(body => JSON.parse(body).workId === next)).toHaveLength(1);
    expect(await f.store.notificationDelivery(next)).toMatchObject({ attempt: { state: "native-accepted" } });
  } finally { await f.close(); }
});

test("unknown automatic HTTP result is preserved across worker reopening without another POST", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId); const next = await f.emit();
    f.reply(res => { res.writeHead(500); res.end("PRIVATE_REPLY"); });
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "processed", outcome: "unknown" });
    const worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 5 });
    try { await until(worker.status, s => s.cycles >= 3); } finally { await worker.close(); }
    expect(f.requests.filter(body => JSON.parse(body).workId === next)).toHaveLength(1);
    expect(await f.store.notificationDelivery(next)).toMatchObject({ state: "unknown", attempt: { state: "unknown" } });
    expect(worker.status().state).toBe("stopped");
  } finally { await f.close(); }
});

for (const phase of [1, 2] as const) test(`revoke during preflight ${phase} fences the pending send and removes the authorization`, async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId); const workId = await f.emit(); let calls = 0;
    const readNative: typeof f.readNative = async () => {
      const result = await f.readNative();
      if (++calls === phase) { const record = (await f.owner.record("default"))!; await f.owner.revoke("default", record.revision, "disable", true); }
      return result;
    };
    await automaticNoticeCycle({ ...f.input, readNative }, { request: f.request });
    expect(f.requests).toHaveLength(1); expect(await active(f)).toBeUndefined();
    const state = await f.store.notificationDelivery(workId);
    expect(state).toMatchObject(phase === 1 ? { attempt: null } : { attempt: { state: "definitely-not-accepted" } });
  } finally { await f.close(); }
});

for (const change of ["model", "generation", "source", "ownership"] as const) test(`${change} drift blocks future work without silently re-authorizing`, async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId); const workId = await f.emit(), authorization = await active(f);
    f.mutateNative(v => {
      if (change === "model" && v.model) v.model.modelRevision = "a".repeat(64);
      if (change === "source" && v.model) v.model.loadedSourceRevision = "a".repeat(64);
      if (change === "generation") { v.ownershipGeneration = "a".repeat(64); v.snapshot.generation = "a".repeat(64); }
      if (change === "ownership") v.ownership = null;
    });
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "blocked" });
    expect(f.requests).toHaveLength(1); expect(await f.store.notificationDelivery(workId)).toMatchObject({ attempt: null }); expect(await active(f)).toEqual(authorization);
  } finally { await f.close(); }
});

test("off and exhausted wake budgets are checked before native RPCs, not after spending a model wake", async () => {
  const f = await automaticFixture(1);
  try {
    const seed = await f.seed(); await f.activate(seed.workId); await f.emit(); const reads = f.reads();
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "blocked", reason: "wake_budget" });
    expect(f.reads()).toBe(reads);
    await writeFile(f.configPath, JSON.stringify({ ...f.document, ops: { ...f.document.ops, enabled: false } }), { mode: 0o600 });
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ reason: "notifications_off" });
    expect(f.reads()).toBe(reads); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

test("structured shutdown waits for a cycle to settle and never overlaps or leaves a late writer", async () => {
  let enter!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => enter = resolve), release = new Promise<void>(resolve => finish = resolve);
  let calls = 0, finished = false, stopped = false;
  const worker = startOpsNotificationWorker({ durableRoot: "/unreached-owned-test", readNative: async () => { throw Error("not_called"); } }, {
    idleMs: 1, blockedMs: 1, cycle: async signal => { calls++; enter(); await release; expect(signal.aborted).toBe(true); finished = true;
      return { state: "blocked", reason: "stopping" }; },
  });
  await started; const close = worker.close().then(() => { stopped = true; });
  await tick(20); expect(stopped).toBe(false); expect(finished).toBe(false); finish(); await close;
  expect(calls).toBe(1); expect(finished).toBe(true); expect(worker.status().state).toBe("stopped"); await tick(10); expect(calls).toBe(1);
});

test("blocked cycles back off without overlapping and the first idle cycle resets the delay", async () => {
  let count = 0, idleStarted!: () => void, finishIdle!: () => void;
  const reachedIdle = new Promise<void>(resolve => idleStarted = resolve), idleBarrier = new Promise<void>(resolve => finishIdle = resolve);
  const worker = startOpsNotificationWorker({ durableRoot: "/unreached-owned-test", readNative: async () => { throw Error("not_called"); } }, {
    idleMs: 100, blockedMs: 5, cycle: async () => {
      if (++count <= 3) return { state: "blocked", reason: "automatic_not_authorized" };
      idleStarted(); await idleBarrier; return { state: "idle", reason: "no_fresh_work" };
    },
  });
  try {
    await reachedIdle;
    expect(worker.status()).toMatchObject({ cycles: 3, nextDelayMs: 20 });
    finishIdle(); await until(worker.status, value => value.cycles === 4);
    expect(worker.status()).toMatchObject({ state: "waiting", nextDelayMs: 100 });
  } finally { finishIdle(); await worker.close(); }
  expect(count).toBe(4); expect(worker.status().state).toBe("stopped");
});

test("safe worker projection drops unknown fields, refuses fake delivery and never exports errors", async () => {
  const worker = startOpsNotificationWorker({ durableRoot: "/unreached-owned-test", readNative: async () => { throw Error("not_called"); } }, {
    idleMs: 5, blockedMs: 5, cycle: async () => ({ state: "unavailable", reason: "local_or_native_source_unavailable" }),
  });
  try {
    await until(worker.status, s => s.cycles > 0); const state = worker.status();
    expect(projectNoticeWorker({ ...state, credential: "PRIVATE" })).toEqual(state);
    expect(() => projectNoticeWorker({ ...state, userRead: "confirmed" })).toThrow();
    expect(() => projectNoticeWorker({ ...state, lastCycle: { state: "unavailable", reason: "PRIVATE_EXCEPTION" } })).toThrow();
  } finally { await worker.close(); }
});

test("a preserved tested-consent capsule cannot drive a current automatic delivery or be silently renewed", async () => {
  const f = await automaticFixture();
  try {
    await f.activate();
    const path = join(f.root, "state/ops-pairing/bindings.json"), capsule = JSON.parse(await readFile(path, "utf8"));
    const slot = capsule.slots[0], { consent: _, ...grant } = slot.automatic;
    slot.automatic = { ...grant, version: 1, seedWorkId: randomUUID(), seedAttemptId: randomUUID(), seedEnvelopeDigest: "c".repeat(64),
      seedAcceptedAtMs: grant.activatedAtMs - 1, receiverAttestation: "operator-confirmed-reminder" };
    const bytes = JSON.stringify(capsule); await writeFile(path, bytes, { mode: 0o600 });
    const work = await f.emit(), before = await readFile(f.store.path), reads = f.reads();
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "unavailable", reason: "local_or_native_source_unavailable" });
    await expect(f.activate()).rejects.toBeDefined();
    expect(f.reads()).toBe(reads); expect(f.requests).toHaveLength(0);
    expect(await f.store.notificationDelivery(work)).toMatchObject({ attempt: null });
    expect(await readFile(f.store.path)).toEqual(before); expect(await readFile(path, "utf8")).toBe(bytes);
  } finally { await f.close(); }
});

test("authorization cannot contain arbitrary data or turn an operator statement into native proof", () => {
  const sample: NoticeAuthorization = { version: 2, consent: "explicit-enable", id: randomUUID(), operationId: "test", requestDigest: "a".repeat(64), bindingRevision: 2,
    activatedAtMs: Date.now(), modelRevision: MODEL, qualificationRevision: "b".repeat(64), nativeTurnObserved: false, includesExistingWork: false };
  expect(validateNoticeAuthorization(sample)).toEqual(sample);
  for (const patch of [{ nativeTurnObserved: true }, { includesExistingWork: true }, { secret: "PRIVATE" }, { version: 1 }, { consent: "legacy-tested-consent" }])
    expect(() => validateNoticeAuthorization({ ...sample, ...patch })).toThrow();
});
