import { expect, test } from "bun:test";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy, type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { captureNativeCheckpoint, createNativeCheckpointCapturePort, verifyNativeCheckpointReadback, verifyNativeCheckpointMaterialReadback,
  type NativeCheckpointSchema } from "../src/internal/host/native-checkpoint.ts";

// Public reflection fixture. Native wire/serde behavior is tested separately,
// opt-in, against the exact installed source pair; this is not that evidence.
const text = (s: string) => new TextEncoder().encode(s);
const rootId = text("root"), leafId = text("leaf"), rootBytes = text("ROOT"), leafBytes = text('{"role":"user","content":"LEAF"}');
const head = (): NativeCurrentHead => ({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scopeId: "b".repeat(64),
  hostSourceSha: "c".repeat(64), nativeSchema: "owned-reflection-v1", hostGeneration: "owned", contextRevision: "d".repeat(64),
  activationEpoch: "one", rootHash: sha256Bytes(rootBytes), state: "prepared", effects: "clear" });
function fixture() {
  const info = { typeName: "agent.v1.ConversationStateStructure", fields: { list: () => [{ localName: "messages", kind: "scalar", repeated: true }] },
    runtime: { bin: { listUnknownFields: () => [] as unknown[] } } };
  const message = { messages: [leafId], getType: () => info, toBinary: () => Uint8Array.from(rootBytes) };
  const schema: NativeCheckpointSchema = { root: { fromBinary: () => message }, referenceTypes: {},
    referenceMetadata: () => ({ fields: [{ protoFieldName: "messages", localFieldName: "messages", blobReferenceType: "json" }] }),
    isMessage: value => value === message };
  let reads = 0;
  const reader = { rootId, readBlob: async (id: Uint8Array, max: number) => {
    reads++; const value = Buffer.from(id).equals(rootId) ? rootBytes : Buffer.from(id).equals(leafId) ? leafBytes : undefined;
    if (value && value.byteLength > max) throw Error("producer_budget"); return value;
  } };
  const capture = () => captureNativeCheckpoint({ schema, reader, expected: head(), policy: continuityStorePolicy(), capturedAtMs: 1 });
  return { info, message, schema, reader, capture, reads: () => reads };
}

test("capture records exact closure bytes and explicitly lacks Memory/display-history proof", async () => {
  const f = fixture(), result = await f.capture();
  expect(result.content.get(sha256Bytes(rootBytes))).toEqual(rootBytes);
  expect(result.content.get(sha256Bytes(leafBytes))).toEqual(leafBytes);
  expect(result.manifest.gaps).toEqual(["memory_partial", "missing_history"]);
  expect(result.manifest.source.transcriptThrough).toBeNull(); expect(f.reads()).toBe(2);
});

test("root hash drift refuses before any referenced data is read", async () => {
  const f = fixture();
  await expect(captureNativeCheckpoint({ schema: f.schema, reader: f.reader, expected: { ...head(), rootHash: "0".repeat(64) },
    policy: continuityStorePolicy(), capturedAtMs: 1 })).rejects.toThrow("source_changed");
  expect(f.reads()).toBe(1);
});

test("unknown protobuf fields, absent required blobs and unknown reference types are explicit failures", async () => {
  const f = fixture(); f.info.runtime.bin.listUnknownFields = () => ["unknown"];
  await expect(f.capture()).rejects.toMatchObject({ code: "material_invalid", reason: "unsupported_wire_fields" });
  const g = fixture(); g.reader.readBlob = async id => Buffer.from(id).equals(rootId) ? rootBytes : undefined;
  await expect(g.capture()).rejects.toMatchObject({ code: "material_invalid", reason: "missing_reference" });
  const h = fixture(); h.schema.referenceMetadata = () => ({ fields: [{ protoFieldName: "messages", localFieldName: "messages", blobReferenceType: "unsupported.NativeType" }] });
  await expect(h.capture()).rejects.toThrow("material_invalid");
});

test("opaque JSON and string leaves must have valid encoding/syntax, without leaking their contents", async () => {
  for (const [type, body] of [["json", text('{"private":"unterminated')], ["json", new Uint8Array([0xff])], ["string", new Uint8Array([0xc0, 0xaf])]] as const) {
    const f = fixture();
    f.schema.referenceMetadata = () => ({ fields: [{ protoFieldName: "messages", localFieldName: "messages", blobReferenceType: type }] });
    f.reader.readBlob = async id => Buffer.from(id).equals(rootId) ? rootBytes : body;
    await expect(f.capture()).rejects.toMatchObject({ code: "material_invalid", reason: "decode_failed", message: "continuity_current_material_invalid" });
  }
  const f = fixture();
  f.schema.referenceMetadata = () => ({ fields: [{ protoFieldName: "messages", localFieldName: "messages", blobReferenceType: "bytes" }] });
  f.reader.readBlob = async id => Buffer.from(id).equals(rootId) ? rootBytes : new Uint8Array([0xff]);
  expect((await f.capture()).manifest.parts).toHaveLength(2);
});

test("source reader budget applies to all blobs and over-limit replies are refused", async () => {
  const f = fixture(); const limits: number[] = [];
  const read = f.reader.readBlob; f.reader.readBlob = async (id, limit) => { limits.push(limit); return read(id, limit); };
  await f.capture(); expect(limits).toHaveLength(2); expect(limits.every(n => n <= continuityStorePolicy().maxPartBytes)).toBe(true);
  const g = fixture(); g.reader.readBlob = async (_id, limit) => new Uint8Array(limit + 1);
  await expect(g.capture()).rejects.toThrow("material_invalid");
});

test("bad reference metadata and too many native fields fail without producing a partial material", async () => {
  const f = fixture(); f.schema.referenceMetadata = () => ({ fields: [{ protoFieldName: "absent", localFieldName: "absent", blobReferenceType: "json" }] });
  await expect(f.capture()).rejects.toThrow("material_invalid");
  const g = fixture(); g.info.fields.list = () => Array.from({ length: 257 }, () => ({ localName: "messages", kind: "scalar", repeated: true }));
  await expect(g.capture()).rejects.toThrow("material_invalid");
  const h = fixture(); h.schema.referenceMetadata = () => undefined;
  await expect(h.capture()).rejects.toMatchObject({ code: "material_invalid", reason: "unsupported_reference_type" });
  expect(h.reads()).toBe(1);
});

test("capture-only binding has no initialization or application-receipt fallback", async () => {
  const f = fixture(); let opens = 0, closes = 0;
  const port = createNativeCheckpointCapturePort({ qualification: { hostSourceSha: head().hostSourceSha, nativeSchema: head().nativeSchema },
    schema: f.schema, acquire: async () => { opens++; return { reader: f.reader, readHead: async () => head(), release: async () => { closes++; } }; } });
  await expect(port.initialize({} as never)).rejects.toThrow("native_unavailable");
  await expect(port.observeApplication({} as never)).rejects.toThrow("native_unavailable"); expect(opens).toBe(0);
  await expect(port.capture({ ...head(), hostSourceSha: "0".repeat(64) })).rejects.toThrow("qualification_mismatch");
  expect(opens).toBe(0);
  const lease = await port.capture(head()); await lease.readMaterial(continuityStorePolicy());
  await lease.release(); expect(closes).toBe(1);
  await expect(lease.readHead()).rejects.toThrow("cancelled");
  await expect(lease.release()).rejects.toThrow("cleanup_unknown"); expect(closes).toBe(1);
});

test("capture binding detects revision drift and never releases a scope before caller settlement", async () => {
  const f = fixture(); let reads = 0, released = false;
  const port = createNativeCheckpointCapturePort({ qualification: { hostSourceSha: head().hostSourceSha, nativeSchema: head().nativeSchema }, schema: f.schema,
    acquire: async () => ({ reader: f.reader, readHead: async () => ++reads > 1 ? { ...head(), contextRevision: "e".repeat(64) } : head(),
      release: async () => { released = true; } }) });
  const lease = await port.capture(head());
  await expect(lease.readMaterial(continuityStorePolicy())).rejects.toThrow("source_changed");
  expect(released).toBe(false); await lease.release(); expect(released).toBe(true);
});

test("readback checks both disk and loaded state; none of it is activation permission", async () => {
  const f = fixture(); let resets = 0;
  const store = { getMetadata: () => rootId, getConversationStateStructure: () => f.message,
    resetFromDb: async () => { resets++; } };
  expect(await verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: f.reader.readBlob })).toMatchObject({ nativeStateReadBack: true, activationAuthorized: false, applicationMarkerProven: false });
  expect(resets).toBe(1);
  store.getConversationStateStructure = () => ({ ...f.message, toBinary: () => new Uint8Array() });
  await expect(verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: f.reader.readBlob })).rejects.toThrow("material_invalid");
});

test("closure readback validates persisted references, not only a matching root", async () => {
  const f = fixture(), material = await f.capture();
  const store = { getMetadata: () => rootId, getConversationStateStructure: () => f.message, resetFromDb: async () => {} };
  const request = { store, ctx: {}, expected: head(), material, policy: continuityStorePolicy(), schema: f.schema,
    readBlob: f.reader.readBlob, readHead: async () => head() };
  expect(await verifyNativeCheckpointMaterialReadback(request)).toMatchObject({ nativeClosureReadBack: true, verifiedParts: 2,
    applicationMarkerProven: false, memoryAndDisplayHistoryProven: false, modelWindowProven: false, activationAuthorized: false });
  await expect(verifyNativeCheckpointMaterialReadback({ ...request, readBlob: async id => Buffer.from(id).equals(rootId) ? rootBytes : text('{"changed":true}') })).rejects.toThrow("material_invalid");
  await expect(verifyNativeCheckpointMaterialReadback({ ...request, readBlob: async id => Buffer.from(id).equals(rootId) ? rootBytes : undefined })).rejects.toThrow("material_invalid");
  let reads = 0;
  await expect(verifyNativeCheckpointMaterialReadback({ ...request, readHead: async () => ++reads === 1 ? head() : { ...head(), activationEpoch: "later" } })).rejects.toThrow("source_changed");
});

test("readback freezes loaded bytes before another native fetch reuses the buffer", async () => {
  const f = fixture(); const loaded = Uint8Array.from(rootBytes); let reads = 0;
  const store = { getMetadata: () => rootId, getConversationStateStructure: () => ({ ...f.message, toBinary: () => loaded }), resetFromDb: async () => {} };
  const result = await verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: async () => { if (++reads === 2) loaded.fill(0); return rootBytes; } });
  expect(result.nativeStateReadBack).toBe(true); expect(loaded.every(b => b === 0)).toBe(true);
});

test("native readback refuses a missing root, pointer drift and a changing durable payload", async () => {
  const f = fixture(); let pointer = rootId;
  const store = { getMetadata: () => pointer, getConversationStateStructure: () => f.message, resetFromDb: async () => { pointer = leafId; } };
  await expect(verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: f.reader.readBlob })).rejects.toThrow("material_invalid");
  pointer = new Uint8Array();
  await expect(verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: f.reader.readBlob })).rejects.toThrow("material_invalid");
  pointer = rootId; store.resetFromDb = async () => {}; let reads = 0;
  await expect(verifyNativeCheckpointReadback({ store, ctx: {}, expectedRootHash: sha256Bytes(rootBytes), maxBytes: 100,
    readBlob: async () => ++reads === 1 ? rootBytes : leafBytes })).rejects.toThrow("material_invalid");
});
