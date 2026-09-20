import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { validateNoticeAuthorization } from "@grokbox/runtime-kernel/observation";
import { receiverFixture, RECEIVER_MODEL as MODEL } from "../../../apps/web/test/receiver-fixture.ts";
const origin = "https://receiver-boundaries.example.test";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code);

test("receiver history at capacity refuses new consent without dropping old revocation or enable receipts", async () => {
  const f = await receiverFixture(origin);
  try {
    let revision = 1;
    const first = { receiverRef: f.ref, requestId: randomUUID(), expectedRevision: revision, action: "disable" as const, confirmed: true as const };
    const initial = (await f.client().changeReceiver(first)).data; revision = initial.appliedRevision;
    for (let i = 1; i < 64; i++) {
      const action = i % 2 ? { action: "enable" as const, expectedModelRevision: MODEL } : { action: "disable" as const };
      revision = (await f.client().changeReceiver({ receiverRef: f.ref, requestId: randomUUID(), expectedRevision: revision, confirmed: true, ...action })).data.appliedRevision;
    }
    assert.ok((await f.client().receiver(f.ref)).data.automatic);
    const revoked = (await f.client().changeReceiver({ ...first, requestId: randomUUID(), expectedRevision: revision })).data;
    revision = revoked.appliedRevision;
    const bytes = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    await rejects(f.client().changeReceiver({ ...first, action: "enable", expectedModelRevision: MODEL, requestId: randomUUID(), expectedRevision: revision }), "store_full");
    const reads = f.reads();
    assert.deepEqual((await f.client().changeReceiver(first)).data, initial);
    assert.deepEqual((await f.client().receiverOperation(f.databaseId, first.requestId)).data, initial);
    assert.equal(f.reads(), reads); assert.equal((await f.client().receiver(f.ref)).data.automatic, null);
    assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), bytes); assert.equal(f.requests.length, 0);
    const unbound = (await f.client().changeReceiver({ ...first, action: "unbind", requestId: randomUUID(), expectedRevision: revision })).data;
    assert.equal(unbound.appliedRevision, revision + 1); assert.equal((await f.client().receiver(f.ref)).data.credentialStored, false);
  } finally { await f.close(); }
});

test("test work capacity never drops unresolved records or repeats a completed test", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = { receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, action: "test" as const, expectedModelRevision: MODEL, confirmed: true as const };
    const first = (await f.client().testReceiver(input)).data;
    for (let i = 1; i < 128; i++) await f.store.createNotificationTest({ databaseId: f.databaseId, workId: randomUUID(), operationId: hash(`test-${i}`), requestDigest: hash(`input-${i}`),
      alias: "default", bindingId: f.pairing.bindingId, bindingRevision: 1, modelRevision: MODEL, nowMs: Date.now() });
    const bytes = await readFile(f.store.path);
    await rejects(f.client().testReceiver({ ...input, requestId: randomUUID() }), "store_full");
    assert.deepEqual((await f.client().testReceiver(input)).data, first); assert.equal(f.requests.length, 1);
    assert.deepEqual(await readFile(f.store.path), bytes);
  } finally { await f.close(); }
});

test("explicit schema-three migration refuses a live collector and preserves the original file", async () => {
  const f = await receiverFixture(origin);
  try {
    await f.server.close();
    const db = await openMonitorSqlite(f.store.path, "write");
    try { await db.run("DROP TABLE notification_tests; UPDATE meta SET version=3; PRAGMA user_version=3;"); } finally { await db.close(); }
    const before = await readFile(f.store.path);
    await assert.rejects(f.store.initialize(), /monitor_migration_requires_stop/);
    assert.equal((await f.store.snapshot()).schemaVersion, 3); assert.deepEqual(await readFile(f.store.path), before);
  } finally { await f.close(); }
});

test("Server shutdown during enable preflight cancels the source and cannot publish late permission", async () => {
  const f = await receiverFixture(origin); let entered = false, cancelled = false;
  try {
    f.native.readNotificationReceiver = (_agent, _routine, signal) => new Promise((_resolve, reject) => {
      entered = true;
      const abort = () => { cancelled = true; reject(Error("synthetic_cancelled_source")); };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    });
    const before = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    const pending = f.client().changeReceiver({ receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, action: "enable", expectedModelRevision: MODEL, confirmed: true }).catch(error => error);
    const deadline = Date.now() + 2000;
    while (!entered) { if (Date.now() > deadline) throw Error("preflight_not_entered"); await new Promise(resolve => setTimeout(resolve, 5)); }
    await f.server.close(); await pending;
    assert.equal(cancelled, true); assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), before);
    assert.equal((await f.owner.record("default"))!.automatic, undefined); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("old stored tested consent remains readable without silently becoming new consent or a new requirement", () => {
  const now = Date.now(), legacy = { version: 1, id: randomUUID(), operationId: "legacy-enable", requestDigest: "a".repeat(64), bindingRevision: 2,
    activatedAtMs: now, modelRevision: MODEL, qualificationRevision: "b".repeat(64), seedWorkId: randomUUID(), seedAttemptId: randomUUID(), seedEnvelopeDigest: "c".repeat(64),
    seedAcceptedAtMs: now - 1, receiverAttestation: "operator-confirmed-reminder", nativeTurnObserved: false, includesExistingWork: false };
  assert.deepEqual(validateNoticeAuthorization(legacy), legacy);
  assert.throws(() => validateNoticeAuthorization({ ...legacy, version: 2, consent: "explicit-enable" }));
  const current = { version: 2, id: randomUUID(), operationId: "explicit-enable", requestDigest: "d".repeat(64), bindingRevision: 2,
    activatedAtMs: now, modelRevision: MODEL, qualificationRevision: "b".repeat(64), consent: "explicit-enable", nativeTurnObserved: false, includesExistingWork: false };
  assert.deepEqual(validateNoticeAuthorization(current), current);
  assert.throws(() => validateNoticeAuthorization({ ...current, userRead: true }));
});
