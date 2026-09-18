import { canonicalJson, sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure, copyNativeMaterial, nativeCurrentHead, assertCapturedHead, assertNativeBinding,
  nativeQualification, sameCurrentHead, continuityStorePolicy,
  type NativeCurrentHead, type NativeMaterial, type ContinuityStorePolicy, type NativeQualification, type NativeCurrentStatePort } from "@grokbox/runtime-kernel/continuity";

// Native objects come from a qualified in-scope binding, never a private-path
// import. No eval, IO, repair, upload or model call. The caller MUST hold its
// native read/checkpoint boundary; two matching reads are not a writer lock.
type ProtoField = { localName: string; kind: string; repeated?: boolean; oneof?: { localName: string }; V?: { kind: string } };
type ProtoMessage = Record<string, unknown> & { getType: () => {
  typeName: string; fields: { list: () => ProtoField[] };
  runtime: { bin: { listUnknownFields: (message: ProtoMessage) => unknown[] } };
}; toBinary: () => Uint8Array };
type ProtoType = { fromBinary: (bytes: Uint8Array) => ProtoMessage };
type ReferenceField = { protoFieldName: string; localFieldName: string; blobReferenceType: string };
export type NativeCheckpointSchema = {
  root: ProtoType; referenceTypes: Readonly<Record<string, ProtoType>>;
  referenceMetadata: (typeName: string) => { fields: ReferenceField[] } | undefined;
  isMessage: (value: unknown) => boolean;
};
export type NativeCheckpointRead = {
  rootId: Uint8Array;
  // Producer enforces maxBytes BEFORE allocating. Consumer verifies actual size.
  readBlob: (id: Uint8Array, maxBytes: number) => Promise<Uint8Array | undefined>;
};
export type NativeCheckpointFailureReason = "malformed_native_data" | "missing_reference" | "unsupported_wire_fields"
  | "unsupported_reference_type" | "reference_type_conflict" | "limit_exceeded" | "decode_failed" | "native_read_failed";
export class NativeCheckpointFailure extends CurrentStateFailure {
  constructor(readonly reason: NativeCheckpointFailureReason) { super("material_invalid"); }
}
const fail = (reason: NativeCheckpointFailureReason = "malformed_native_data"): never => { throw new NativeCheckpointFailure(reason); };
const hex = (id: Uint8Array) => {
  if (!(id instanceof Uint8Array) || id.byteLength < 1 || id.byteLength > 32) return fail();
  return Buffer.from(id).toString("hex");
};
const values = (v: unknown): unknown[] => Array.isArray(v) ? v : v != null && typeof v === "object" && !(v instanceof Uint8Array) ? Object.values(v) : [v];
const MAX_INLINE_NODES = 8192, MAX_REFERENCE_EDGES = 4096;
export type NativeCheckpointBoundary = {
  reader: NativeCheckpointRead;
  readHead: () => Promise<NativeCurrentHead>;
  release: () => Promise<void>;
};

/** Concrete capture-only adapter for CONT-07. Acquisition must come from a
 * separately qualified original Host/worker read boundary. No default binding,
 * writer, application marker or activation is manufactured by this factory. */
export function createNativeCheckpointCapturePort(input: { qualification: NativeQualification; schema: NativeCheckpointSchema;
  acquire: (expected: NativeCurrentHead) => Promise<NativeCheckpointBoundary> }): NativeCurrentStatePort {
  const qualification = nativeQualification(input.qualification), schema = input.schema, acquire = input.acquire;
  const unavailable = async (): Promise<never> => { throw new CurrentStateFailure("native_unavailable"); };
  return { qualification, initialize: unavailable, observeApplication: unavailable,
    capture: async raw => {
      const expected = nativeCurrentHead(raw); assertNativeBinding(expected, expected, qualification);
      const boundary = await acquire(expected); let closed = false;
      const readHead = async () => {
        if (closed) throw new CurrentStateFailure("cancelled");
        const head = nativeCurrentHead(await boundary.readHead()); assertNativeBinding(head, expected, qualification);
        if (!sameCurrentHead(head, expected)) throw new CurrentStateFailure("source_changed");
        return head;
      };
      return { readHead, readMaterial: async limits => {
        const head = await readHead();
        const policy = continuityStorePolicy({ maxParts: limits.maxParts, maxPartBytes: limits.maxPartBytes, maxSnapshotBytes: limits.maxSnapshotBytes });
        const material = await captureNativeCheckpoint({ schema, reader: boundary.reader, expected: head, policy, capturedAtMs: Date.now() });
        await readHead(); return material;
      }, release: async () => { if (closed) throw new CurrentStateFailure("cleanup_unknown"); closed = true; await boundary.release(); } };
    },
  };
}

/** Traverse ALL qualified native references, not native GC's reduced graph.
 * GC intentionally skips summary archives and historical context edges. Missing
 * such data is a refusal here, never a supposedly complete backup. Cycles are
 * visited once; the material DAG records flattened closure membership, not an
 * invented acyclic native graph. Root and referenced bytes remain unchanged. */
export async function captureNativeCheckpoint(input: { schema: NativeCheckpointSchema; reader: NativeCheckpointRead;
  expected: NativeCurrentHead; policy: ContinuityStorePolicy; capturedAtMs: number }): Promise<NativeMaterial> {
  const expected = nativeCurrentHead(input.expected), schema = input.schema, policy = continuityStorePolicy(input.policy);
  if (!(input.reader.rootId instanceof Uint8Array)) return fail();
  if (expected.rootHash === null || !Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 1) return fail();
  const rootId = Uint8Array.from(input.reader.rootId), rootKey = hex(rootId);
  const records = new Map<string, { bytes: Uint8Array; type: string; id: Uint8Array }>();
  const pending = [{ key: rootKey, id: rootId, type: "agent.v1.ConversationStateStructure" }];
  const types = new Map<string, string>([[rootKey, "agent.v1.ConversationStateStructure"]]);
  let byteCount = 0, nodes = 0, edges = 0, pendingEffects = expected.effects === "unresolved";
  function enqueue(id: unknown, type: string) {
    if (!(id instanceof Uint8Array)) return fail();
    if (!id.byteLength) return;
    if (++edges > MAX_REFERENCE_EDGES) return fail("limit_exceeded");
    const key = hex(id), prior = types.get(key);
    if (prior && prior !== type) return fail("reference_type_conflict");
    if (prior) return;
    if (types.size >= policy.maxParts) return fail("limit_exceeded");
    types.set(key, type); pending.push({ key, id: Uint8Array.from(id), type });
  }
  function visit(message: ProtoMessage, expectedType?: string) {
    if (++nodes > MAX_INLINE_NODES) return fail("limit_exceeded");
    if (!schema.isMessage(message)) return fail();
    const type = message.getType();
    if (!type || typeof type.typeName !== "string" || expectedType && type.typeName !== expectedType) return fail();
    // Unknown protobuf fields could hide dependencies outside the known schema.
    if (typeof type.runtime?.bin?.listUnknownFields !== "function" || type.runtime.bin.listUnknownFields(message).length) return fail("unsupported_wire_fields");
    const fields = type.fields.list(), refs = schema.referenceMetadata(type.typeName)?.fields ?? [];
    if (!Array.isArray(fields) || fields.length > 256 || !Array.isArray(refs) || refs.length > 256) return fail();
    // A disconnected metadata binding must not turn the root into an opaque,
    // apparently complete snapshot. This qualified root type has reference fields
    // even when the particular checkpoint contains no messages.
    if (type.typeName === "agent.v1.ConversationStateStructure" && !refs.length) return fail("unsupported_reference_type");
    const byName = new Map(refs.map(r => [r.localFieldName, r]));
    if (byName.size !== refs.length || refs.some(r => !fields.some(f => f.localName === r.localFieldName))) return fail();
    if (type.typeName === "agent.v1.ConversationStateStructure" && (Array.isArray(message.pendingToolCalls) && message.pendingToolCalls.length
      || Object.keys((message.subagentRunsByParentToolCallId ?? {}) as object).length)) pendingEffects = true;
    for (const field of fields) {
      let value = message[field.localName];
      if (field.oneof) {
        const selected = message[field.oneof.localName] as { case?: string; value?: unknown } | undefined;
        value = selected?.case === field.localName ? selected.value : undefined;
      }
      if (value == null) continue;
      const reference = byName.get(field.localName);
      if (reference) {
        if (typeof reference.blobReferenceType !== "string") return fail();
        for (const id of values(value)) enqueue(id, reference.blobReferenceType);
      } else if (field.kind === "message") {
        for (const nested of field.repeated ? values(value) : [value]) visit(nested as ProtoMessage);
      } else if (field.kind === "map" && field.V?.kind === "message") {
        for (const nested of values(value)) visit(nested as ProtoMessage);
      }
    }
  }
  try {
    while (pending.length) {
      const next = pending.shift()!, budget = Math.min(policy.maxPartBytes, policy.maxSnapshotBytes - byteCount);
      if (budget < 0) return fail("limit_exceeded");
      const raw = await input.reader.readBlob(next.id, budget);
      if (!(raw instanceof Uint8Array)) return fail("missing_reference");
      if (raw.byteLength > budget) return fail("limit_exceeded");
      const bytes = Uint8Array.from(raw); byteCount += bytes.byteLength;
      if (next.key === rootKey && sha256Bytes(bytes) !== expected.rootHash) throw new CurrentStateFailure("source_changed");
      records.set(next.key, { ...next, bytes });
      const decoder = next.key === rootKey ? schema.root : Object.hasOwn(schema.referenceTypes, next.type) ? schema.referenceTypes[next.type] : undefined;
      if (decoder) {
        let decoded: ProtoMessage;
        try { decoded = decoder.fromBinary(bytes); } catch { return fail("decode_failed"); }
        visit(decoded, next.type);
      } else {
        if (!["bytes", "json", "string"].includes(next.type)) return fail("unsupported_reference_type");
        // Qualified string/JSON references are UTF-8 payloads. Presence alone
        // does not make a malformed leaf usable by the native deserializer.
        // This checks encoding/syntax, NOT the semantic shape of a model message.
        if (next.type !== "bytes") {
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            if (next.type === "json") JSON.parse(text);
          } catch { return fail("decode_failed"); }
        }
      }
    }
    const content = new Map<string, Uint8Array>(), ids = [...records.keys()].filter(id => id !== rootKey).sort();
    const parts = [...records].map(([key, value]) => {
      const hash = sha256Bytes(value.bytes); content.set(hash, value.bytes);
      return { id: `n:${key}`, kind: key === rootKey ? "native-root" as const : "native-blob" as const,
        hash, bytes: value.bytes.byteLength, dependencies: key === rootKey ? ids.map(id => `n:${id}`) : [] };
    });
    const material = copyNativeMaterial({ manifest: { version: 1, source: { agentId: expected.agentId, scopeId: expected.scopeId,
      contextRevision: expected.contextRevision, nativeSchema: expected.nativeSchema, capturedAtMs: input.capturedAtMs, transcriptThrough: null },
      quality: "native_checkpoint", root: `n:${rootKey}`, parts,
      // Native closure only; display history and filesystem Memory are separate.
      gaps: ["memory_partial", "missing_history", ...(pendingEffects ? ["unknown_effects"] : [])] }, content }, policy);
    assertCapturedHead(material, expected); return material;
  } catch (e) { if (e instanceof CurrentStateFailure) throw e; return fail("native_read_failed"); }
}

export type NativeCheckpointStore = {
  getMetadata: (key: string) => unknown;
  getConversationStateStructure: () => ProtoMessage;
  resetFromDb: (ctx: unknown) => Promise<void>;
};
/** Original reset silently empties invalid state. Require persisted bytes and
 * reserialized in-memory state to match; this is NOT an application marker or
 * readiness/authority proof. Caller holds the reopened native owner boundary. */
export async function verifyNativeCheckpointReadback(input: { store: NativeCheckpointStore; ctx: unknown;
  expectedRootHash: string; maxBytes: number; readBlob: NativeCheckpointRead["readBlob"] }) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedRootHash) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) return fail();
  try {
    const initial = input.store.getMetadata("latestRootBlobId");
    if (!(initial instanceof Uint8Array)) return fail();
    const id = Uint8Array.from(initial); hex(id);
    const before = await input.readBlob(id, input.maxBytes);
    if (!(before instanceof Uint8Array) || before.byteLength > input.maxBytes || sha256Bytes(before) !== input.expectedRootHash) return fail();
    await input.store.resetFromDb(input.ctx);
    const serialized = input.store.getConversationStateStructure().toBinary();
    if (!(serialized instanceof Uint8Array) || serialized.byteLength > input.maxBytes) return fail();
    const loaded = Uint8Array.from(serialized);
    const finalId = input.store.getMetadata("latestRootBlobId"), after = await input.readBlob(id, input.maxBytes);
    if (!(finalId instanceof Uint8Array) || hex(finalId) !== hex(id) || !(after instanceof Uint8Array)
      || after.byteLength > input.maxBytes || loaded.byteLength > input.maxBytes
      || sha256Bytes(after) !== input.expectedRootHash || sha256Bytes(loaded) !== input.expectedRootHash) return fail();
    return { rootHash: input.expectedRootHash, nativeStateReadBack: true as const,
      activationAuthorized: false as const, applicationMarkerProven: false as const };
  } catch (e) { if (e instanceof CurrentStateFailure) throw e; return fail(); }
}

/** Post-write qualification, not a writer or a dispatch permit. It compares the
 * actual native traversal against the immutable material, including archived
 * and historical references. Caller owns the same native boundary throughout;
 * equal before/after samples alone never establish exclusion from native GC.
 * Identity transformations, application markers and non-native files are outside
 * this proof and remain requirements of the eventual full initializer. */
export async function verifyNativeCheckpointMaterialReadback(input: {
  store: NativeCheckpointStore; ctx: unknown; schema: NativeCheckpointSchema;
  expected: NativeCurrentHead; material: NativeMaterial; policy: ContinuityStorePolicy;
  readBlob: NativeCheckpointRead["readBlob"]; readHead: () => Promise<NativeCurrentHead>;
}) {
  const expected = nativeCurrentHead(input.expected), policy = continuityStorePolicy(input.policy);
  const material = copyNativeMaterial(input.material, policy);
  const root = material.manifest.parts.find(p => p.id === material.manifest.root);
  if (material.manifest.quality !== "native_checkpoint" || !root || root.hash !== expected.rootHash
    || material.manifest.source.nativeSchema !== expected.nativeSchema) return fail();
  const checkHead = async () => {
    if (!sameCurrentHead(nativeCurrentHead(await input.readHead()), expected)) throw new CurrentStateFailure("source_changed");
  };
  await checkHead();
  const proof = await verifyNativeCheckpointReadback({ store: input.store, ctx: input.ctx,
    expectedRootHash: root.hash, maxBytes: policy.maxPartBytes, readBlob: input.readBlob });
  const rootId = input.store.getMetadata("latestRootBlobId");
  if (!(rootId instanceof Uint8Array)) return fail();
  const actual = await captureNativeCheckpoint({ schema: input.schema, expected, policy,
    capturedAtMs: material.manifest.source.capturedAtMs,
    reader: { rootId: Uint8Array.from(rootId), readBlob: input.readBlob } });
  // Both manifests have passed the bounded sorter/validator. Do not compare
  // Memory/other declared material to a native-only traversal or silently sign it.
  const nativeParts = material.manifest.parts.filter(p => p.kind === "native-root" || p.kind === "native-blob");
  if (actual.manifest.root !== material.manifest.root || canonicalJson(actual.manifest.parts) !== canonicalJson(nativeParts)) return fail();
  await checkHead();
  return { ...proof, nativeClosureReadBack: true as const, verifiedParts: nativeParts.length,
    verificationScope: "qualified_native_reference_graph" as const,
    memoryAndDisplayHistoryProven: false as const, modelWindowProven: false as const };
}
