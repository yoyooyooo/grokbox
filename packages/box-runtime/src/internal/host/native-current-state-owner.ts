import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CurrentStateFailure, applicationObservation, assertNativeBinding, copyNativeMaterial, continuityStorePolicy,
  initializationDigest, initializeCurrentRequest, nativeCurrentHead, nativeQualification, sameCurrentHead,
  type InitializationAttempt, type NativeApplicationMarker, type NativeCurrentHead, type NativeCurrentStatePort,
  type NativeMaterial, type NativeQualification, type PreparedCurrentState } from "@grokbox/runtime-kernel/continuity";

export const NATIVE_CURRENT_STATE_SYMBOL = "grokbox.box-runtime.native-current-state.v1";
export const NATIVE_CURRENT_STATE_KEY = "grokbox.current-state.v1";
type NativeStructure = { toBinary: () => Uint8Array; pendingToolCalls?: unknown[]; subagentRunsByParentToolCallId?: object };
export type NativeCurrentStore = {
  getMetadata: (key: string) => unknown;
  getConversationStateStructure: () => NativeStructure;
  resetFromDb: (ctx: unknown) => Promise<void>;
  getBlobStore: () => { grokboxCurrentState: (action: "capture" | "prepare" | "apply" | "observe" | "release", payload: unknown) => Promise<any> };
};
export type NativeStateMetadata = {
  readKv: (key: string) => string | null;
  writeKv: (key: string, value: string) => boolean;
  compareAndSetLatestRootBlobId: (value: { expectedRoot: Uint8Array; nextRoot: Uint8Array }) => boolean;
  getTranscriptTail: (query: { limit: number }) => { entries: unknown[] };
  getPendingAutomationCompletions: () => unknown[];
};
type State = { version: 1; sequence: number; hold: "none" | "prepared" | "blocked";
  operation: string | null; application: NativeApplicationMarker | null };
export type NativeCurrentRegistration = { store: NativeCurrentStore; metadata: NativeStateMetadata; ctx: unknown;
  rootId: Uint8Array; source: NativeQualification; valid: () => boolean };
const failure = (code: ConstructorParameters<typeof CurrentStateFailure>[0]): never => { throw new CurrentStateFailure(code); };
const empty = (): State => ({ version: 1, sequence: 0, hold: "none", operation: null, application: null });
const DEFAULT_MAX_BYTES = continuityStorePolicy().maxPartBytes;

/** Concrete native metadata/blob-owner adapter. Register only original loaded
 * default Box stores; the companion worker protocol is independently qualified.
 * There is no DB opener/repair, provider call, fake prompt or new session list.
 * Ordinary TURN and checkpoint hooks must use the same instance. */
export function createNativeCurrentStateOwner(input: { qualification: NativeQualification; generation: string }) {
  const qualification = nativeQualification(input.qualification);
  const registrations = new Map<string, WeakRef<NativeCurrentRegistration>>(), active = new Map<string, number>();
  const leases = new Set<string>(), writing = new Set<string>(), checkpoints = new Map<string, number>();
  const resolve = (agentId: string) => {
    const value = registrations.get(agentId)?.deref();
    if (!value || !value.valid()) return failure("native_unavailable");
    return value;
  };
  const state = (entry: NativeCurrentRegistration): State => {
    const raw = entry.metadata.readKv(NATIVE_CURRENT_STATE_KEY);
    if (raw === null) return empty();
    try {
      if (raw.length > 8192) throw Error();
      const v = JSON.parse(raw);
      if (v.version !== 1 || !Number.isSafeInteger(v.sequence) || v.sequence < 0 || !["none", "prepared", "blocked"].includes(v.hold)
        || !(v.operation === null || typeof v.operation === "string" && v.operation.length === 36)
        || !(v.application === null || typeof v.application === "object" && !Array.isArray(v.application))) throw Error();
      return v;
    } catch { return failure("commit_unknown"); }
  };
  const put = (entry: NativeCurrentRegistration, value: State) => {
    if (!entry.valid() || !entry.metadata.writeKv(NATIVE_CURRENT_STATE_KEY, canonicalJson(value))
      || entry.metadata.readKv(NATIVE_CURRENT_STATE_KEY) !== canonicalJson(value)) return failure("commit_unknown");
  };
  const rootPointer = (entry: NativeCurrentRegistration) => {
    const pointer = entry.store.getMetadata("latestRootBlobId");
    if (!(pointer instanceof Uint8Array) || pointer.byteLength > 32) return failure("material_invalid");
    return Uint8Array.from(pointer);
  };
  const virgin = (entry: NativeCurrentRegistration) => {
    // No root can also mean interrupted/corrupt old state. Read the original
    // bounded native projections and persisted request markers before treating
    // a target as a virgin Bot. Never repair or discard those records here.
    const tail = entry.metadata.getTranscriptTail({ limit: 1 });
    const completions = entry.metadata.getPendingAutomationCompletions();
    if (!Array.isArray(tail?.entries) || !Array.isArray(completions)) return failure("not_prepared");
    return tail.entries.length === 0 && completions.length === 0
      && ["latestRequestId", "requestIds", "lastTurnSettlement", "awaitingUserResponse"]
        .every(key => entry.metadata.readKv(key) === null);
  };
  const readHead = (agentId: string, scopeId: string): NativeCurrentHead => {
    const entry = resolve(agentId), saved = state(entry), pointer = rootPointer(entry), native = entry.store.getConversationStateStructure();
    const raw = native.toBinary();
    if (!(raw instanceof Uint8Array) || raw.byteLength > DEFAULT_MAX_BYTES) return failure("material_invalid");
    const hash = pointer.byteLength ? sha256Bytes(raw) : null;
    const running = (active.get(agentId) ?? 0) > 0;
    const unresolved = saved.hold === "blocked" || Boolean(native.pendingToolCalls?.length)
      || Object.keys(native.subagentRunsByParentToolCallId ?? {}).length > 0;
    const revision = saved.application?.rootHash === hash && saved.sequence === 0
      ? saved.application.contextRevision : sha256Text(canonicalJson([hash, saved.sequence]));
    return nativeCurrentHead({ agentId, scopeId, ...qualification, hostGeneration: input.generation,
      contextRevision: revision, activationEpoch: `native-${saved.sequence}`, rootHash: hash,
      state: running ? "active" : saved.hold === "blocked" ? "interrupted" : hash === null ? "empty" : "prepared",
      effects: unresolved ? "unresolved" : "clear" });
  };
  const register = (agentId: string, registration: NativeCurrentRegistration) => {
    assertNativeBinding({ ...qualification, agentId, scopeId: "0".repeat(64) } as NativeCurrentHead,
      { agentId, scopeId: "0".repeat(64) }, registration.source);
    if (leases.has(agentId) || writing.has(agentId) || (active.get(agentId) ?? 0) || (checkpoints.get(agentId) ?? 0)) return failure("not_prepared");
    if (registrations.size >= 256) for (const [id, ref] of registrations) if (!ref.deref()?.valid()) registrations.delete(id);
    if (registrations.size >= 256 && !registrations.has(agentId)) return failure("native_unavailable");
    Object.defineProperty(registration.store, Symbol.for(NATIVE_CURRENT_STATE_SYMBOL), { value: registration, configurable: true });
    registrations.set(agentId, new WeakRef(registration));
  };
  const enter = (agentId: string) => {
    const entry = resolve(agentId), saved = state(entry);
    if (leases.has(agentId) || saved.hold !== "none") return failure("not_prepared");
    // This persists before the native loop can produce a tool effect. A later
    // same-content checkpoint cannot make an earlier initialization look current.
    put(entry, { ...saved, sequence: saved.sequence + 1 });
    active.set(agentId, (active.get(agentId) ?? 0) + 1);
    let released = false;
    return () => { if (released) return; released = true;
      const pending = Math.max(0, (active.get(agentId) ?? 1) - 1);
      if (pending) active.set(agentId, pending); else active.delete(agentId);
    };
  };
  const checkpoint = async (agentId: string, original: () => Promise<void>, store?: NativeCurrentStore) => {
    const entry = resolve(agentId);
    if (store && entry.store !== store || leases.has(agentId) || state(entry).hold !== "none") return failure("not_prepared");
    checkpoints.set(agentId, (checkpoints.get(agentId) ?? 0) + 1);
    try {
      await original();
      if (resolve(agentId) !== entry) return failure("source_changed");
      const saved = state(entry); put(entry, { ...saved, sequence: saved.sequence + 1 });
    } finally {
      const pending = (checkpoints.get(agentId) ?? 1) - 1;
      if (pending) checkpoints.set(agentId, pending); else checkpoints.delete(agentId);
    }
  };
  const observation = async (attempt: InitializationAttempt) => {
    const current = readHead(attempt.expected.agentId, attempt.expected.scopeId), entry = resolve(current.agentId);
    const saved = state(entry), m = saved.application;
    if (!m || m.operationId !== attempt.operationId) return { state: "unknown" as const, current };
    const response = await entry.store.getBlobStore().grokboxCurrentState("observe", { attempt: requestOnly(attempt) });
    if (response?.state !== "worker_committed" || canonicalJson(response.marker) !== canonicalJson(m)) return { state: "unknown" as const, current };
    return applicationObservation({ state: "applied", marker: m, current }, attempt);
  };
  const requestOnly = (attempt: InitializationAttempt) => initializeCurrentRequest({ operationId: attempt.operationId,
    effectId: attempt.effectId, expected: attempt.expected, snapshot: attempt.snapshot, policyRevision: attempt.policyRevision });
  const port: NativeCurrentStatePort = { qualification,
    capture: async expected => {
      const initial = nativeCurrentHead(expected), entry = resolve(initial.agentId);
      assertNativeBinding(initial, initial, qualification);
      if (!sameCurrentHead(readHead(initial.agentId, initial.scopeId), initial) || leases.has(initial.agentId)) return failure("source_changed");
      let closed = false;
      return { readHead: async () => { if (closed) return failure("cancelled"); return readHead(initial.agentId, initial.scopeId); },
        readMaterial: async limits => {
          if (closed) return failure("cancelled");
          // One worker-side read transaction includes GC-excluded dependencies.
          const material = await entry.store.getBlobStore().grokboxCurrentState("capture", {
            expected: initial, rootId: rootPointer(entry), limits, capturedAtMs: Date.now() });
          if (!sameCurrentHead(readHead(initial.agentId, initial.scopeId), initial)) return failure("source_changed");
          return copyNativeMaterial(material, continuityStorePolicy(limits));
        }, release: async () => { if (closed) return failure("cleanup_unknown"); closed = true; } };
    },
    initialize: async raw => {
      const request = requestOnly(raw), attempt = { ...request, inputDigest: initializationDigest(request) };
      const id = request.expected.agentId, entry = resolve(id), saved = state(entry);
      assertNativeBinding(request.expected, request.expected, qualification);
      if (!sameCurrentHead(readHead(id, request.expected.scopeId), request.expected) || leases.has(id) || (active.get(id) ?? 0) || (checkpoints.get(id) ?? 0)
        || saved.hold === "blocked" || saved.application !== null || saved.operation !== null && saved.operation !== attempt.operationId) return failure("not_prepared");
      // This concrete adapter is for a virgin target, not reset/overwrite.
      if (request.expected.rootHash !== null || rootPointer(entry).byteLength || saved.sequence !== 0 || !virgin(entry)) return failure("not_prepared");
      leases.add(id); let closed = false, candidate: NativeMaterial | undefined, prepared: PreparedCurrentState | undefined;
      try { put(entry, { ...saved, hold: "prepared", operation: attempt.operationId }); }
      catch (error) { leases.delete(id); throw error; }
      const assertOpen = () => { if (closed || resolve(id) !== entry || !leases.has(id)) return failure("not_prepared"); };
      const initialHead = () => {
        assertOpen(); return readHead(id, request.expected.scopeId);
      };
      return {
        readHead: async () => initialHead(),
        prepare: async (material, received) => {
          assertOpen(); if (received.inputDigest !== attempt.inputDigest) return failure("operation_conflict");
          candidate = copyNativeMaterial(material, continuityStorePolicy());
          const root = candidate.manifest.parts.find(p => p.id === candidate!.manifest.root);
          if (!root || root.kind !== "native-root" || candidate.manifest.gaps.includes("unknown_effects")
            || candidate.manifest.parts.some(p => !["native-root", "native-blob"].includes(p.kind))) return failure("material_invalid");
          const preview = await entry.store.getBlobStore().grokboxCurrentState("prepare", { attempt: request, rootId: entry.rootId, material: candidate });
          if (preview?.state !== "candidate" || preview.inputDigest !== attempt.inputDigest || preview.rootHash !== root.hash
            || preview.candidateHash !== sha256Text(canonicalJson(candidate.manifest.parts))) return failure("material_invalid");
          prepared = { inputDigest: preview.inputDigest, rootHash: preview.rootHash, candidateHash: preview.candidateHash };
          return prepared;
        },
        commit: async (received, plan) => {
          assertOpen(); if (!candidate || !prepared || received.inputDigest !== attempt.inputDigest || canonicalJson(plan) !== canonicalJson(prepared)) return failure("operation_conflict");
          if (!virgin(entry) || rootPointer(entry).byteLength) return failure("not_prepared");
          writing.add(id);
          try {
            const result = await entry.store.getBlobStore().grokboxCurrentState("apply", { attempt: request, rootId: entry.rootId, material: candidate });
            if (result?.state !== "worker_committed" || result.marker?.candidateHash !== plan.candidateHash) return failure("commit_unknown");
            const pointer = rootPointer(entry);
            // The worker call is asynchronous: a native inbox/history writer
            // may have delivered a record while its transaction was committing.
            // Keep both holds and the source evidence rather than publish an
            // imported root over a target that stopped being virgin meanwhile.
            if (!virgin(entry) || pointer.byteLength || !entry.metadata.compareAndSetLatestRootBlobId({ expectedRoot: pointer, nextRoot: entry.rootId })) return failure("commit_unknown");
            await entry.store.resetFromDb(entry.ctx);
            if (sha256Bytes(entry.store.getConversationStateStructure().toBinary()) !== plan.rootHash) return failure("commit_unknown");
            const after = state(entry);
            put(entry, { ...after, sequence: 0, application: result.marker, hold: "prepared" });
          } finally { writing.delete(id); }
        },
        reopen: async () => {
          assertOpen(); await entry.store.resetFromDb(entry.ctx);
          const now = readHead(id, request.expected.scopeId);
          if (!prepared || now.rootHash !== prepared.rootHash) return failure("commit_unknown");
          // Reload the original store, then re-read the actual worker graph too.
          const material = await entry.store.getBlobStore().grokboxCurrentState("capture", { expected: now, rootId: rootPointer(entry),
            limits: continuityStorePolicy(), capturedAtMs: candidate!.manifest.source.capturedAtMs });
          if (canonicalJson(material.manifest.parts) !== canonicalJson(candidate!.manifest.parts)) return failure("commit_unknown");
          return now;
        },
        application: received => observation(received),
        release: async disposition => {
          assertOpen(); if (writing.has(id)) return failure("cleanup_unknown");
          const now = state(entry); put(entry, { ...now, hold: disposition });
          closed = true; leases.delete(id);
        },
      };
    },
    observeApplication: attempt => observation(attempt),
  };
  const activate = async (expected: NativeCurrentHead, attempt: InitializationAttempt) => {
    const current = nativeCurrentHead(expected), entry = resolve(current.agentId), saved = state(entry);
    if (saved.hold === "none" && saved.application?.operationId === attempt.operationId) {
      applicationObservation({ state: "applied", current, marker: saved.application }, attempt);
      if (!sameCurrentHead(readHead(current.agentId, current.scopeId), current)) return failure("source_changed");
      return { state: "released", started: false, alreadyReleased: true, current };
    }
    if (!sameCurrentHead(readHead(current.agentId, current.scopeId), current) || current.effects !== "clear"
      || (active.get(current.agentId) ?? 0) || (checkpoints.get(current.agentId) ?? 0) || leases.has(current.agentId) || saved.hold !== "prepared"
      || saved.application?.operationId !== attempt.operationId || saved.application.rootHash !== current.rootHash) return failure("not_prepared");
    leases.add(current.agentId);
    try {
      const released = await entry.store.getBlobStore().grokboxCurrentState("release", { attempt: requestOnly(attempt), rootId: entry.rootId });
      if (released?.state !== "worker_released" || !sameCurrentHead(readHead(current.agentId, current.scopeId), current)) return failure("commit_unknown");
      put(entry, { ...saved, hold: "none", sequence: saved.sequence + 1 });
    } finally { leases.delete(current.agentId); }
    // Enables only a subsequent normal input. Does not create a Human message,
    // start a loop or establish the external permission to request activation.
    return { state: "released", started: false, current: readHead(current.agentId, current.scopeId) };
  };
  const assertCheckpoint = (agentId: string, store: NativeCurrentStore) => {
    const entry = resolve(agentId);
    if (entry.store !== store || leases.has(agentId) || state(entry).hold !== "none") return failure("not_prepared");
  };
  const checkpointCommitted = (agentId: string, store: NativeCurrentStore) => {
    assertCheckpoint(agentId, store); const entry = resolve(agentId), saved = state(entry);
    put(entry, { ...saved, sequence: saved.sequence + 1 });
  };
  const wrapRun = (host: any, run: (...args: any[]) => Promise<unknown>) => async (...args: any[]) => {
    const id = host.getConversationId(), transcript = host.getTranscriptId();
    if (host.isSubagentRunner === true || id !== transcript || !registrations.has(id)) return run(...args);
    const done = enter(id);
    try { return await run(...args); } finally { done(); }
  };
  const deferMaintenance = (metadata: NativeStateMetadata) => {
    const raw = metadata.readKv(NATIVE_CURRENT_STATE_KEY);
    if (raw === null) return false;
    try { return JSON.parse(raw).hold !== "none"; } catch { return true; }
  };
  return { port, register, readHead, enter, checkpoint, activate, wrapRun, assertCheckpoint, checkpointCommitted, deferMaintenance,
    registered: (agentId: string) => registrations.get(agentId)?.deref()?.valid() === true };
}
