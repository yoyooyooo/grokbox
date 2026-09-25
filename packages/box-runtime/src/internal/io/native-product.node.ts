import { ProductCallFailure, productCallFailure } from "./native-product-failure.node.ts";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { inspectOwnership, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import {
  NativeProductError, DuplicateDispatchRefused, productIntent, productObject, productPlan, duplicatePlan, duplicateSource, duplicateCreated,
  isContinuityUuid, discoverPeers, type ProductIntent, type ProductObject, type ProductSnapshot, type ProductPlan,
  type ProductOwnership, type ProductRelations, type NativeDuplicatePort, type DuplicateCreated,
} from "@grokbox/runtime-kernel/continuity";
import { projectNativeRoutines, NATIVE_ROUTINE_MAX_BYTES } from "@grokbox/runtime-kernel/routines";
import { readDesktopReap, type DesktopReapResult } from "./desktop.node.ts";

export type ProductRpc = "listAgents" | "getHostStatus" | "getAgentAutomations" | "getAgentTranscriptTail"
  | "createAgent" | "createGroup" | "updateAgent" | "deleteAgent" | "duplicateAgent" | "setGroupMembers"
  | "setAgentNotifyOnUpdates" | "setAgentHiddenFromSidebar";
export type ProductCall = (method: ProductRpc, input: Record<string, unknown>, signal: AbortSignal, timeoutMs: number,
  maxBytes: number, expectedGeneration?: string, beforeDispatch?: () => Promise<void>) => Promise<{ result: unknown; generation: string }>;
export type ProductNativeReceipt = { targetId: string; desktop: DesktopReapResult | null };
export type NativeProductAccess = ReturnType<typeof createNativeProductAccess>;
/** Constructed only at a local gate before the native transport starts. */
export class ProductDispatchRefused extends NativeProductError {
  constructor(code: "source_changed" | "permission_denied" | "source_unavailable") { super(code); }
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const unavailable = (): never => { throw new NativeProductError("source_unavailable"); };
const changed = (): never => { throw new NativeProductError("source_changed"); };
/** One authenticated native Gateway generation per operation, including its
 * credential digest. This is a bounded observation, not an account lock or CAS.
 * Callers cannot select an arbitrary RPC or supply a native credential. */
export function createNativeProductAccess(call: ProductCall, signal: AbortSignal, timeoutMs = 60000, authorizeWrite?: () => Promise<void>) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new NativeProductError("invalid_input");
  const deadline = performance.now() + timeoutMs;
  let generation: string | undefined, accountScope: string | undefined;
  let lastFailure: ProductCallFailure | null = null;
  let authorityClock: { observedAt: number; initialAge: number; tick: number } | undefined;
  const remaining = () => {
    signal.throwIfAborted();
    const left = Math.floor(deadline - performance.now());
    if (left < 1) return unavailable();
    return left;
  };
  const rpc = async (method: ProductRpc, body: Record<string, unknown>, maxBytes = 2 * 1024 * 1024) => {
    const writing = !["listAgents", "getHostStatus", "getAgentAutomations", "getAgentTranscriptTail"].includes(method);
    // Only the management driver supplies this capability. The transport calls
    // it after discovery, immediately before starting the one native request.
    if (writing && !authorizeWrite) throw new ProductDispatchRefused("permission_denied");
    const finalAuthorization = writing ? async () => {
      await authorizeWrite!(); signal.throwIfAborted();
      const clock = authorityClock, age = clock ? Date.now() - clock.observedAt : Infinity;
      const elapsed = clock ? performance.now() - clock.tick : Infinity;
      if (!clock || age < 0 || elapsed < 0 || Math.max(age, clock.initialAge + elapsed) > OWNERSHIP_EVIDENCE_MAX_AGE_MS)
        throw new ProductDispatchRefused("source_unavailable");
    } : undefined;
    const response = await call(method, body, signal, remaining(), maxBytes, generation, finalAuthorization).catch(error => {
      if (writing && !(error instanceof ProductDispatchRefused)) lastFailure = productCallFailure(error, method);
      throw error;
    });
    if (!/^[a-f0-9]{64}$/.test(response.generation)) return unavailable();
    if (generation !== undefined && generation !== response.generation) return changed();
    generation = response.generation;
    return response.result;
  };
  const roster = async (): Promise<ProductObject[]> => {
    const raw = await rpc("listAgents", {});
    if (!Array.isArray(raw) || raw.length > 4096) throw new NativeProductError("source_incomplete");
    const rows = raw.map(productObject).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new NativeProductError("source_incomplete");
    return rows;
  };
  const ownership = async (ids: string[]): Promise<ProductOwnership> => {
    if (ids.length < 1 || ids.length > 32 || ids.some(id => !isContinuityUuid(id)) || new Set(ids).size !== ids.length) throw new NativeProductError("invalid_input");
    const began = performance.now(), raw = await rpc("getHostStatus", { grokboxOwnershipAgentIds: ids }, 512 * 1024);
    if (!record(raw)) return unavailable();
    const proof = inspectOwnership({ agentIds: ids, snapshot: raw.grokboxOwnership });
    const at = Date.parse(proof.serverObservedAt ?? ""), now = Date.now();
    if (proof.serverRead.state !== "observed" || proof.scope?.stable !== true || !proof.scope.id
      || proof.localMigrationWindow !== "inactive" || !Number.isSafeInteger(at) || at > now || now - at > OWNERSHIP_EVIDENCE_MAX_AGE_MS
      || performance.now() - began > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return unavailable();
    if (accountScope !== undefined && accountScope !== proof.scope.id) return changed();
    accountScope = proof.scope.id;
    authorityClock = { observedAt: at, initialAge: now - at, tick: performance.now() };
    return { scopeId: proof.scope.id, sourceGeneration: generation!, observedAtMs: at,
      agents: proof.agents.map(row => ({ id: row.agentId, state: row.state, serverId: row.server?.serverId ?? null, viewerIsOwner: row.server?.viewerIsOwner ?? null })),
      coverage: "requested-native-registration", executionQualified: false };
  };
  const snapshot = async (probeId: string, targetId: string | null = null, requireOwnedBot = false): Promise<ProductSnapshot> => {
    // A creation's request UUID is only a scope probe. Its absent registration
    // is never reported as a Bot identity or permission over an existing Bot.
    const before = await ownership([targetId ?? probeId]);
    const objects = await roster();
    const proof = await ownership([targetId ?? probeId]);
    if (canonicalJson(before.agents) !== canonicalJson(proof.agents)) return changed();
    if (requireOwnedBot) {
      const target = proof.agents.find(row => row.id === targetId);
      if (!target || target.viewerIsOwner !== true || !["confirmed_box", "confirmed_temporal"].includes(target.state)) throw new NativeProductError("permission_denied");
    }
    return { objects, authority: { scopeId: proof.scopeId, generation: generation!, observedAtMs: proof.observedAtMs,
      identityRevision: sha256Text(canonicalJson(proof.agents)), permission: "native-authenticated-account", atomicCompareAndSet: false }, coverage: "current-native-roster" };
  };
  const routines = async (agentId: string) => projectNativeRoutines(agentId, await rpc("getAgentAutomations", { id: agentId }, NATIVE_ROUTINE_MAX_BYTES));
  const duplicate: NativeDuplicatePort = {
    inspectSource: async agentId => {
      const view = await snapshot(agentId, agentId, true), source = view.objects.find(row => row.id === agentId && row.kind === "bot");
      if (!source) throw new NativeProductError("not_found");
      const catalog = await routines(agentId), proof = await ownership([agentId]);
      const owned = proof.agents[0];
      if (!owned || owned.viewerIsOwner !== true || !["confirmed_box", "confirmed_temporal"].includes(owned.state)
        || proof.scopeId !== view.authority.scopeId || sha256Text(canonicalJson(proof.agents)) !== view.authority.identityRevision) return changed();
      return duplicateSource({ agentId, scopeId: proof.scopeId, generation: generation!,
        profileRevision: sha256Text(canonicalJson([source.profile, view.authority.identityRevision])),
        routineRevision: sha256Text(canonicalJson(catalog.routines.map(row => [row.id, row.revision]).sort())),
        harness: owned.state === "confirmed_box" ? "box" : "temporal", observedAtMs: proof.observedAtMs,
        returnedRoutines: catalog.routines.length, enabledRoutines: catalog.routines.filter(row => row.enabled).length, routineCoverage: "native_returned_window" });
    },
    duplicate: async (request, current) => {
      const age = Date.now() - current.observedAtMs;
      if (generation !== request.source.generation || current.generation !== generation) throw new DuplicateDispatchRefused("generation_changed");
      if (age < 0 || age > OWNERSHIP_EVIDENCE_MAX_AGE_MS) throw new DuplicateDispatchRefused("evidence_expired");
      const raw = await rpc("duplicateAgent", { id: request.source.agentId }).catch(error => {
        if (error instanceof ProductDispatchRefused) throw new DuplicateDispatchRefused(error.code === "permission_denied" ? "cancelled" : error.code === "source_unavailable" ? "evidence_expired" : "generation_changed");
        throw error;
      });
      if (!record(raw) || !record(raw.agent) || raw.agent.isGroup === true) return unavailable();
      return duplicateCreated({ version: 1, operationId: request.operationId, sourceAgentId: request.source.agentId,
        targetAgentId: raw.agent.id, scopeId: request.source.scopeId, generation: request.source.generation,
        receivedAtMs: Date.now(), evidence: "native_response" }, request);
    },
    inspectTarget: async (created: DuplicateCreated) => {
      const proof = await ownership([created.targetAgentId]), row = proof.agents[0];
      if (proof.scopeId !== created.scopeId || generation !== created.generation || !row) return { agentId: created.targetAgentId, state: "unconfirmed", readBack: false };
      return { agentId: created.targetAgentId, state: row.state, readBack: true };
    },
  };
  const preview = async (raw: ProductIntent): Promise<ProductPlan> => {
    const intent = productIntent(raw), view = await snapshot(intent.requestId, intent.targetId, intent.kind === "bot" && intent.targetId !== null);
    const duplicateRevision = intent.action === "duplicate" ? duplicatePlan(await duplicate.inspectSource(intent.targetId!)).revision : null;
    return productPlan(intent, view, duplicateRevision);
  };
  const dispatch = async (plan: ProductPlan, operationId: string): Promise<ProductNativeReceipt> => {
    const q = plan.intent;
    if (q.action === "duplicate") throw new NativeProductError("invalid_input"); // Original duplication owner only.
    let method: ProductRpc, input: Record<string, unknown>;
    if (q.action === "create") {
      method = q.kind === "bot" ? "createAgent" : "createGroup";
      input = q.kind === "bot" ? { ...plan.profileAfter, harness: q.harness, clientNonce: operationId,
        ...(q.deferStart ? { isIntroductionSuppressed: true, isKickstartRequested: false } : {}) }
        : { name: q.profile!.name, description: q.profile!.description ?? "", memberAgentIds: q.memberIds };
    } else if (q.action === "update") {
      method = "updateAgent"; input = { id: q.targetId, profile: plan.profileAfter! };
    } else if (q.action === "members") { method = "setGroupMembers"; input = { id: q.targetId, memberAgentIds: q.memberIds }; }
    else if (q.action === "hidden") { method = "setAgentHiddenFromSidebar"; input = { id: q.targetId, isHidden: q.value }; }
    else if (q.action === "notify") { method = "setAgentNotifyOnUpdates"; input = { id: q.targetId, isEnabled: q.value }; }
    else { method = "deleteAgent"; input = { id: q.targetId }; }
    // Re-read after durable admission. It narrows the race but cannot make the
    // official whole-object update compare-and-swap; the plan says so explicitly.
    let fresh: ProductPlan;
    try { fresh = await preview(q); }
    catch (error) { throw new ProductDispatchRefused(error instanceof NativeProductError && error.code === "permission_denied" ? "permission_denied" : "source_changed"); }
    if (fresh.revision !== plan.revision || fresh.scopeId !== plan.scopeId || generation !== plan.sourceGeneration) throw new ProductDispatchRefused("source_changed");
    const raw = await rpc(method, input);
    let targetId = q.targetId;
    if (q.action === "create") {
      if (!record(raw) || !record(raw.agent) || !isContinuityUuid(raw.agent.id) || raw.agent.isGroup === true !== (q.kind === "group"))
        throw new ProductCallFailure({ phase: "response-shape", code: "source_invalid", method, httpStatus: null },
          JSON.stringify({ rootType: typeof raw, rootKeys: record(raw) ? Object.keys(raw) : [],
            agentKeys: record(raw) && record(raw.agent) ? Object.keys(raw.agent) : [] }));
      targetId = raw.agent.id.toLowerCase();
    } else if (q.action === "delete" && (!record(raw) || !Array.isArray(raw.transcript))) return unavailable();
    if (!targetId) return unavailable();
    return { targetId, desktop: readDesktopReap(raw) ?? null };
  };
  const relations = async (botId: string): Promise<ProductRelations> => {
    const view = await snapshot(botId, botId, true);
    if (!view.objects.some(row => row.id === botId && row.kind === "bot")) throw new NativeProductError("not_found");
    const groups = view.objects.filter(row => row.kind === "group" && row.memberIds.includes(botId));
    let transcript: ProductRelations["transcript"] = { state: "unavailable", returnedEntries: 0, peerIds: [], inbound: [], coverage: "bounded-native-peer-fields", complete: false };
    let routineView: ProductRelations["routines"] = { state: "unavailable", items: [], coverage: "native-returned-window", complete: false };
    try {
      const tail = await rpc("getAgentTranscriptTail", { id: botId, limit: 200 }, 512 * 1024);
      if (record(tail) && Array.isArray(tail.entries) && tail.entries.length <= 200 && tail.entries.every(record)) {
        const entries = tail.entries as Record<string, unknown>[];
        const inbound = entries.flatMap(row => {
          const from = record(row.fromAgent) ? row.fromAgent.id : null, to = record(row.toAgent) ? row.toAgent.id : null;
          if (typeof row.id !== "string" || !row.id || row.id.length > 256 || !isContinuityUuid(from) || from === botId) return [];
          return [{ id: row.id, requestId: typeof row.requestId === "string" && row.requestId.length <= 256 ? row.requestId : null,
            fromBotId: from, toBotId: isContinuityUuid(to) ? to : null }];
        });
        transcript = { ...transcript, state: "observed", returnedEntries: entries.length, peerIds: discoverPeers(entries, botId).slice(0, 200), inbound };
      }
    } catch (error) { if (error instanceof NativeProductError && error.code === "source_changed") throw error; }
    try {
      const catalog = await routines(botId);
      routineView = { ...routineView, state: "observed", items: catalog.routines.map(row => ({ id: row.id, revision: row.revision, enabled: row.enabled, mutable: row.mutable })) };
    } catch (error) { if (error instanceof NativeProductError && error.code === "source_changed") throw error; }
    const finalIdentity = await ownership([botId]);
    if (sha256Text(canonicalJson(finalIdentity.agents)) !== view.authority.identityRevision) return changed();
    signal.throwIfAborted();
    return { botId, scopeId: view.authority.scopeId, sourceGeneration: generation!, observedAtMs: view.authority.observedAtMs,
      groups: groups.slice(0, 128).map(row => ({ id: row.id, memberIds: row.memberIds, revision: row.revision })), groupsTruncated: groups.length > 128,
      transcript, routines: routineView, currentRosterCoverage: "native-snapshot", externalTasksEnumerated: false };
  };
  return { snapshot, ownership, preview, dispatch, duplicate, routines, relations, failure: () => lastFailure,
    readBack: async (scopeId: string, targetId: string) => {
      const view = await snapshot(targetId, targetId);
      if (view.authority.scopeId !== scopeId) return changed();
      return view.objects.find(row => row.id === targetId) ?? null;
    },
  };
}
