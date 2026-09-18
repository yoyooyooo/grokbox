import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { continuityStorePolicy, type NativeCurrentHead } from "@grokbox/runtime-kernel/continuity";
import { openContinuityRecoveryStore, openContinuityCurrentState, createNativeCheckpointCapturePort } from "../src/runtime.ts";
import { captureNativeCheckpoint, verifyNativeCheckpointReadback, verifyNativeCheckpointMaterialReadback } from "../src/internal/host/native-checkpoint.ts";
import { CONT_NATIVE_PAIR, nativeContinuityCode, nativeContinuityEnabled } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
const bytes = (s: string) => new TextEncoder().encode(s);
const id = (s: string) => Uint8Array.from(Buffer.from(sha256Bytes(bytes(s)), "hex"));
const hex = (v: Uint8Array) => Buffer.from(v).toString("hex");
const policy = continuityStorePolicy();
const scope = "a".repeat(64), agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  const n = nativeContinuityCode(), blobs = new Map<string, Uint8Array>(), slot = bytes("owned-fixed-root-slot");
  const put = (label: string, data: Uint8Array) => { const key = id(label); blobs.set(hex(key), data); return key; };
  const live = put("live", bytes(JSON.stringify({ role: "user", content: "CURRENT_SENTINEL" })));
  const old = put("archived-message", bytes(JSON.stringify({ role: "assistant", content: "ARCHIVE_SENTINEL" })));
  const summary = put("summary", bytes(JSON.stringify({ role: "assistant", content: "SUMMARY_SENTINEL" })));
  const archive = put("archive", new n.ConversationSummaryArchive({ summarizedMessages: [old], summaryMessage: summary }).toBinary());
  const previous = put("previous-root", new n.ConversationStateStructure({ rootPromptMessagesJson: [old] }).toBinary());
  const user = put("user", new n.UserMessage({ text: "SYNTHETIC_USER", conversationStateBlobId: previous }).toBinary());
  const turn = put("turn", new n.ConversationTurnStructure({ turn: { case: "agentConversationTurn",
    value: new n.AgentConversationTurnStructure({ userMessage: user, requestId: "synthetic-request" }) } }).toBinary());
  const root = new n.ConversationStateStructure({ rootPromptMessagesJson: [live], turns: [turn], summaryArchives: [archive] });
  blobs.set(hex(slot), root.toBinary());
  const head = (): NativeCurrentHead => ({ agentId: agent, scopeId: scope, hostSourceSha: CONT_NATIVE_PAIR.host,
    nativeSchema: CONT_NATIVE_PAIR.schema, hostGeneration: "test-native-generation", contextRevision: "b".repeat(64),
    activationEpoch: "test-epoch", rootHash: sha256Bytes(blobs.get(hex(slot))!), state: "prepared", effects: "clear" });
  const schema = { root: n.ConversationStateStructure, referenceTypes: n.BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME,
    referenceMetadata: n.getBlobReferenceMessageMetadata, isMessage: n.isMessage };
  const reads: string[] = [];
  const readBlob = async (key: Uint8Array, maxBytes: number) => {
    reads.push(hex(key)); const value = blobs.get(hex(key));
    if (value && value.byteLength > maxBytes) throw Error("owned_byte_budget");
    return value;
  };
  const capture = (limits = policy) => captureNativeCheckpoint({ schema, reader: { rootId: slot, readBlob }, expected: head(), policy: limits, capturedAtMs: Date.now() });
  return { n, blobs, slot, live, old, summary, archive, previous, user, turn, root, put, reads, schema, readBlob, head, capture };
}

nativeTest("current official GC/export traversal omits archives and historical roots; recovery includes both", async () => {
  const f = fixture();
  const upstream = f.n.collectReachableBlobHexIds({ rootBytes: f.root.toBinary(), getBlobByHexId: (key: string) => f.blobs.get(key) });
  expect(upstream.blobTypeByHexId.has(hex(f.archive))).toBe(false);
  expect(upstream.blobTypeByHexId.has(hex(f.previous))).toBe(false);
  const material = await f.capture();
  const actual = new Set(material.manifest.parts.map(p => p.id));
  expect(actual).toEqual(new Set([...f.blobs.keys()].map(key => `n:${key}`)));
  expect(material.manifest.gaps).toEqual(["memory_partial", "missing_history"]);
  for (const data of f.blobs.values()) expect(material.content.get(sha256Bytes(data))).toEqual(data);
  expect(new Set(f.reads).size).toBe(f.reads.length);
}, 30000);

nativeTest("missing archive, opaque leaf or historical root refuses instead of becoming full recovery", async () => {
  for (const key of ["archive", "live", "previous"] as const) {
    const f = fixture(); f.blobs.delete(hex(f[key]));
    await expect(f.capture()).rejects.toThrow("material_invalid");
  }
});

nativeTest("invalid child protobuf and unknown root fields are not silently discarded", async () => {
  const f = fixture(); f.blobs.set(hex(f.archive), new Uint8Array([255]));
  await expect(f.capture()).rejects.toThrow("material_invalid");
  const other = fixture(); const root = other.root.toBinary();
  // Legal protobuf unknown field 100 (varint). Native decoder preserves it;
  // this reader refuses because its dependency semantics are not qualified.
  other.blobs.set(hex(other.slot), Uint8Array.from([...root, 0xa0, 0x06, 0x01]));
  await expect(other.capture()).rejects.toThrow("material_invalid");
});

nativeTest("native JSON leaf syntax is checked even when every referenced blob exists", async () => {
  const f = fixture(); f.blobs.set(hex(f.live), bytes("not-a-json-native-message"));
  await expect(f.capture()).rejects.toMatchObject({ code: "material_invalid", reason: "decode_failed" });
});

nativeTest("historical backreference cycle terminates without dropping archive bytes", async () => {
  const f = fixture();
  f.blobs.set(hex(f.user), new f.n.UserMessage({ conversationStateBlobId: f.slot }).toBinary());
  const material = await f.capture();
  expect(f.reads.filter(key => key === hex(f.slot))).toHaveLength(1);
  expect(material.manifest.parts.some(p => p.id === `n:${hex(f.archive)}`)).toBe(true);
});

nativeTest("references in inline maps and stored subagent states are included in the native graph", async () => {
  const f = fixture();
  const extra = f.put("nested-map-message", bytes(JSON.stringify({ role: "user", content: "NESTED_MAP_SENTINEL" })));
  const Subagent = f.n.BLOB_REFERENCE_MESSAGE_TYPE_BY_NAME["agent.v1.SubagentPersistedState"];
  const nested = new Subagent({ conversationState: new f.n.ConversationStateStructure({ rootPromptMessagesJson: [extra] }) });
  f.root.subagentStates = { "owned-inline": nested };
  f.root.subagentStateRefs = { "owned-stored": f.put("nested-state", nested.toBinary()) };
  f.blobs.set(hex(f.slot), f.root.toBinary());
  const material = await f.capture();
  expect(new Set(material.manifest.parts.map(p => p.id))).toEqual(new Set([...f.blobs.keys()].map(k => `n:${k}`)));
  expect(f.reads.filter(k => k === hex(extra))).toHaveLength(1);
  f.blobs.delete(hex(extra)); await expect(f.capture()).rejects.toThrow("material_invalid");
});

nativeTest("budgets reach the producer and no partial graph is published", async () => {
  const f = fixture();
  await expect(f.capture(continuityStorePolicy({ maxParts: 2 }))).rejects.toThrow("material_invalid");
  expect(f.reads).toHaveLength(1);
  const g = fixture();
  await expect(g.capture(continuityStorePolicy({ maxPartBytes: 8 }))).rejects.toThrow("material_invalid");
});

nativeTest("one blob cannot silently change reference type and pending tools stay unresolved", async () => {
  const f = fixture();
  f.root.summaryArchives = [f.live]; f.blobs.set(hex(f.slot), f.root.toBinary());
  await expect(f.capture()).rejects.toThrow("material_invalid");
  const g = fixture(); g.root.pendingToolCalls = ["pending-real-effect-unknown"]; g.blobs.set(hex(g.slot), g.root.toBinary());
  expect((await g.capture()).manifest.gaps).toContain("unknown_effects");
});

nativeTest("buffers are frozen before another native fetch mutates its reusable storage", async () => {
  const f = fixture(), original = Uint8Array.from(f.blobs.get(hex(f.slot))!); let count = 0;
  const material = await captureNativeCheckpoint({ schema: f.schema, expected: f.head(), policy, capturedAtMs: Date.now(),
    reader: { rootId: f.slot, readBlob: async (key, max) => {
      if (++count === 2) f.blobs.get(hex(f.slot))!.fill(0);
      return f.readBlob(key, max);
    } } });
  expect(material.content.get(sha256Bytes(original))).toEqual(original);
});

nativeTest("native payload survives production vault and reopening without access to source", async () => {
  const f = fixture(), material = await f.capture(), directory = await mkdtemp(join(tmpdir(), "cont-native-vault-"));
  const durableRoot = join(directory, "durable"); await mkdir(durableRoot, { mode: 0o700 });
  try {
    const store = openContinuityRecoveryStore({ durableRoot, scopeId: scope }); await store.initialize();
    const requestId = randomUUID(); await store.publish({ requestId, ...material }); f.blobs.clear();
    const reopened = openContinuityRecoveryStore({ durableRoot, scopeId: scope });
    const read = await reopened.readSnapshot(requestId);
    expect(read.manifest).toEqual(material.manifest);
    expect(read.content).toEqual(new Map(material.content));
    const rootPart = read.manifest.parts.find(p => p.id === read.manifest.root)!;
    expect(f.n.ConversationStateStructure.fromBinary(read.content.get(rootPart.hash)).summaryArchives).toHaveLength(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

nativeTest("concrete native decoder adapter feeds the production capture coordinator, and release precedes publication", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "cont-native-coordinator-"));
  const durableRoot = join(directory, "durable"); await mkdir(durableRoot, { mode: 0o700 });
  let acquired = 0, released = 0, publicationChecks = 0;
  try {
    const hooks = { beforeCommit: async (phase: string) => {
      if (phase === "reserve-publication" || phase === "publish-material") { expect(released).toBe(1); publicationChecks++; }
    } };
    const store = openContinuityRecoveryStore({ durableRoot, scopeId: scope }, hooks);
    await store.initialize();
    const port = createNativeCheckpointCapturePort({ qualification: { hostSourceSha: CONT_NATIVE_PAIR.host, nativeSchema: CONT_NATIVE_PAIR.schema },
      schema: f.schema, acquire: async () => { acquired++; return { reader: { rootId: f.slot, readBlob: f.readBlob },
        readHead: async () => f.head(), release: async () => { released++; } }; } });
    const current = openContinuityCurrentState({ durableRoot, scopeId: scope, native: port }, hooks);
    const request = { requestId: randomUUID(), expected: f.head() };
    expect(await current.capture(request)).toMatchObject({ state: "stored", sourceRead: true, nativeImportProven: false });
    expect(released).toBe(1); expect(publicationChecks).toBe(2);
    const captured = await store.readSnapshot(request.requestId);
    expect(captured.manifest.parts).toHaveLength(f.blobs.size);
    f.blobs.clear();
    expect(await current.capture(request)).toMatchObject({ state: "stored", sourceRead: false });
    expect(acquired).toBe(1);
    await expect(port.initialize({} as never)).rejects.toThrow("native_unavailable");
    await expect(port.observeApplication({} as never)).rejects.toThrow("native_unavailable");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

nativeTest("original AgentStore commits native protobuf and reopened memory matches durable bytes", async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "cont-native-writer-"));
  const rootFile = join(directory, "root.bin"), metaFile = join(directory, "metadata.json");
  await writeFile(metaFile, JSON.stringify({ root: "" }), { mode: 0o600 });
  let meta: { root: string } = { root: "" };
  const blobStore = { setBlob: async (_ctx: unknown, _id: Uint8Array, data: Uint8Array) => { await writeFile(rootFile, data, { mode: 0o600 }); },
    getBlob: async () => new Uint8Array(await readFile(rootFile)) };
  const metadata = { get: (key: string) => key === "latestRootBlobId" ? Uint8Array.from(Buffer.from(meta.root, "hex")) : agent,
    set: (_key: string, value: Uint8Array) => { meta.root = hex(value); } };
  try {
    const writer = new f.n.AgentStore(blobStore, metadata, { fixedRootBlobId: f.slot });
    await writer.handleCheckpoint({}, f.root); await writeFile(metaFile, JSON.stringify(meta), { mode: 0o600 });
    meta = JSON.parse(await readFile(metaFile, "utf8"));
    const reopened = new f.n.AgentStore(blobStore, metadata, { fixedRootBlobId: f.slot });
    const receipt = await verifyNativeCheckpointReadback({ store: reopened, ctx: {}, expectedRootHash: sha256Bytes(f.root.toBinary()),
      maxBytes: policy.maxPartBytes, readBlob: async (_id, max) => { const value = await blobStore.getBlob(); if (value.byteLength > max) throw Error("oversize"); return value; } });
    expect(receipt).toMatchObject({ nativeStateReadBack: true, activationAuthorized: false, applicationMarkerProven: false });
    expect(reopened.getConversationStateStructure().toBinary()).toEqual(f.root.toBinary());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

nativeTest("original AgentStore readback also verifies the full persisted native graph", async () => {
  const f = fixture(), material = await f.capture();
  const native = new f.n.AgentStore({ getBlob: (_c: unknown, key: Uint8Array) => f.readBlob(key, policy.maxPartBytes) },
    { get: () => f.slot, set: () => { throw Error("unexpected-readback-write"); } }, { fixedRootBlobId: f.slot });
  const request = { store: native, ctx: {}, expected: f.head(), material, policy, schema: f.schema,
    readBlob: f.readBlob, readHead: async () => f.head() };
  expect(await verifyNativeCheckpointMaterialReadback(request)).toMatchObject({ nativeClosureReadBack: true,
    verifiedParts: material.manifest.parts.length, modelWindowProven: false, activationAuthorized: false });
  // Native reset can still load this unchanged root, yet its archive is gone.
  f.blobs.delete(hex(f.archive)); await native.resetFromDb({});
  expect(native.getConversationStateStructure().toBinary()).toEqual(f.root.toBinary());
  await expect(verifyNativeCheckpointMaterialReadback(request)).rejects.toMatchObject({ code: "material_invalid", reason: "missing_reference" });
});

nativeTest("native reset silently returns empty on corruption, strict readback refuses it", async () => {
  const f = fixture(), corrupt = new Uint8Array([255]);
  const native = new f.n.AgentStore({ getBlob: async () => corrupt }, { get: () => f.slot, set: () => { throw Error("unexpected metadata write"); } });
  await native.resetFromDb({}); expect(native.getConversationStateStructure().toBinary()).toHaveLength(0);
  await expect(verifyNativeCheckpointReadback({ store: native, ctx: {}, expectedRootHash: sha256Bytes(corrupt),
    maxBytes: 32, readBlob: async () => corrupt })).rejects.toThrow("material_invalid");
});

nativeTest("original metadata failure can occur after root bytes changed; failure is not proof of no write", async () => {
  const f = fixture(); let durable: Uint8Array = new Uint8Array(), rejectMetadata = false;
  const native = new f.n.AgentStore({ setBlob: async (_c: unknown, _id: Uint8Array, data: Uint8Array) => { durable = Uint8Array.from(data); },
    getBlob: async () => durable }, { get: () => f.slot, set: () => { if (rejectMetadata) throw Error("owned-metadata-failed"); } }, { fixedRootBlobId: f.slot });
  await native.handleCheckpoint({}, f.root);
  const before = sha256Bytes(native.getConversationStateStructure().toBinary());
  const candidate = new f.n.ConversationStateStructure({ rootPromptMessagesJson: [f.old] }); rejectMetadata = true;
  await expect(native.handleCheckpoint({}, candidate)).rejects.toThrow("owned-metadata-failed");
  expect(sha256Bytes(durable)).toBe(sha256Bytes(candidate.toBinary()));
  expect(sha256Bytes(native.getConversationStateStructure().toBinary())).toBe(before);
  const proof = await verifyNativeCheckpointReadback({ store: native, ctx: {}, maxBytes: policy.maxPartBytes,
    expectedRootHash: sha256Bytes(candidate.toBinary()), readBlob: async () => durable });
  expect(proof.applicationMarkerProven).toBe(false);
  expect(sha256Bytes(native.getConversationStateStructure().toBinary())).toBe(sha256Bytes(durable));
});

nativeTest("same original fixed root slot contains different committed revisions", async () => {
  const f = fixture(); let current: Uint8Array = new Uint8Array(), pointer: Uint8Array = new Uint8Array();
  const native = new f.n.AgentStore({ setBlob: async (_c: unknown, _i: Uint8Array, data: Uint8Array) => { current = data; } },
    { get: () => pointer, set: (_key: string, value: Uint8Array) => { pointer = value; } }, { fixedRootBlobId: f.slot });
  await native.handleCheckpoint({}, f.root); const first = sha256Bytes(current), key = hex(pointer);
  await native.handleCheckpoint({}, new f.n.ConversationStateStructure({ rootPromptMessagesJson: [f.old] }));
  expect(hex(pointer)).toBe(key); expect(sha256Bytes(current)).not.toBe(first);
});
