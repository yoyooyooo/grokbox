import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy, recoveryRevision, type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { createNativeCheckpointWorker, createNativeCheckpointWorkerDispatcher, type NativeCheckpointWorkerStore } from "../src/internal/host/native-checkpoint-worker.ts";
import type { NativeCheckpointSchema } from "../src/internal/host/native-checkpoint.ts";

const bytes = (s: string) => new TextEncoder().encode(s), hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const rootId = bytes("slot"), childId = bytes("leaf");
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const qualification = { hostSourceSha: "d".repeat(64), nativeSchema: "owned-worker-v1" };
const head = (agentId: string, hash: string | null): NativeCurrentHead => ({ ...qualification, agentId, scopeId: "e".repeat(64),
  contextRevision: "f".repeat(64), activationEpoch: "owned-epoch", hostGeneration: "owned-generation", rootHash: hash,
  state: hash === null ? "empty" : "prepared", effects: "clear" });
function fixture(agentId = sourceId) {
  const db = new Database(":memory:"); db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB NOT NULL)");
  let reads = 0, writes = 0, failAfterWrite = false;
  const store: NativeCheckpointWorkerStore = { db: { exec: sql => db.exec(sql), prepare: sql => db.query(sql) as never }, isClosed: false,
    blobLengthStmt: db.query("SELECT length(data) AS len FROM blobs WHERE id=?") as never,
    getBlob: id => { reads++; return (db.query("SELECT data FROM blobs WHERE id=?").get(hex(id)) as any)?.data; },
    setBlob: (id, data) => { writes++; db.query("INSERT INTO blobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(hex(id), data);
      if (failAfterWrite) throw Error("owned-set-failed"); } };
  const schema: NativeCheckpointSchema = { isMessage: () => true, root: { fromBinary: raw => ({
    messages: [childId], pendingToolCalls: [], toBinary: () => raw, getType: () => ({ typeName: "agent.v1.ConversationStateStructure",
      fields: { list: () => [{ localName: "messages", kind: "scalar", repeated: true }] }, runtime: { bin: { listUnknownFields: () => [] } } }),
  }) }, referenceTypes: {}, referenceMetadata: () => ({ fields: [{ localFieldName: "messages", protoFieldName: "messages", blobReferenceType: "json" }] }) };
  const input = { store, schema, agentId, qualification }, operations = createNativeCheckpointWorker(input);
  return { db, store, schema, input, operations, reads: () => reads, writes: () => writes,
    failWrites: () => { failAfterWrite = true; }, close: () => db.close(),
    seed: (label: string) => { store.setBlob(rootId, bytes(label)); store.setBlob(childId, bytes('{"role":"user","content":"SENTINEL"}')); } };
}
async function snapshot() {
  const f = fixture();
  try { f.seed("root"); return await f.operations.capture({ expected: head(sourceId, sha256Bytes(bytes("root"))), rootId,
    limits: continuityStorePolicy(), capturedAtMs: 1 }); } finally { f.close(); }
}
function attempt(material: Awaited<ReturnType<typeof snapshot>>, expected = head(targetId, null)) {
  return { operationId: randomUUID(), effectId: randomUUID(), expected, policyRevision: "b".repeat(64),
    snapshot: { owner: "continuity.recovery", ref: randomUUID(), revision: recoveryRevision(material.manifest) } };
}

test("native worker capture reads a real transaction without creating receipt schema; bounded read precedes allocation", async () => {
  const f = fixture();
  try {
    f.seed("root"); const before = f.writes();
    const material = await f.operations.capture({ expected: head(sourceId, sha256Bytes(bytes("root"))), rootId, limits: continuityStorePolicy(), capturedAtMs: 1 });
    expect(material.manifest.parts).toHaveLength(2); expect(f.writes()).toBe(before);
    expect(f.db.query("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'grokbox_%'").get()).toMatchObject({ n: 0 });
    const reads = f.reads();
    await expect(f.operations.capture({ expected: head(sourceId, sha256Bytes(bytes("root"))), rootId,
      limits: continuityStorePolicy({ maxPartBytes: 1 }), capturedAtMs: 1 })).rejects.toThrow("material_invalid");
    expect(f.reads()).toBe(reads);
  } finally { f.close(); }
});

test("worker atomically installs native graph plus exact receipt, without claiming a full Bot initialization", async () => {
  const material = await snapshot(), f = fixture(targetId), a = attempt(material);
  try {
    const applied = await f.operations.apply({ attempt: a, rootId, material });
    expect(applied).toMatchObject({ state: "worker_committed", duplicate: false, nativeApplicationComplete: false });
    if (applied.state !== "worker_committed") throw Error("wrong-worker-state");
    expect(f.store.getBlob(rootId)).toEqual(bytes("root"));
    expect(await f.operations.observe({ attempt: a })).toMatchObject({ state: "worker_committed", marker: applied.marker, nativeApplicationComplete: false });
    const count = f.writes();
    expect(await f.operations.apply({ attempt: a, rootId, material })).toMatchObject({ duplicate: true }); expect(f.writes()).toBe(count);
    f.store.setBlob(rootId, bytes("B2"));
    expect(await f.operations.apply({ attempt: a, rootId, material })).toMatchObject({ duplicate: true });
    expect(f.store.getBlob(rootId)).toEqual(bytes("B2"));
  } finally { f.close(); }
});

test("failed native content write rolls back both graph and marker; no receipt is fabricated", async () => {
  const material = await snapshot(), f = fixture(targetId), a = attempt(material);
  try {
    f.failWrites(); await expect(f.operations.apply({ attempt: a, rootId, material })).rejects.toThrow("commit_unknown");
    expect(f.db.query("SELECT count(*) n FROM blobs").get()).toMatchObject({ n: 0 });
    expect(await f.operations.observe({ attempt: a })).toMatchObject({ state: "absent", nativeApplicationComplete: false });
  } finally { f.close(); }
});

test("changed root, conflicting leaf and reused operation with different identity never overwrite target", async () => {
  const material = await snapshot(), f = fixture(targetId);
  try {
    f.seed("B2"); const writes = f.writes();
    await expect(f.operations.apply({ attempt: attempt(material), rootId, material })).rejects.toThrow("source_changed");
    expect(f.writes()).toBe(writes);
    f.store.setBlob(childId, bytes('{"other":"history"}'));
    await expect(f.operations.apply({ attempt: attempt(material, head(targetId, sha256Bytes(bytes("B2")))), rootId, material })).rejects.toThrow("operation_conflict");
    expect(f.store.getBlob(rootId)).toEqual(bytes("B2"));
  } finally { f.close(); }
  const g = fixture(targetId), a = attempt(material);
  try {
    await g.operations.apply({ attempt: a, rootId, material }); const writes = g.writes();
    await expect(g.operations.apply({ attempt: { ...a, effectId: randomUUID() }, rootId, material })).rejects.toThrow("operation_conflict");
    expect(g.writes()).toBe(writes);
  } finally { g.close(); }
});

test("ordinary worker requests cannot interleave with async capture transaction", async () => {
  const f = fixture();
  try {
    f.seed("root"); const replies: any[] = [], order: string[] = [];
    const dispatch = createNativeCheckpointWorkerDispatcher(f.input, req => {
      order.push("ordinary"); f.store.setBlob(rootId, bytes("later")); replies.push({ requestId: req.requestId });
    }, response => { order.push("capture"); replies.push(response); });
    dispatch({ kind: "grokbox-current-state", version: 1, requestId: 1, action: "capture",
      payload: { expected: head(sourceId, sha256Bytes(bytes("root"))), rootId, limits: continuityStorePolicy(), capturedAtMs: 1 } });
    dispatch({ kind: "set-blob", requestId: 2 });
    for (let i = 0; i < 30 && replies.length < 2; i++) await Promise.resolve();
    expect(order).toEqual(["capture", "ordinary"]);
    expect(replies[0].result.content.get(sha256Bytes(bytes("root")))).toEqual(bytes("root"));
    expect(f.store.getBlob(rootId)).toEqual(bytes("later"));
  } finally { f.close(); }
});

test("activation refuses a changed dependency even when the committed root still matches", async () => {
  const material = await snapshot(), f = fixture(targetId), a = attempt(material);
  try {
    await f.operations.apply({ attempt: a, rootId, material });
    f.store.setBlob(childId, bytes('{"role":"user","content":"CORRUPTED_AFTER_READBACK"}'));
    await expect(f.operations.release({ attempt: a, rootId })).rejects.toThrow("material_invalid");
    expect(f.operations.permitsOrdinary("collect-garbage")).toBe(false);
    expect(f.store.getBlob(rootId)).toEqual(bytes("root"));
    const original = material.manifest.parts.find(part => part.id === `n:${hex(childId)}`)!;
    f.store.setBlob(childId, material.content.get(original.hash)!);
    expect(await f.operations.release({ attempt: a, rootId })).toMatchObject({ state: "worker_released", started: false });
    expect(f.operations.permitsOrdinary("collect-garbage")).toBe(true);
  } finally { f.close(); }
});

test("worker failure is bounded and does not return private DB errors or input", async () => {
  const f = fixture(); const responses: any[] = [];
  try {
    const dispatch = createNativeCheckpointWorkerDispatcher(f.input, () => { throw Error("SECRET_NATIVE_ERROR"); }, r => { responses.push(r); });
    dispatch({ kind: "unknown", requestId: 1 });
    dispatch({ kind: "grokbox-current-state", version: 1, requestId: 2, action: "eval", payload: "PRIVATE_BODY" });
    for (let i = 0; i < 10 && responses.length < 2; i++) await Promise.resolve();
    expect(responses).toHaveLength(2); expect(JSON.stringify(responses)).not.toContain("SECRET"); expect(JSON.stringify(responses)).not.toContain("PRIVATE");
  } finally { f.close(); }
});
