import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openContinuityControls } from "./continuity-control.runtime.ts";
import { openContinuityObservationBridge } from "./continuity-integration.runtime.ts";
import type { BotProtectionPort } from "./bot-protection.runtime.ts";
import { continuityProtection, protectionRevision, continuityId, botWorkflowRequest,
  isContinuityHash, isContinuityUuid, CurrentStateFailure, type BotWorkflowRequest, type ContinuityProtection } from "@grokbox/runtime-kernel/continuity";
import { continuitySourceKey } from "@grokbox/runtime-kernel/observation";
import { inspectOwnership, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createNativeBotLifecycle } from "./continuity-native-lifecycle.runtime.ts";
import { createNativeBotHandover } from "./continuity-native-handover.runtime.ts";
import { createNativeBotConvergence } from "./continuity-native-convergence.runtime.ts";
import { botProfileRevision } from "../io/continuity-material.node.ts";
import type { NativeContinuityContext } from "../io/continuity-gateway.node.ts";

/** Conflict alone is not loss. Only a stable, owned Server-temporal identity
 * with matching local ID can trigger protective effects. Other conflicts,
 * migration windows, unknown accounts and stale observations remain gaps. */
export function protectiveOwnership(ids: readonly string[], snapshot: unknown, scopeId: string, now = Date.now()) {
  const projected = inspectOwnership({ agentIds: [...ids], snapshot });
  const atMs = Date.parse(projected.serverObservedAt ?? "");
  const fresh = projected.scope?.stable === true && projected.scope.id === scopeId && projected.localMigrationWindow === "inactive"
    && Number.isSafeInteger(atMs) && now >= atMs && now - atMs <= 5000;
  return new Map(projected.agents.map(row => {
    let state: "box" | "temporal" | "conflict" | "gap" = "gap";
    if (fresh && row.server?.viewerIsOwner === true && row.server.agentId === row.agentId) {
      if (row.state === "confirmed_box") state = "box";
      else if (row.state === "confirmed_temporal") state = "temporal";
      else if (row.state === "conflict" && row.server.harness === "temporal" && row.server.serverId === row.local.before.serverId
        && row.reasons.every(reason => reason === "harness_mismatch")) state = "conflict";
    }
    return [row.agentId, { state, scopeId, atMs: fresh ? atMs : now }] as const;
  }));
}

/** The same native composition is used by the Server and legacy internal
 * lifecycle consumers; no CLI process or CLI dependency runs in the Server. */
export function createNativeBotProtection(deps: NativeContinuityContext, scopeId: string, readPolicy?: () => Promise<ContinuityProtection>): BotProtectionPort {
  if (!isContinuityHash(scopeId)) throw new CurrentStateFailure("invalid_request");
  const gateway = deps.gateway(), controls = openContinuityControls({ durableRoot: deps.boxRuntimeRoot, scopeId });
  const policy = readPolicy ?? (async () => continuityProtection((await openConfigStore(rootConfigLayout(deps.boxRuntimeRoot)).read()).document.runtime?.continuity));
  const authorized = async (request: BotWorkflowRequest) => {
    deps.signal?.throwIfAborted();
    // A manual operation retains its original management principal. Background
    // protection policy is not delegated authority for that principal's work.
    if (request.management) return false;
    const config = await policy(); if (!config.enabled) return false;
    for (const [id,p] of Object.entries(config.bots)) if (p.enabled && protectionRevision(id,p) === request.policyRevision) {
      const state = await controls.subject(id); if (!state) return false;
      if (state.currentId === request.sourceId || state.currentId === (await controls.workflow(request.operationId)).targetId || state.data.previousIds?.includes(request.sourceId)) return true;
    }
    return false;
  };
  const handover = async (operationId: string) => {
    const progress = await createNativeBotHandover(deps,scopeId,30000,authorized).program.advance(operationId,16,deps.signal);
    const convergence = await createNativeBotConvergence(deps,scopeId,authorized).program.observe(operationId,deps.signal);
    return {...progress,convergence};
  };
  const lifecycle = createNativeBotLifecycle(deps,{timeoutMs:180000,authorizePolicy:authorized,handover:request=>handover(request.operationId)});
  return { policy, lifecycle: lifecycle.native, handover,
    observe: async ids => protectiveOwnership(ids,(await gateway.getAgentOwnership([...ids],15000)).result,scopeId),
    pause: async (agentId,lossId,selected,logicalId) => {
      const loss = continuityId(lossId,"routine-intents"); let record = await controls.read(loss);
      if (!record) {
        const raw = (await gateway.rpc("getAgentAutomations",{id:agentId},{timeoutMs:15000,maxResponseBytes:512*1024})).result;
        const view = projectNativeRoutines(agentId,raw);
        await controls.reserve(loss,agentId,"loss-routine-intents",{routines:view.routines.map(r=>({id:r.id,enabled:r.enabled,definitionRevision:r.definitionRevision,mutable:r.mutable})),atLimit:view.coverage.atLimit});
        record = await controls.read(loss);
      }
      if (!record || !Array.isArray(record.request.routines)) throw new CurrentStateFailure("material_invalid");
      let remaining = 0, failed = 0, inspected = 0;
      for (const item of record.request.routines) {
        deps.signal?.throwIfAborted(); if (!item.enabled) continue;
        const operationId = continuityId(lossId,`pause:${item.id}`), prior = await controls.read(operationId);
        if (prior?.state === "complete") continue;
        if (inspected++ >= 8) { remaining++; continue; }
        await controls.reserve(operationId,agentId,"loss-routine-pause",item);
        const op = await controls.read(operationId);
        const raw = (await gateway.rpc("getAgentAutomations",{id:agentId},{timeoutMs:15000,maxResponseBytes:512*1024})).result;
        const current = projectNativeRoutines(agentId,raw).routines.find(r=>r.id===item.id);
        if (!current || current.definitionRevision !== item.definitionRevision || !current.mutable) { failed++; continue; }
        if (!current.enabled) {
          if (op) await controls.transition(operationId,op.state,"complete",{state:"disabled_observed",routineId:current.id,revision:current.revision,originalEnabled:true});
          continue;
        }
        if (op?.state !== "prepared") { remaining++; continue; }
        const proof = protectiveOwnership([agentId],(await gateway.getAgentOwnership([agentId],15000)).result,scopeId).get(agentId);
        const config = await policy(), effective = config.bots[logicalId], subject = await controls.subject(logicalId);
        if (!proof || !["temporal","conflict"].includes(proof.state) || !config.enabled || !effective?.enabled || !effective.pauseOnOwnershipLoss
          || canonicalJson(effective) !== canonicalJson(selected) || subject?.currentId !== agentId || subject.data.lossId !== lossId) { remaining++; continue; }
        deps.signal?.throwIfAborted();
        await controls.transition(operationId,"prepared","effect_unknown",null);
        try {
          const result = (await gateway.agentRoutines({action:"disable",agentId,routineId:current.id,expectedRevision:current.revision,operationId,confirmed:true},15000)).result as any;
          await controls.transition(operationId,"effect_unknown","complete",{state:result.state,routineId:current.id,revision:result.afterRevision,originalEnabled:true});
        } catch { remaining++; }
      }
      return {complete:remaining===0 && failed===0 && !record.request.atLimit,remaining,failed};
    },
    notify: async (logicalId,agentId,event) => {
      // Numbered events are a new source stream, not a reinterpretation of old
      // timestamp-as-sequence evidence. A retained unnumbered event keeps its
      // original source and payload so an uncertain export is not rewritten.
      const source = {scopeId,source:"ownership" as const,generation:`${event.sequence===undefined?"protection":"protection-events-v2"}-${logicalId}`}, sourceKey = continuitySourceKey(source);
      const bridge = openContinuityObservationBridge({durableRoot:deps.boxRuntimeRoot,source});
      const snapshot = await openMonitorStore(deps.boxRuntimeRoot).snapshot().catch(()=>null);
      if (!snapshot?.collectorEpoch || !snapshot.collectorRecordedRunning) return false;
      const prior = await bridge.cursor(); if (prior.state !== "observed") return false;
      const cursor = prior.value?.cursor ?? null; if (cursor === event.id) return true;
      const result = await bridge.publish({collectorEpoch:snapshot.collectorEpoch,expectedCursor:cursor,nextCursor:event.id,atMs:Date.now(),events:[{
        name:"continuity_observation",schemaVersion:1,at:new Date(event.atMs).toISOString(),...source,sourceInstanceId:sourceKey,
        eventId:event.id,sourceSequence:event.sequence??event.atMs,agentId,occurrenceId:event.id,kind:event.kind,
        coverage:{state:event.kind==="source_gap"?"gap":"observed",fromAtMs:event.atMs,throughAtMs:event.atMs,gapCodes:event.kind==="source_gap"?["unavailable"]:[]},inboundCount:null,evidenceRefs:[],
      }]});
      return result.committed === true;
    },
    capture: async (logicalId,agentId,operationId,p) => {
      deps.signal?.throwIfAborted();
      const config = await policy();
      if (!config.enabled || !config.bots[logicalId]?.enabled || protectionRevision(logicalId,config.bots[logicalId]!) !== protectionRevision(logicalId,p)) throw new CurrentStateFailure("policy_changed");
      const proof = protectiveOwnership([agentId],(await gateway.getAgentOwnership([agentId],15000)).result,scopeId).get(agentId);
      if (proof?.state !== "box") throw new CurrentStateFailure("ownership_unconfirmed");
      const caps = await lifecycle.capabilities(agentId); if (caps.scopeId !== scopeId) throw new CurrentStateFailure("source_changed");
      const profile = await lifecycle.profile(agentId), model = await lifecycle.selected(agentId);
      const request = botWorkflowRequest({version:1,operationId,scopeId,kind:"clone",sourceId:agentId,profile,...model,instructions:"",snapshotId:null,
        activate:false,start:false,maxRunMs:180000,policyRevision:protectionRevision(logicalId,p)});
      const result = p.tier === "memory" ? await lifecycle.captureMemory(request,operationId) : await lifecycle.native.capture(request,operationId);
      if (!isContinuityUuid(result?.snapshotId)) throw new CurrentStateFailure("material_invalid");
      return {snapshotId:result.snapshotId};
    },
    request: async (logicalId,agentId,operationId,snapshotId,p) => {
      const current = protectiveOwnership([agentId],(await gateway.getAgentOwnership([agentId],15000)).result,scopeId).get(agentId);
      if (!current || !["temporal","conflict"].includes(current.state)) throw new CurrentStateFailure("ownership_unconfirmed");
      await lifecycle.capabilities(agentId);
      const profile = await lifecycle.profile(agentId), model = await lifecycle.selected(agentId);
      const previous = await controls.read(continuityId((await controls.subject(logicalId))?.data.lossId??operationId,"routine-intents"));
      return botWorkflowRequest({version:1,operationId,scopeId,kind:p.mode==="prepare"?"clone":"replace",sourceId:agentId,
        profile:{...profile,name:`${profile.name} · 继任`,title:parseAgentTitle(profile.title).user},...model,instructions:"",snapshotId,
        activate:p.mode==="auto-replace",start:false,maxRunMs:180000,policyRevision:protectionRevision(logicalId,p),handover:p.handover,
        sourceRevision:botProfileRevision(profile),...(previous?{routineIntent:previous.request.routines}:{})});
    },
  };
}
