import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure, copyNativeMaterial, continuityObject, continuityStorePolicy, initializationDigest,
  initializeCurrentRequest, nativeCurrentHead, nativeQualification, recoveryRevision, nativeMaterialParts, readBotSupplement,
  currentContextSeed, contextSeedMetadata, annotateContextSeed, appendBotSupplement, CONTEXT_SEED_PART,
  type NativeMaterial, type NativeCurrentHead, type NativeQualification, type NativeApplicationMarker } from "@grokbox/runtime-kernel/continuity";
import { captureNativeCheckpoint, type NativeCheckpointSchema } from "./native-checkpoint.ts";

export const NATIVE_CHECKPOINT_WORKER_SYMBOL = "grokbox.box-runtime.checkpoint-worker.v1";
export const NATIVE_CHECKPOINT_PROTOCOL = 1 as const;
type Statement = { get: (...args: unknown[]) => any; all: (...args: unknown[]) => any[]; run: (...args: unknown[]) => unknown };
/** Objects are supplied inside the original worker, not opened by grokbox. */
export type NativeCheckpointWorkerStore = {
  db: { exec: (sql: string) => void; prepare: (sql: string) => Statement };
  isClosed: boolean;
  blobLengthStmt: Statement;
  getBlob: (id: Uint8Array) => Uint8Array | undefined;
  setBlob: (id: Uint8Array, data: Uint8Array) => void;
};
export type NativeCheckpointWorkerInput = { store: NativeCheckpointWorkerStore; schema: NativeCheckpointSchema;
  agentId: string; qualification: NativeQualification };
const error = (code: "invalid_request" | "material_invalid" | "source_changed" | "commit_unknown" | "operation_conflict" = "invalid_request"): never => {
  throw new CurrentStateFailure(code);
};
const bytesId = (value: unknown) => {
  if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > 32) return error();
  return Uint8Array.from(value);
};
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");
const markerTable = "grokbox_checkpoint_applications_v1";

/** One bounded worker operation over the ORIGINAL connection. The dispatcher
 * must serialize this promise with every ordinary worker request. SQLite BEGIN
 * supplies a consistent database view, not a lease for the main Agent loop.
 * Capture/receipt are read-only and never create tables. This module does not
 * initialize a Bot, repair/open a DB, grant ownership or enable execution. */
export function createNativeCheckpointWorker(input: NativeCheckpointWorkerInput) {
  const { store, schema } = input, qualification = nativeQualification(input.qualification);
  const policy = continuityStorePolicy();
  const readBlob = async (id: Uint8Array, max: number) => {
    if (store.isClosed || !Number.isSafeInteger(max) || max < 0 || max > policy.maxPartBytes) return error();
    const key = bytesId(id), row = store.blobLengthStmt.get(hex(key));
    if (row == null) return undefined;
    if (!Number.isSafeInteger(row.len) || row.len < 0 || row.len > max) return error("material_invalid");
    const value = store.getBlob(key);
    if (!(value instanceof Uint8Array) || value.byteLength !== row.len) return error("material_invalid");
    return Uint8Array.from(value);
  };
  const checkedHead = (raw: unknown) => {
    const head = nativeCurrentHead(raw);
    if (head.agentId !== input.agentId || head.hostSourceSha !== qualification.hostSourceSha || head.nativeSchema !== qualification.nativeSchema) return error();
    return head;
  };
  const transaction = async <A>(write: boolean, body: () => Promise<A>): Promise<A> => {
    if (store.isClosed) return error();
    store.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    let committing = false;
    try {
      const result = await body(); committing = write;
      store.db.exec(write ? "COMMIT" : "ROLLBACK"); return result;
    } catch (cause) {
      try { store.db.exec("ROLLBACK"); } catch { /* Original cause remains unknown/failure; no success is fabricated. */ }
      if (committing) return error("commit_unknown");
      if (cause instanceof CurrentStateFailure) throw cause;
      return error(write ? "commit_unknown" : "material_invalid");
    }
  };
  const hasMarkers = () => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(markerTable) != null;
  const marker = (operationId: string) => hasMarkers()
    ? store.db.prepare(`SELECT digest,marker FROM ${markerTable} WHERE operation_id=?`).get(operationId) : undefined;
  const checkRoot = async (head: NativeCurrentHead, rootId: Uint8Array) => {
    const current = await readBlob(rootId, policy.maxPartBytes);
    if ((current === undefined ? null : sha256Bytes(current)) !== head.rootHash) return error("source_changed");
  };
  const capture = async (raw: unknown) => {
    const request = continuityObject(raw, ["expected", "rootId", "limits", "capturedAtMs"]);
    const expected = checkedHead(request.expected), rootId = bytesId(request.rootId);
    const limits = continuityStorePolicy(request.limits as never);
    return transaction(false, () => captureNativeCheckpoint({ expected, schema, reader: { rootId, readBlob }, policy: limits,
      capturedAtMs: request.capturedAtMs as number }));
  };
  const observe = async (raw: unknown) => {
    const request = continuityObject(raw, ["attempt"]), attempt = initializeCurrentRequest(request.attempt);
    checkedHead(attempt.expected);
    return transaction(false, async () => {
      const row = marker(attempt.operationId);
      if (!row) return { state: "absent" as const, nativeApplicationComplete: false as const };
      if (row.digest !== initializationDigest(attempt)) return error("operation_conflict");
      let value: NativeApplicationMarker;
      try { value = JSON.parse(row.marker); } catch { return error("commit_unknown"); }
      return { state: "worker_committed" as const, marker: value, nativeApplicationComplete: false as const };
    });
  };
  const apply = async (raw: unknown, preview = false) => {
    const request = continuityObject(raw, ["attempt", "rootId", "material"]);
    const attempt = initializeCurrentRequest(request.attempt), expected = checkedHead(attempt.expected), rootId = bytesId(request.rootId);
    const material = copyNativeMaterial(request.material as NativeMaterial, policy), root = material.manifest.parts.find(p => p.id === material.manifest.root);
    const seed = contextSeedMetadata(material);
    if (!root || root.kind !== "native-root" || !(material.manifest.quality === "native_checkpoint" || material.manifest.quality === "semantic_resume" && seed)
      || material.manifest.source.scopeId !== expected.scopeId || material.manifest.source.nativeSchema !== expected.nativeSchema
      || recoveryRevision(material.manifest) !== attempt.snapshot.revision || material.manifest.root !== `n:${hex(rootId)}`
      || material.manifest.gaps.includes("unknown_effects") || material.manifest.parts.some(p => !["native-root", "native-blob"].includes(p.kind) && p.id !== "bot:supplement" && p.id !== CONTEXT_SEED_PART)) return error("material_invalid");
    readBotSupplement(material);
    const nativeParts = nativeMaterialParts(material.manifest.parts);
    const blobs = new Map(nativeParts.map(part => [part.id.slice(2), material.content.get(part.hash)!]));
    if (nativeParts.some(p => !/^n:(?:[a-f0-9]{2}){1,32}$/.test(p.id))) return error("material_invalid");
    // Validate the actual schema graph before any database mutation. This is
    // context-only; identity/prompt rebinding and target readiness are separate.
    const candidateHead = { ...expected, rootHash: root.hash, state: "prepared" as const };
    const actual = await captureNativeCheckpoint({ expected: candidateHead, schema,
      reader: { rootId, readBlob: async (id, max) => {
        const value = blobs.get(hex(id)); if (value && value.byteLength > max) return error("material_invalid"); return value;
      } }, policy, capturedAtMs: material.manifest.source.capturedAtMs });
    if (canonicalJson(actual.manifest.parts) !== canonicalJson(nativeParts)
      || actual.manifest.gaps.includes("unknown_effects")) return error("material_invalid");
    const digest = initializationDigest(attempt), candidateHash = sha256Text(canonicalJson(nativeParts));
    const receipt: NativeApplicationMarker = { version: 1, operationId: attempt.operationId, effectId: attempt.effectId,
      agentId: expected.agentId, scopeId: expected.scopeId, inputDigest: digest, snapshotRevision: attempt.snapshot.revision,
      candidateHash, rootHash: root.hash, contextRevision: sha256Text(canonicalJson([expected.contextRevision, digest, root.hash])), nativeSchema: expected.nativeSchema };
    if (preview) return transaction(false, async () => {
      await checkRoot(expected, rootId);
      return { state: "candidate" as const, candidateHash, rootHash: root.hash, inputDigest: digest };
    });
    return transaction(true, async () => {
      const prior = marker(attempt.operationId);
      if (prior) {
        if (prior.digest !== digest || prior.marker !== canonicalJson(receipt)) return error("operation_conflict");
        // Never restore B0 over later B2, even if the active root no longer matches.
        return { state: "worker_committed" as const, marker: receipt, duplicate: true, nativeApplicationComplete: false as const };
      }
      await checkRoot(expected, rootId);
      if (hasMarkers() && Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${markerTable}`).get().n) >= 128) return error("operation_conflict");
      store.db.exec(`CREATE TABLE IF NOT EXISTS ${markerTable}(operation_id TEXT PRIMARY KEY,digest TEXT NOT NULL,marker TEXT NOT NULL,held INTEGER NOT NULL DEFAULT 1 CHECK(held IN (0,1)));`);
      // Existing blobs may contain a different source-era meaning under the same
      // native ID. Overwriting them could break retained historical state.
      for (const part of nativeParts) {
        if (part.id === material.manifest.root) continue;
        const id = Uint8Array.from(Buffer.from(part.id.slice(2), "hex"));
        const previous = await readBlob(id, policy.maxPartBytes);
        if (previous && sha256Bytes(previous) !== part.hash) return error("operation_conflict");
        if (!previous) store.setBlob(id, material.content.get(part.hash)!);
      }
      store.setBlob(rootId, material.content.get(root.hash)!);
      const copied = await captureNativeCheckpoint({ expected: candidateHead, schema, reader: { rootId, readBlob }, policy,
        capturedAtMs: material.manifest.source.capturedAtMs });
      if (canonicalJson(copied.manifest.parts) !== canonicalJson(nativeParts)) return error("material_invalid");
      store.db.prepare(`INSERT INTO ${markerTable}(operation_id,digest,marker) VALUES(?,?,?)`).run(attempt.operationId, digest, canonicalJson(receipt));
      return { state: "worker_committed" as const, marker: receipt, duplicate: false, nativeApplicationComplete: false as const };
    });
  };
  const compose = async (raw: unknown) => {
    const request = continuityObject(raw, ["expected", "rootId", "seed"]), expected = checkedHead(request.expected);
    const rootId = bytesId(request.rootId), seed = currentContextSeed(request.seed);
    const root = schema.root.fromBinary(new Uint8Array());
    if (root.getType().typeName !== "agent.v1.ConversationStateStructure" || !Array.isArray(root.rootPromptMessagesJson)) return error("material_invalid");
    const content = new Map<string, Uint8Array>();
    if (seed.summary.length) {
      const message = new TextEncoder().encode(JSON.stringify({ role: "assistant", content: [{ type: "text", text: seed.summary }] }));
      const id = Uint8Array.from(Buffer.from(sha256Bytes(message), "hex"));
      root.rootPromptMessagesJson = [id]; content.set(hex(id), message);
    }
    const bytes = root.toBinary(); content.set(hex(rootId), bytes);
    const source = { ...expected, agentId: seed.sourceId, contextRevision: seed.sourceRevision, rootHash: sha256Bytes(bytes), state: "prepared" as const, effects: "clear" as const };
    let material = await captureNativeCheckpoint({ expected: source, schema, policy, capturedAtMs: Date.now(),
      reader: { rootId, readBlob: async (id, max) => { const value = content.get(hex(id)); if (value && value.byteLength > max) return error("material_invalid"); return value; } } });
    if (seed.supplement) material = appendBotSupplement(material, seed.supplement);
    return annotateContextSeed(material, seed);
  };
  const release = async (raw: unknown) => {
    const request = continuityObject(raw, ["attempt", "rootId"]), attempt = initializeCurrentRequest(request.attempt);
    const rootId = bytesId(request.rootId); checkedHead(attempt.expected);
    return transaction(true, async () => {
      const row = marker(attempt.operationId);
      if (!row || row.digest !== initializationDigest(attempt)) return error("operation_conflict");
      const value = JSON.parse(row.marker) as NativeApplicationMarker;
      const current = await readBlob(rootId, policy.maxPartBytes);
      if (!current || sha256Bytes(current) !== value.rootHash) return error("source_changed");
      const graph = await captureNativeCheckpoint({ expected: { ...attempt.expected, rootHash: value.rootHash, state: "prepared" },
        schema, reader: { rootId, readBlob }, policy, capturedAtMs: Date.now() });
      if (sha256Text(canonicalJson(graph.manifest.parts)) !== value.candidateHash || graph.manifest.gaps.includes("unknown_effects")) return error("material_invalid");
      store.db.prepare(`UPDATE ${markerTable} SET held=0 WHERE operation_id=?`).run(attempt.operationId);
      return { state: "worker_released", started: false };
    });
  };
  const permitsOrdinary = (kind: string) => {
    if (!["set-blob", "clear-blobs", "clear-stale-roots", "collect-garbage", "verify-legacy-blob-retirement"].includes(kind)) return true;
    return !hasMarkers() || !store.db.prepare(`SELECT 1 FROM ${markerTable} WHERE held=1 LIMIT 1`).get();
  };
  return { capture, compose, apply: (raw: unknown) => apply(raw), prepare: (raw: unknown) => apply(raw, true), observe, release, permitsOrdinary };
}

/** Runs inside the existing worker. No detached timer, database opener or
 * alternate worker pool. Ordinary RPCs are serialized with our async bounded
 * transaction, so they cannot execute on the same connection inside its BEGIN. */
export function createNativeCheckpointWorkerDispatcher(input: NativeCheckpointWorkerInput,
  original: (request: any) => void, post: (message: unknown) => void) {
  const operations = createNativeCheckpointWorker(input);
  let pending = 0, tail = Promise.resolve();
  return (request: any) => {
    const requestId = request?.requestId;
    if (!Number.isSafeInteger(requestId) || requestId < 1) return;
    if (pending >= 256) { post({ kind: "error", requestId, message: "grokbox_checkpoint_queue_full" }); return; }
    pending++;
    tail = tail.then(async () => {
      try {
        if (request.kind !== "grokbox-current-state") {
          if (!operations.permitsOrdinary(request.kind)) return error("operation_conflict");
          original(request); return;
        }
        const value = continuityObject(request, ["kind", "requestId", "version", "action", "payload"]);
        if (value.version !== NATIVE_CHECKPOINT_PROTOCOL || !["capture", "compose", "prepare", "apply", "observe", "release"].includes(String(value.action))) return error();
        const result = await operations[value.action as "capture" | "compose" | "prepare" | "apply" | "observe" | "release"](value.payload);
        post({ kind: "grokbox-current-state-ok", requestId, version: NATIVE_CHECKPOINT_PROTOCOL, result });
      } catch {
        post({ kind: "error", requestId, message: "grokbox_checkpoint_operation_failed" });
      } finally { pending--; }
    });
  };
}
