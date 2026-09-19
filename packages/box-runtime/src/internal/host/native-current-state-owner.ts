import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { captureNativeBotSupplement, applyNativeBotSupplement, verifyNativeBotSupplement,
  type NativeBotMaterialOwner, type SupplementReceipt } from "./native-bot-material.ts";
import { CurrentStateFailure, applicationObservation, assertNativeBinding, copyNativeMaterial, continuityStorePolicy,
  initializationDigest, initializeCurrentRequest, nativeCurrentHead, nativeQualification, sameCurrentHead,
  appendBotSupplement, readBotSupplement, nativeMaterialParts, currentContextSeed, contextSeedMetadata,
  CONTEXT_INSTRUCTIONS_KEY, CONTEXT_SEED_PART, botBirth, botStartup, type BotStartup, type BotBirth, type CurrentContextSeed,
  type InitializationAttempt, type NativeApplicationMarker, type NativeCurrentHead, type NativeCurrentStatePort,
  type NativeMaterial, type NativeQualification, type PreparedCurrentState } from "@grokbox/runtime-kernel/continuity";

export const NATIVE_CURRENT_STATE_SYMBOL = "grokbox.box-runtime.native-current-state.v1";
export const NATIVE_CURRENT_STATE_KEY = "grokbox.current-state.v1";
type NativeStructure = { toBinary: () => Uint8Array; pendingToolCalls?: unknown[]; subagentRunsByParentToolCallId?: object };
export type NativeCurrentStore = {
  getMetadata: (key: string) => unknown;
  getConversationStateStructure: () => NativeStructure;
  resetFromDb: (ctx: unknown) => Promise<void>;
  getBlobStore: () => { grokboxCurrentState: (action: "capture" | "compose" | "prepare" | "apply" | "observe" | "release", payload: unknown) => Promise<any> };
};
export type NativeStateMetadata = {
  readKv: (key: string) => string | null;
  writeKv: (key: string, value: string) => boolean;
  compareAndSetLatestRootBlobId: (value: { expectedRoot: Uint8Array; nextRoot: Uint8Array }) => boolean;
  getTranscriptTail: (query: { limit: number }) => { entries: unknown[] };
  getPendingAutomationCompletions: () => unknown[];
  deleteKv?: (key: string) => unknown;
  historyPosition?: (id: string | null) => number | null;
};
type State = { version: 1; sequence: number; hold: "none" | "prepared" | "blocked";
  operation: string | null; application: NativeApplicationMarker | null; supplement?: SupplementReceipt; instructionHash?: string; appliedSequence?: number; historyFloor?: number; birth?: boolean; startupCount?: number };
export type NativeCurrentRegistration = { store: NativeCurrentStore; metadata: NativeStateMetadata; ctx: unknown;
  rootId: Uint8Array; source: NativeQualification; valid: () => boolean; material?: NativeBotMaterialOwner };
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
  const births = new AsyncLocalStorage<BotBirth>();
  const startupTickets = new WeakMap<object, { agentId: string; operationId: string }>(), startupReservations = new Set<string>();
  const startupMessages = new Map<string, string>(), startupTurns = new Set<string>();
  const resolve = (agentId: string) => {
    const value = registrations.get(agentId)?.deref();
    if (!value || !value.valid()) return failure("native_unavailable");
    return value;
  };
  const state = (entry: NativeCurrentRegistration): State => {
    const raw = entry.metadata.readKv(NATIVE_CURRENT_STATE_KEY);
    if (raw === null) return empty();
    try {
      if (raw.length > 192 * 1024) throw Error();
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
  const instructions = (entry: NativeCurrentRegistration) => {
    const raw = entry.metadata.readKv(CONTEXT_INSTRUCTIONS_KEY);
    if (raw === null) return "";
    try {
      if (raw.length > 128 * 1024) return failure("material_invalid");
      const value = JSON.parse(raw);
      if (value.version !== 1 || typeof value.text !== "string" || value.text.length > 65536 || value.hash !== sha256Text(value.text)) return failure("material_invalid");
      return value.text as string;
    } catch { return failure("material_invalid"); }
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
    const revision = saved.application?.rootHash === hash && saved.sequence === (saved.appliedSequence ?? 0)
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
  const enter = (agentId: string, ticket?: object) => {
    const entry = resolve(agentId), saved = state(entry);
    if (leases.has(agentId) || saved.hold !== "none" || startupReservations.has(agentId) && (!ticket || startupTickets.get(ticket)?.agentId !== agentId)) return failure("not_prepared");
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
    const saved = state(entry);
    let m = saved.application;
    if (!m || m.operationId !== attempt.operationId) {
      const raw = entry.metadata.readKv(`grokbox.current-application:${attempt.operationId}`);
      if (raw === null) return { state: "unknown" as const, current };
      try { m = JSON.parse(raw); } catch { return failure("commit_unknown"); }
    }
    if (!m || m.operationId !== attempt.operationId) return { state: "unknown" as const, current };
    const response = await entry.store.getBlobStore().grokboxCurrentState("observe", { attempt: requestOnly(attempt) });
    if (response?.state !== "worker_committed" || canonicalJson(response.marker) !== canonicalJson(m)) return { state: "unknown" as const, current };
    return applicationObservation({ state: "applied", marker: m, current }, attempt);
  };
  const requestOnly = (attempt: InitializationAttempt) => initializeCurrentRequest({ operationId: attempt.operationId,
    effectId: attempt.effectId, expected: attempt.expected, snapshot: attempt.snapshot, policyRevision: attempt.policyRevision,
    ...(attempt.mode ? { mode: attempt.mode, backupSnapshot: attempt.backupSnapshot } : {}) });
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
          const supplement = entry.material ? { ...captureNativeBotSupplement(initial.agentId, entry.material), instructions: instructions(entry) } : null;
          const material = await entry.store.getBlobStore().grokboxCurrentState("capture", {
            expected: initial, rootId: rootPointer(entry), limits, capturedAtMs: Date.now() });
          if (!sameCurrentHead(readHead(initial.agentId, initial.scopeId), initial)) return failure("source_changed");
          if (supplement && (!entry.material || canonicalJson({ ...captureNativeBotSupplement(initial.agentId, entry.material), instructions: instructions(entry) }) !== canonicalJson(supplement))) return failure("source_changed");
          return copyNativeMaterial(supplement ? appendBotSupplement(material, supplement) : material, continuityStorePolicy(limits));
        }, release: async () => { if (closed) return failure("cleanup_unknown"); closed = true; } };
    },
    initialize: async raw => {
      const request = requestOnly(raw), attempt = { ...request, inputDigest: initializationDigest(request) };
      const id = request.expected.agentId, entry = resolve(id), saved = state(entry);
      assertNativeBinding(request.expected, request.expected, qualification);
      if (!sameCurrentHead(readHead(id, request.expected.scopeId), request.expected) || leases.has(id) || (active.get(id) ?? 0) || (checkpoints.get(id) ?? 0)
        || saved.hold === "blocked" || saved.hold !== "none" && saved.operation !== attempt.operationId && saved.birth !== true) return failure("not_prepared");
      const replacing = request.mode !== undefined;
      if (replacing) {
        if (!request.backupSnapshot || request.expected.rootHash === null || !entry.metadata.deleteKv || !entry.metadata.historyPosition
          || entry.metadata.getPendingAutomationCompletions().length) return failure("not_prepared");
      } else if (request.expected.rootHash !== null || rootPointer(entry).byteLength || saved.sequence !== 0 || !virgin(entry)) return failure("not_prepared");
      const originalPointer = rootPointer(entry);
      const originalFloor = entry.metadata.historyPosition?.(null) ?? null;
      const boundaryUnchanged = () => replacing
        ? originalFloor === entry.metadata.historyPosition?.(null) && entry.metadata.getPendingAutomationCompletions().length === 0
          && Buffer.from(rootPointer(entry)).equals(originalPointer) && readHead(id, request.expected.scopeId).contextRevision === request.expected.contextRevision
        : virgin(entry) && rootPointer(entry).byteLength === 0;
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
            || candidate.manifest.parts.some(p => !["native-root", "native-blob"].includes(p.kind) && p.id !== "bot:supplement" && p.id !== CONTEXT_SEED_PART)) return failure("material_invalid");
          if (readBotSupplement(candidate) && !entry.material) return failure("native_unavailable");
          const seed = contextSeedMetadata(candidate);
          if (request.mode === "reset" && (seed?.purpose !== "reset" || seed.sourceId !== id || seed.sourceRevision !== request.expected.contextRevision)) return failure("material_invalid");
          const preview = await entry.store.getBlobStore().grokboxCurrentState("prepare", { attempt: request, rootId: entry.rootId, material: candidate });
          if (preview?.state !== "candidate" || preview.inputDigest !== attempt.inputDigest || preview.rootHash !== root.hash
            || preview.candidateHash !== sha256Text(canonicalJson(nativeMaterialParts(candidate.manifest.parts)))) return failure("material_invalid");
          prepared = { inputDigest: preview.inputDigest, rootHash: preview.rootHash, candidateHash: preview.candidateHash };
          return prepared;
        },
        commit: async (received, plan) => {
          assertOpen(); if (!candidate || !prepared || received.inputDigest !== attempt.inputDigest || canonicalJson(plan) !== canonicalJson(prepared)) return failure("operation_conflict");
          if (!boundaryUnchanged()) return failure("not_prepared");
          writing.add(id);
          try {
            const result = await entry.store.getBlobStore().grokboxCurrentState("apply", { attempt: request, rootId: entry.rootId, material: candidate });
            if (result?.state !== "worker_committed" || result.marker?.candidateHash !== plan.candidateHash) return failure("commit_unknown");
            const pointer = rootPointer(entry);
            // The worker call is asynchronous: a native inbox/history writer
            // may have delivered a record while its transaction was committing.
            // Keep both holds and the source evidence rather than publish an
            // imported root over a target that stopped being virgin meanwhile.
            if (!boundaryUnchanged() || !Buffer.from(pointer).equals(originalPointer) || !entry.metadata.compareAndSetLatestRootBlobId({ expectedRoot: pointer, nextRoot: entry.rootId })) return failure("commit_unknown");
            await entry.store.resetFromDb(entry.ctx);
            if (sha256Bytes(entry.store.getConversationStateStructure().toBinary()) !== plan.rootHash) return failure("commit_unknown");
            const supplement = readBotSupplement(candidate), seed = contextSeedMetadata(candidate);
            const nextInstructions = replacing ? undefined : seed ? seed.instructions : supplement?.instructions;
            const instructionHash = nextInstructions === undefined ? undefined : sha256Text(nextInstructions);
            if (nextInstructions !== undefined && !entry.metadata.writeKv(CONTEXT_INSTRUCTIONS_KEY, canonicalJson({ version: 1, text: nextInstructions, hash: instructionHash }))) return failure("commit_unknown");
            const imported = !replacing && supplement ? applyNativeBotSupplement(id, supplement, entry.material!) : undefined;
            if (replacing) {
              for (const key of ["episodePending", "memoryPromptSnapshot", "agentProfilePromptSnapshot", "promptPrefixSnapshot", "promptSectionSnapshots", "latestRequestId", "requestIds", "lastTurnSettlement", "awaitingUserResponse"]) {
                entry.metadata.deleteKv!(key);
                if (entry.metadata.readKv(key) !== null) return failure("commit_unknown");
              }
            }
            const after = state(entry), sequence = replacing ? saved.sequence + 1 : 0;
            if (!entry.metadata.writeKv(`grokbox.current-application:${attempt.operationId}`, canonicalJson(result.marker))) return failure("commit_unknown");
            const next: State = { ...after, sequence, appliedSequence: sequence, application: result.marker, hold: "prepared", birth: false,
              ...(replacing ? { historyFloor: originalFloor! } : {}),
              ...(imported ? { supplement: imported } : {}), ...(instructionHash ? { instructionHash } : {}) };
            if (replacing) { delete next.supplement; delete next.instructionHash; }
            put(entry, next);
          } finally { writing.delete(id); }
        },
        reopen: async () => {
          assertOpen(); await entry.store.resetFromDb(entry.ctx);
          const now = readHead(id, request.expected.scopeId);
          if (!prepared || now.rootHash !== prepared.rootHash) return failure("commit_unknown");
          // Reload the original store, then re-read the actual worker graph too.
          const material = await entry.store.getBlobStore().grokboxCurrentState("capture", { expected: now, rootId: rootPointer(entry),
            limits: continuityStorePolicy(), capturedAtMs: candidate!.manifest.source.capturedAtMs });
          if (canonicalJson(material.manifest.parts) !== canonicalJson(nativeMaterialParts(candidate!.manifest.parts))) return failure("commit_unknown");
          const saved = state(entry), supplement = saved.supplement;
          if (saved.instructionHash && sha256Text(instructions(entry)) !== saved.instructionHash) return failure("commit_unknown");
          if (supplement) { if (!entry.material) return failure("native_unavailable"); verifyNativeBotSupplement(supplement, entry.material); }
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
      if (saved.supplement) { if (!entry.material) return failure("native_unavailable"); verifyNativeBotSupplement(saved.supplement, entry.material); }
      if (saved.instructionHash && sha256Text(instructions(entry)) !== saved.instructionHash) return failure("commit_unknown");
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
    const done = enter(id, args[1]?.grokboxStartupTicket);
    try { return await run(...args); } finally { done(); }
  };
  const deferMaintenance = (metadata: NativeStateMetadata) => {
    const raw = metadata.readKv(NATIVE_CURRENT_STATE_KEY);
    if (raw === null) return false;
    try { return JSON.parse(raw).hold !== "none"; } catch { return true; }
  };
  const filterRecent = (host: any, messages: any) => {
    if (!Array.isArray(messages)) return messages;
    const entry = registrations.get(host.getConversationId())?.deref();
    if (!entry?.valid() || !entry.material) return messages;
    return messages.filter(message => {
      const saved = state(entry);
      if (saved.historyFloor !== undefined) {
        const seq = entry.metadata.historyPosition?.(message.id);
        if (seq == null || seq <= saved.historyFloor) return false;
      }
      const original = entry.material!.history.getEntryById(message.id) as any;
      return original?.continuitySource?.historical !== true;
    });
  };
  const startupStatus = (agentId: string, operationId: string) => {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) return failure("invalid_request");
    const raw = resolve(agentId).metadata.readKv(`grokbox.startup:${operationId}`);
    if (raw === null) return { state: "absent", operationId, started: false };
    try { const value = JSON.parse(raw); if (value.version !== 1 || value.operationId !== operationId || value.agentId !== agentId) throw Error(); return value; }
    catch { return failure("commit_unknown"); }
  };
  const startup = async (raw: BotStartup, run: (ticket: object) => Promise<any>, interrupt: () => void) => {
    const request = botStartup(raw), id = request.expected.agentId, entry = resolve(id), digest = sha256Text(canonicalJson(request));
    const previous = startupStatus(id, request.operationId);
    if (previous.state !== "absent") {
      if (previous.inputDigest !== digest) return failure("operation_conflict");
      return { ...previous, duplicate: true };
    }
    const saved = state(entry);
    if (!sameCurrentHead(readHead(id, request.expected.scopeId), request.expected) || request.expected.effects !== "clear"
      || saved.hold !== "none" || (active.get(id) ?? 0) || leases.has(id) || startupReservations.has(id) || (saved.startupCount ?? 0) >= 128) return failure("not_prepared");
    const key = `grokbox.startup:${request.operationId}`;
    const record = { version: 1, operationId: request.operationId, agentId: id, inputDigest: digest, state: "dispatching", started: null, claimedAtMs: Date.now(), source: "program_startup" };
    put(entry, { ...saved, startupCount: (saved.startupCount ?? 0) + 1 });
    if (!entry.metadata.writeKv(key, canonicalJson(record)) || entry.metadata.readKv(key) !== canonicalJson(record)) return failure("commit_unknown");
    const ticket = Object.freeze({}); startupTickets.set(ticket, { agentId: id, operationId: request.operationId }); startupReservations.add(id);
    startupMessages.set(id, `grokbox-startup:${request.operationId}`);
    let expired = false;
    const timer = setTimeout(() => { expired = true; try { interrupt(); } catch { /* Persistent attempt stays unknown until native settlement. */ } }, request.maxRunMs);
    try {
      const result = await run(ticket);
      if (startupTickets.has(ticket) || !startupTurns.has(id)) return failure("native_unavailable");
      const receipt = { ...record, state: "settled", started: true, settledAtMs: Date.now(), aborted: expired || result?.aborted === true,
        paused: result?.pausedForUpgrade === true, deliveryVerified: false, businessComplete: false };
      if (!entry.metadata.writeKv(key, canonicalJson(receipt))) return failure("commit_unknown");
      return receipt;
    } catch (error) {
      const receipt = { ...startupStatus(id, request.operationId), state: "failed", settledAtMs: Date.now(), resultUnknown: true };
      if (!entry.metadata.writeKv(key, canonicalJson(receipt))) return failure("commit_unknown");
      throw error;
    } finally { clearTimeout(timer); startupTickets.delete(ticket); startupReservations.delete(id); startupMessages.delete(id); startupTurns.delete(id); }
  };
  const startupMessageId = (agentId: string) => startupMessages.get(agentId) ?? failure("not_prepared");
  // A zero-text native turn carrier, not a Human input. The reservation is
  // private and exists only during this original runner invocation. A matching
  // string in a later ordinary message cannot suppress its prompt.
  const isStartupUserMessage = (agentId: string, message: { text?: unknown; isSimulatedMsg?: unknown; messageId?: unknown }) => {
    const matches = startupReservations.has(agentId) && message?.text === "" && message.isSimulatedMsg === true
      && message.messageId === startupMessages.get(agentId);
    if (matches) startupTurns.add(agentId);
    return matches;
  };
  const consumeStartup = (agentId: string, ticket: unknown) => {
    if (!ticket || typeof ticket !== "object" || startupTickets.get(ticket)?.agentId !== agentId) return false;
    const identity = startupTickets.get(ticket)!;
    const entry = resolve(agentId), current = startupStatus(agentId, identity.operationId);
    if (current.state !== "dispatching" || !entry.metadata.writeKv(`grokbox.startup:${identity.operationId}`, canonicalJson({ ...current, state: "started", started: true, startedAtMs: Date.now() }))) return failure("commit_unknown");
    startupTickets.delete(ticket); return true;
  };
  const withBirth = <A>(raw: BotBirth, create: () => Promise<A>): Promise<A> => {
    const request = botBirth(raw);
    if (births.getStore()) return Promise.reject(new CurrentStateFailure("operation_conflict"));
    return births.run(request, create);
  };
  const birthOptions = () => {
    const request = births.getStore();
    return request ? { grokboxBirthOperation: request.operationId, isIntroductionSuppressed: true, isKickstartRequested: false } : {};
  };
  const stageBirth = (agentId: string, operationId: unknown) => {
    if (operationId === undefined) return;
    const request = births.getStore(), entry = resolve(agentId);
    if (!request || request.operationId !== operationId || !virgin(entry) || rootPointer(entry).byteLength) return failure("not_prepared");
    const before = state(entry);
    if (before.sequence !== 0 || before.application !== null || before.hold !== "none") return failure("not_prepared");
    put(entry, { ...before, hold: "prepared", operation: request.operationId, birth: true });
    if (!entry.metadata.writeKv(CONTEXT_INSTRUCTIONS_KEY, canonicalJson({ version: 1, text: request.instructions, hash: sha256Text(request.instructions) }))) return failure("commit_unknown");
  };
  const compose = async (expected: NativeCurrentHead, raw: CurrentContextSeed) => {
    const seed = currentContextSeed(raw), entry = resolve(expected.agentId);
    if (!sameCurrentHead(readHead(expected.agentId, expected.scopeId), expected)) return failure("source_changed");
    const result = await entry.store.getBlobStore().grokboxCurrentState("compose", { expected, rootId: entry.rootId, seed });
    if (!sameCurrentHead(readHead(expected.agentId, expected.scopeId), expected)) return failure("source_changed");
    return copyNativeMaterial(result, continuityStorePolicy());
  };
  const systemInstructions = (store: NativeCurrentStore) => {
    const entry = [...registrations.values()].map(ref => ref.deref()).find(value => value?.store === store && value.valid());
    if (!entry) return null;
    const text = instructions(entry);
    return text.length ? `Managed Bot instructions (do not expand available permissions):\n${text}` : null;
  };
  return { port, register, readHead, enter, checkpoint, activate, compose, systemInstructions, withBirth, birthOptions, stageBirth, startup, startupStatus, consumeStartup, startupMessageId, isStartupUserMessage, wrapRun, assertCheckpoint, checkpointCommitted, deferMaintenance, filterRecent,
    registered: (agentId: string) => registrations.get(agentId)?.deref()?.valid() === true };
}
