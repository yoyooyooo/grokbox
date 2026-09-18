import { expect, test } from "bun:test";
import { createNativeCurrentStateRpc } from "../src/internal/host/native-current-state-rpc.ts";
import { createCurrentStateClient } from "../src/internal/io/current-state-client.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { initializationDigest, continuityStorePolicy } from "@grokbox/runtime-kernel/continuity";
import { openContinuityCurrentState, openContinuityRecoveryStore } from "../src/runtime.ts";
import { createNativeCurrentStateOwner, NATIVE_CURRENT_STATE_KEY } from "../src/internal/host/native-current-state-owner.ts";
import { createNativeCheckpointWorker, type NativeCheckpointWorkerStore } from "../src/internal/host/native-checkpoint-worker.ts";
import type { NativeCheckpointSchema } from "../src/internal/host/native-checkpoint.ts";

const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const scopeId = "e".repeat(64), policyRevision = "b".repeat(64), qualification = { hostSourceSha: "d".repeat(64), nativeSchema: "owned-worker-v1" };
const bytes = (s: string) => new TextEncoder().encode(s), rootId = bytes("slot"), childId = bytes("leaf"), hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function fixture(agentId: string, populated: boolean) {
  const db = new Database(":memory:"); db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)");
  let writes = 0, casFailure = false, opened = true;
  const workerStore: NativeCheckpointWorkerStore = { db: { exec: sql => db.exec(sql), prepare: sql => db.query(sql) as never }, isClosed: false,
    blobLengthStmt: db.query("SELECT length(data) len FROM blobs WHERE id=?") as never,
    getBlob: id => (db.query("SELECT data FROM blobs WHERE id=?").get(hex(id)) as any)?.data,
    setBlob: (id, data) => { writes++; db.query("INSERT INTO blobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(hex(id), data); } };
  const message = (raw: Uint8Array) => ({ messages: raw.byteLength ? [childId] : [], pendingToolCalls: [], toBinary: () => Uint8Array.from(raw),
    getType: () => ({ typeName: "agent.v1.ConversationStateStructure", fields: { list: () => [{ localName: "messages", kind: "scalar", repeated: true }] },
      runtime: { bin: { listUnknownFields: () => [] } } }) });
  const schema: NativeCheckpointSchema = { root: { fromBinary: message }, isMessage: () => true, referenceTypes: {},
    referenceMetadata: () => ({ fields: [{ localFieldName: "messages", protoFieldName: "messages", blobReferenceType: "json" }] }) };
  const worker = createNativeCheckpointWorker({ store: workerStore, schema, qualification, agentId });
  const readKv = (key: string): string | null => (db.query("SELECT value FROM kv WHERE key=?").get(key) as any)?.value ?? null;
  const writeKv = (key: string, value: string) => { db.query("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); return true; };
  const metadata = { readKv, writeKv,
    getTranscriptTail: (_query: { limit: number }) => ({ entries: readKv("owned-history") ? [{}] : [] }),
    getPendingAutomationCompletions: () => readKv("owned-completion") ? [{}] : [],
    compareAndSetLatestRootBlobId: (v: { expectedRoot: Uint8Array; nextRoot: Uint8Array }) => {
    if (casFailure || (readKv("root") ?? "") !== hex(v.expectedRoot)) return false;
    writeKv("root", hex(v.nextRoot)); return true;
  } };
  let loaded = message(new Uint8Array());
  if (populated) {
    workerStore.setBlob(rootId, bytes("ROOT")); workerStore.setBlob(childId, bytes('{"role":"user","content":"CURRENT_SENTINEL"}'));
    writeKv("root", hex(rootId)); loaded = message(bytes("ROOT"));
  }
  writeKv("memory", "TARGET_MEMORY_UNCHANGED");
  const store = { getMetadata: () => Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")), getConversationStateStructure: () => loaded,
    resetFromDb: async (_ctx?: unknown) => { const pointer = Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")); loaded = message(pointer.length ? workerStore.getBlob(pointer) ?? new Uint8Array() : new Uint8Array()); },
    getBlobStore: () => ({ grokboxCurrentState: async (action: "capture" | "prepare" | "apply" | "observe" | "release", value: unknown) => worker[action](value) }) };
  const owner = createNativeCurrentStateOwner({ qualification, generation: "owned-generation" });
  const registration = { store, metadata, ctx: {}, rootId, source: qualification, valid: () => opened };
  owner.register(agentId, registration);
  return { owner, store, worker, workerStore, metadata, registration, reads: () => writes, failCas: () => { casFailure = true; },
    head: () => owner.readHead(agentId, scopeId), close: () => { opened = false; db.close(); } };
}
async function setup() {
  const base = await mkdtemp(join(tmpdir(), "native-owner-test-")), durableRoot = join(base, "durable");
  await mkdir(durableRoot, { mode: 0o700 });
  const source = fixture(sourceId, true), target = fixture(targetId, false);
  const store = openContinuityRecoveryStore({ durableRoot, scopeId }); await store.initialize();
  const sourceProgram = openContinuityCurrentState({ durableRoot, scopeId, native: source.owner.port });
  const requestId = randomUUID(); await sourceProgram.capture({ requestId, expected: source.head() });
  const snapshot = (await store.readSnapshot(requestId)).reference;
  const request = { operationId: randomUUID(), effectId: randomUUID(), snapshot, expected: target.head(), policyRevision };
  const program = openContinuityCurrentState({ durableRoot, scopeId, native: target.owner.port,
    authorizeInitialization: async () => ({ allowed: true, operationId: request.operationId, agentId: targetId, scopeId, policyRevision,
      ownership: "confirmed_box", observedAtMs: Date.now(), hostGeneration: "owned-generation" }) });
  return { source, target, store, program, request, durableRoot,
    close: async () => { source.close(); target.close(); await rm(base, { recursive: true, force: true }); } };
}

test("concrete native metadata/blob owner completes the production coordinator and keeps both native fences prepared", async () => {
  const f = await setup();
  try {
    expect(await f.program.initialize(f.request)).toMatchObject({ state: "prepared", current: "verified_prepared", activated: false, humanMessageSent: false });
    expect(f.target.store.getConversationStateStructure().toBinary()).toEqual(bytes("ROOT"));
    expect(f.target.metadata.readKv("memory")).toBe("TARGET_MEMORY_UNCHANGED");
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(false);
    expect(() => f.target.owner.enter(targetId)).toThrow("not_prepared");
    const applied = await f.target.owner.port.observeApplication({ ...f.request, inputDigest: initializationDigest(f.request) });
    expect(applied.state).toBe("applied");
  } finally { await f.close(); }
});

test("explicit release opens only subsequent work, B2 is never overwritten by initialization re-entry", async () => {
  const f = await setup();
  try {
    await f.program.initialize(f.request);
    expect(await f.target.owner.activate(f.target.head(), { ...f.request, inputDigest: initializationDigest(f.request) })).toMatchObject({ state: "released", started: false });
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(true);
    const end = f.target.owner.enter(targetId);
    await f.target.owner.checkpoint(targetId, async () => { f.target.workerStore.setBlob(rootId, bytes("B2")); await f.target.store.resetFromDb({}); });
    end();
    expect(await f.program.initialize(f.request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(f.target.store.getConversationStateStructure().toBinary()).toEqual(bytes("B2"));
  } finally { await f.close(); }
});

test("worker commit followed by metadata failure leaves durable blocked state and cannot be replayed", async () => {
  const f = await setup();
  try {
    f.target.failCas(); await expect(f.program.initialize(f.request)).rejects.toThrow("commit_unknown");
    expect(JSON.parse(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)!)).toMatchObject({ hold: "blocked" });
    expect(f.target.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
    expect(f.target.store.getConversationStateStructure().toBinary()).toHaveLength(0);
    expect(await f.program.reconcile(f.request)).toMatchObject({ state: "unknown", activated: false });
    const fresh = createNativeCurrentStateOwner({ qualification, generation: "new-process" }); fresh.register(targetId, f.target.registration);
    expect(() => fresh.enter(targetId)).toThrow("not_prepared");
    expect(fresh.deferMaintenance(f.target.metadata)).toBe(true);
  } finally { await f.close(); }
});

test("current running or already populated target cannot be used as a virgin initializer", async () => {
  const f = await setup();
  try {
    const done = f.target.owner.enter(targetId);
    await expect(f.program.initialize(f.request)).rejects.toThrow(); done();
    expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
    const material = await f.store.readSnapshot(f.request.snapshot.ref);
    const populated = fixture(targetId, true);
    try {
      const bad = { ...f.request, expected: populated.head(), inputDigest: initializationDigest({ ...f.request, expected: populated.head() }) };
      await expect(populated.owner.port.initialize(bad)).rejects.toThrow("not_prepared");
    } finally { populated.close(); }
    expect(material.manifest.parts).toHaveLength(2);
  } finally { await f.close(); }
});

for (const key of ["owned-history", "owned-completion", "latestRequestId", "requestIds", "lastTurnSettlement", "awaitingUserResponse"]) {
  test(`rootless target with ${key} is not a virgin Bot`, async () => {
    const f = await setup();
    try {
      f.target.metadata.writeKv(key, "existing-record");
      await expect(f.program.initialize(f.request)).rejects.toThrow("not_prepared");
      expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
      expect(f.target.metadata.readKv(key)).toBe("existing-record");
      expect(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)).toBeNull();
    } finally { await f.close(); }
  });
}

test("a completion arriving after preview prevents initialization dispatch", async () => {
  const f = await setup();
  try {
    const attempt = { ...f.request, inputDigest: initializationDigest(f.request) };
    const lease = await f.target.owner.port.initialize(attempt);
    try {
      const candidate = await lease.prepare(await f.store.readSnapshot(f.request.snapshot.ref), attempt);
      f.target.metadata.writeKv("owned-completion", "late-result");
      await expect(lease.commit(attempt, candidate)).rejects.toThrow("not_prepared");
      expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
    } finally { await lease.release("blocked"); }
  } finally { await f.close(); }
});

test("a native result arriving while the worker commits prevents main-root publication", async () => {
  const f = await setup();
  try {
    const apply = f.target.worker.apply;
    f.target.worker.apply = async payload => {
      const result = await apply(payload);
      f.target.metadata.writeKv("owned-completion", "arrived-during-worker-commit");
      return result;
    };
    await expect(f.program.initialize(f.request)).rejects.toThrow("commit_unknown");
    expect(f.target.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
    expect(f.target.store.getMetadata()).toHaveLength(0);
    expect(f.target.metadata.readKv("owned-completion")).toBe("arrived-during-worker-commit");
    expect(JSON.parse(f.target.metadata.readKv(NATIVE_CURRENT_STATE_KEY)!)).toMatchObject({ hold: "blocked" });
    expect(f.target.worker.permitsOrdinary("collect-garbage")).toBe(false);
    expect(await f.program.reconcile(f.request)).toMatchObject({ state: "unknown", activated: false });
  } finally { await f.close(); }
});

test("stale native store and malformed persistent fence fail closed without mutating live content", async () => {
  const f = fixture(sourceId, true);
  try {
    expect(() => f.owner.assertCheckpoint(sourceId, { ...f.store })).toThrow("not_prepared");
    f.metadata.writeKv(NATIVE_CURRENT_STATE_KEY, "not-json");
    expect(f.owner.deferMaintenance(f.metadata)).toBe(true);
    expect(() => f.head()).toThrow("commit_unknown");
    expect(() => f.owner.enter(sourceId)).toThrow("commit_unknown");
    expect(f.workerStore.getBlob(rootId)).toEqual(bytes("ROOT"));
  } finally { f.close(); }
});

test("an unfinished native checkpoint holds its boundary until the entire write settles", async () => {
  const f = await setup(); let release!: () => void;
  try {
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writing = f.target.owner.checkpoint(targetId, () => barrier, f.target.store);
    await expect(f.target.owner.port.initialize({ ...f.request, inputDigest: initializationDigest(f.request) })).rejects.toThrow("not_prepared");
    expect(() => f.target.owner.register(targetId, f.target.registration)).toThrow("not_prepared");
    release(); await writing;
    // A checkpoint with no root is still evidence this is not an untouched Bot.
    const later = { ...f.request, expected: f.target.head() };
    await expect(f.target.owner.port.initialize({ ...later, inputDigest: initializationDigest(later) })).rejects.toThrow("not_prepared");
  } finally { release?.(); await f.close(); }
});

test("a started Bot with no checkpoint is not a virgin target after a controller restart", async () => {
  const f = await setup();
  try {
    f.target.owner.enter(targetId)();
    const fresh = createNativeCurrentStateOwner({ qualification, generation: "next-generation" });
    fresh.register(targetId, f.target.registration);
    const request = { ...f.request, expected: fresh.readHead(targetId, scopeId) };
    await expect(fresh.port.initialize({ ...request, inputDigest: initializationDigest(request) })).rejects.toThrow("not_prepared");
    expect(f.target.workerStore.getBlob(rootId)).toBeUndefined();
  } finally { await f.close(); }
});

test("typed RPC and client run the real coordinator through prepare, initialize, reconcile and release", async () => {
  const f = await setup();
  try {
    let harness: "box" | "temporal" = "box"; let reads = 0;
    const rpc = createNativeCurrentStateRpc(f.target.owner, "c".repeat(64));
    const client = createCurrentStateClient({ qualification, call: request => rpc(request, async () => {
      reads++; return { grokboxOwnership: ownedOwnershipSnapshot([targetId], { scopeId, nowMs: Date.now(), serverHarness: harness, localHarness: harness }) };
    }) });
    const first = await client.head(targetId);
    const request = { ...f.request, expected: first.head, policyRevision: first.policyRevision };
    const program = openContinuityCurrentState({ durableRoot: f.durableRoot, scopeId, native: client.port,
      authorizeInitialization: async () => ({ allowed: true, operationId: request.operationId, agentId: targetId, scopeId,
        policyRevision: request.policyRevision, ownership: "confirmed_box", observedAtMs: Date.now(), hostGeneration: "owned-generation" }) });
    expect(await program.initialize(request)).toMatchObject({ state: "prepared", activated: false });
    const saved = await f.store.initializationRequest(request.operationId); expect(saved).toEqual(request);
    const attempt = { ...request, inputDigest: initializationDigest(request) };
    harness = "temporal";
    await expect(client.activate(attempt, (await client.head(targetId)).head)).rejects.toThrow("ownership_unconfirmed");
    expect(() => f.target.owner.enter(targetId)).toThrow("not_prepared");
    harness = "box";
    expect(await client.activate(attempt, (await client.head(targetId)).head)).toMatchObject({ state: "released", started: false });
    expect(await client.activate(attempt, (await client.head(targetId)).head)).toMatchObject({ alreadyReleased: true, started: false });
    expect(await program.reconcile(request)).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(reads).toBeGreaterThan(5);
  } finally { await f.close(); }
});
