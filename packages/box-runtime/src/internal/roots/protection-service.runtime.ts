import { Effect, Cause, Exit } from "effect";
import { join } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { continuityProtection, botProtection, ContinuityFailure, CurrentStateFailure, type ContinuityProtection } from "@grokbox/runtime-kernel/continuity";
import { inspectOwnership } from "@grokbox/runtime-kernel/contract";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout, assertSafeDirectory } from "../io/config-layout.node.ts";
import { acquireAdvisoryGate, type AdvisoryGate } from "../io/advisory-gate.node.ts";
import { readContinuityIdentity, CONTINUITY_DB_VERSION } from "../io/continuity-database.node.ts";
import { continuityWorkflowPrograms } from "../io/continuity-workflows.node.ts";
import { ManagementSourceError, type NativeBotSnapshot } from "../io/management-gateway.node.ts";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";
import type { ContinuityGateway, NativeContinuityContext } from "../io/continuity-gateway.node.ts";
import { protectiveOwnership, createNativeBotProtection } from "./continuity-native-protection.runtime.ts";
import { startBotProtectionWorker, type BotProtectionPort } from "./bot-protection.runtime.ts";

export type ProtectionServiceStatus = {
  owner: "management-server"; state: "starting" | "disabled" | "idle" | "running" | "blocked" | "stopping" | "stopped";
  reason: "not-observed" | "policy-disabled" | "native-adapter-unavailable" | "source-unavailable" | "scope-mismatch" | "store-unavailable" | "schema-mismatch" | "competing-owner" | "no-qualified-bots" | "target-capacity" | "configuration-unavailable" | "target-identity-conflict" | "active" | "stopped";
  scopeId: string | null; scopeObservedAtMs: number | null; policyRevision: string | null; targets: number;
  discovered: number; rosterSize: number; discoveryCoverage: "not-observed" | "rotating-batch" | "observed-window" | "capacity-limited" | "creation-pending";
  startedAtMs: number; replacements: number; defaultProtection: true; nativeExecutionProven: false; bootInstalled: false;
};
export type ProtectionServiceInput = { root: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; native?: {
  listBots: (signal: AbortSignal) => Promise<NativeBotSnapshot>; ownershipRead: OwnershipReader;
  continuityAccess: (signal: AbortSignal) => ContinuityGateway;
} };
export type ProtectionServiceTestPorts = {
  pollMs?: number; discoveryMs?: number; observationMs?: number; advancementMs?: number; handoverMs?: number;
  create?: (context: NativeContinuityContext, scopeId: string, policy: () => Promise<ContinuityProtection>) => BotProtectionPort;
};
const MAX_SUBJECTS = 128;
const local = <A>(work: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: work, catch: error => error }));

/** Default discovery is read-only until a fresh official ownership observation
 * admits a Bot. One persistent fd gate owns all three CONT lanes; the original
 * CONT database owns materials, subjects and effects. Off never creates stores.
 * Slow restoration and handover do not share the ownership observation lane. */
export function startProtectionService(input: ProtectionServiceInput, tests: ProtectionServiceTestPorts = {}) {
  const pollMs = tests.pollMs ?? 5000, discoveryMs = tests.discoveryMs ?? 30000;
  for (const ms of [pollMs, discoveryMs, tests.observationMs ?? 30000, tests.advancementMs ?? 10000, tests.handoverMs ?? 30000])
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 300000) throw new Error("invalid_protection_interval");
  const owner = new AbortController(), discovered = new Set<string>();
  let state: ProtectionServiceStatus = { owner: "management-server", state: "starting", reason: "not-observed", scopeId: null, scopeObservedAtMs: null,
    policyRevision: null, targets: 0, discovered: 0, rosterSize: 0, discoveryCoverage: "not-observed", startedAtMs: Date.now(), replacements: 0,
    defaultProtection: true, nativeExecutionProven: false, bootInstalled: false };
  let active: ReturnType<typeof startBotProtectionWorker> | undefined, activeSignal: AbortController | undefined, gate: AdvisoryGate | null = null;
  let scope: string | null = null, sourceIdentity: string | null = null, nextDiscoveryAt = 0, offset = 0, mismatch = false, qualified = false, activeKey: string | null = null;
  const config = openConfigStore(rootConfigLayout(input.root));
  const readPolicy = async (): Promise<ContinuityProtection> => {
    const policy = continuityProtection((await config.read()).document.runtime?.continuity);
    if(!policy.enabled)return policy;
    const bots = { ...policy.bots };
    const identity=await readContinuityIdentity(input.root);
    if(identity){
      const rows=await Effect.runPromise(continuityWorkflowPrograms({durableRoot:input.root,scopeId:identity.scopeId}).subjects());
      if(rows.subjects.some(row=>row.logicalId!==row.currentId&&policy.bots[row.currentId]?.enabled))throw new Error("protection_identity_collision");
    }
    for (const id of discovered) if (!Object.hasOwn(bots,id) && Object.keys(bots).length < MAX_SUBJECTS) bots[id] = botProtection();
    return { ...policy, bots };
  };
  const stopChild = async () => {
    activeSignal?.abort();
    try { await active?.close(); }
    finally { active = undefined; activeSignal = undefined; activeKey = null; await gate?.release(); gate = null; }
  };
  async function tick() {
    let configured: ContinuityProtection;
    try { configured = continuityProtection((await config.read()).document.runtime?.continuity); }
    catch { await stopChild(); state = { ...state, state:"blocked", reason:"configuration-unavailable" }; return; }
    const revision = sha256Text(canonicalJson(configured));
    if (state.policyRevision !== revision) { await stopChild(); nextDiscoveryAt = 0; }
    state = { ...state, policyRevision: revision };
    if (!configured.enabled) { await stopChild(); state = { ...state, state:"disabled", reason:"policy-disabled" }; return; }
    if (!input.native) { state = { ...state, state:"blocked", reason:"native-adapter-unavailable" }; return; }
    if (mismatch) { await stopChild(); state = { ...state, state:"blocked", reason:"scope-mismatch" }; return; }
    const existing = await readContinuityIdentity(input.root);
    if (existing && existing.schemaVersion !== CONTINUITY_DB_VERSION) throw new ContinuityFailure("schema_mismatch");
    if (scope && existing && existing.scopeId !== scope) { mismatch = true; await stopChild(); state = { ...state, state:"blocked", reason:"scope-mismatch" }; return; }
    if (!scope && existing) scope = existing.scopeId;
    const rows = existing ? await Effect.runPromise(continuityWorkflowPrograms({durableRoot:input.root,scopeId:existing.scopeId}).subjects()) : { subjects: [], hasMore: false };
    const represented = new Set(rows.subjects.flatMap(row => [row.currentId, ...(Array.isArray(row.data.previousIds) ? row.data.previousIds.filter((v: unknown): v is string => typeof v === "string") : [])]));
    for (const row of rows.subjects) discovered.add(row.logicalId);
    if (Date.now() >= nextDiscoveryAt) {
      nextDiscoveryAt = Date.now() + discoveryMs;
      const roster = await input.native.listBots(owner.signal);
      const ids = [...new Set([...Object.keys(configured.bots), ...roster.bots.map(bot => bot.id), ...rows.subjects.map(row=>row.currentId)])].sort();
      state = { ...state, rosterSize: ids.length };
      if (ids.length) {
        const selected = Array.from({length:Math.min(32,ids.length)},(_,n)=>ids[(offset+n)%ids.length]!);
        offset = (offset + selected.length) % ids.length;
        const observation = await input.native.ownershipRead(selected,owner.signal), proof = inspectOwnership({agentIds:selected,snapshot:observation.snapshot});
        const at = Date.parse(proof.serverObservedAt ?? "");
        if (!proof.scope?.stable || !proof.scope.id || !Number.isSafeInteger(at) || Date.now() < at || Date.now()-at > 5000
          || observation.gateway.pid !== roster.source.pid || observation.gateway.startedAt !== roster.source.startedAt) throw new CurrentStateFailure("ownership_unconfirmed");
        if (scope !== null && scope !== proof.scope.id) { mismatch = true; await stopChild(); state = { ...state, state:"blocked", reason:"scope-mismatch" }; return; }
        scope = proof.scope.id; qualified = true;
        const generation = roster.source.generation;
        if (sourceIdentity !== null && sourceIdentity !== generation) await stopChild();
        sourceIdentity = generation;
        // Re-read creation claims after network discovery. A target can appear
        // in native List before the creator's reply is durably associated; it
        // must not become a second default-protection subject in that interval.
        const reservations = existing ? await Effect.runPromise(continuityWorkflowPrograms({durableRoot:input.root,scopeId:scope}).enrollment()) : {targets:[],hasMore:false,unknownCreations:0};
        for (const id of reservations.targets) represented.add(id);
        for (const [id, sample] of protectiveOwnership(selected,observation.snapshot,scope)) {
          if((reservations.hasMore||reservations.unknownCreations>0)&&!discovered.has(id))continue;
          if (sample.state !== "box" || represented.has(id) && !rows.subjects.some(row => row.logicalId === id)) continue;
          if (discovered.size + Object.keys(configured.bots).filter(id => !discovered.has(id)).length < MAX_SUBJECTS || discovered.has(id) || Object.hasOwn(configured.bots,id)) discovered.add(id);
        }
        state = { ...state, scopeId:scope, scopeObservedAtMs:at, discovered:discovered.size,
          discoveryCoverage: reservations.unknownCreations>0 ? "creation-pending" : reservations.hasMore || rows.hasMore || discovered.size >= MAX_SUBJECTS && ids.length > discovered.size ? "capacity-limited" : ids.length > selected.length ? "rotating-batch" : "observed-window" };
      }
    }
    const resolved = await readPolicy(), ids = Object.keys(resolved.bots).filter(id=>resolved.bots[id]!.enabled);
    state = { ...state, targets:ids.length };
    if (!qualified && ids.length) { await stopChild(); state = { ...state, state:"blocked", reason:"source-unavailable" }; return; }
    if (!ids.length || !scope) { await stopChild(); state = { ...state, state:"idle", reason:"no-qualified-bots" }; return; }
    const key = sha256Text(canonicalJson([scope,sourceIdentity,revision,ids.sort()]));
    if (active && activeKey !== key) await stopChild();
    if (!active) {
      await assertSafeDirectory(input.root); await assertSafeDirectory(join(input.root,"state"),true);
      gate = await acquireAdvisoryGate(join(input.root,"state","protection-worker.gate"));
      if (!gate) { state = { ...state, state:"blocked", reason:"competing-owner" }; return; }
      // The owner gate serializes first initialization as well as all lanes.
      await Effect.runPromise(continuityWorkflowPrograms({durableRoot:input.root,scopeId:scope}).initialize());
      activeSignal = new AbortController();
      const childSignal = AbortSignal.any([owner.signal,activeSignal.signal]);
      const context: NativeContinuityContext = { boxRuntimeRoot:input.root,env:input.env??{},fetch:input.fetch,signal:childSignal,
        gateway:()=>input.native!.continuityAccess(childSignal),ownershipRead:(ids,signal)=> {
          const gateway = input.native!.continuityAccess(AbortSignal.any([childSignal,signal]));
          return gateway.getAgentOwnership(ids,10000).then(reply=>({snapshot:reply.result,gateway:{pid:reply.discovery.pid,startedAt:reply.discovery.startedAt}}));
        } };
      const native = (tests.create ?? createNativeBotProtection)(context,scope,readPolicy);
      active = startBotProtectionWorker({durableRoot:input.root,scopeId:scope,native}, {
        observationMs:tests.observationMs??configured.intervalMs,advancementMs:tests.advancementMs??10000,handoverMs:tests.handoverMs??30000 });
      activeKey = key; state = { ...state,replacements:state.replacements+1 };
    }
    state = { ...state,state:"running",reason:state.discoveryCoverage==="capacity-limited"?"target-capacity":"active" };
  }
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(()=>local(async()=>{state={...state,state:"stopping"};await stopChild();state={...state,state:"stopped",reason:"stopped"};}).pipe(Effect.orDie));
    yield* Effect.forever(Effect.gen(function* () {
      // Cancellation of our own bounded discovery read is not a cleanup
      // failure. Settle it inside the uninterruptible read boundary; do not
      // swallow store errors or failures from the subsequent child finalizers.
      const result = yield* Effect.result(Effect.uninterruptible(Effect.tryPromise({try:tick,catch:error=>error}).pipe(Effect.catch(error=>
        owner.signal.aborted && (error===owner.signal.reason || error instanceof ManagementSourceError && error.code==="source_timeout")
          ? Effect.void : Effect.fail(error)))));
      if (result._tag === "Failure") {
        // Never let a corrupt store/config or another account leave an old
        // producer running. Source gaps are re-observed on the next bounded pass.
        yield* local(stopChild);
        const error = result.failure; qualified = false;
        state = { ...state,state:"blocked",reason:error instanceof Error&&error.message==="protection_identity_collision"?"target-identity-conflict":error instanceof ContinuityFailure ? error.code==="schema_mismatch"?"schema-mismatch":error.code==="scope_mismatch"?"scope-mismatch":"store-unavailable":"source-unavailable" };
      }
      yield* Effect.sleep(pollMs);
    }));
  }));
  const done = Effect.runPromiseExit(program,{signal:owner.signal});
  return { status: (): ProtectionServiceStatus => ({...state}), close: async () => {
    owner.abort(); activeSignal?.abort(); const exit = await done;
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw new Error("protection_service_cleanup_failed",{cause:Cause.squash(exit.cause)});
  } };
}
