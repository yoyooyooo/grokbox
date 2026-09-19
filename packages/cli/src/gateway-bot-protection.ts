import { openConfigStore, rootConfigLayout, openContinuityControls, openContinuityRecoveryStore, openMonitorStore,
  openContinuityObservationBridge, type BotProtectionPort } from "@grokbox/box-runtime/runtime";
import { continuityProtection, protectionRevision, continuityId, botWorkflowRequest, readBotSupplement, materialFromBotSupplement,
  isContinuityHash, isContinuityUuid, CurrentStateFailure, ContinuityFailure, type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { continuitySourceKey } from "@grokbox/runtime-kernel/observation";
import { inspectOwnership, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { projectNativeRoutines } from "@grokbox/runtime-kernel/routines";
import { sha256Text, canonicalJson } from "@grokbox/runtime-kernel/hash";
import type { CliDeps } from "./deps.ts";
import { GatewayClient } from "./gateway.ts";
import { createGatewayBotLifecycle } from "./gateway-bot-lifecycle.ts";
import { createGatewayBotHandover } from "./gateway-bot-handover.ts";
import { createGatewayBotConvergence } from "./gateway-bot-convergence.ts";
import { botProfileRevision } from "./gateway-bot-material.ts";

/** Bound to one existing account scope. Config controls permissions, not names
 * or titles. All unknown effects are recorded in the shared private CONT store. */
export function createGatewayBotProtection(deps:CliDeps,scopeId:string):BotProtectionPort {
  if(!isContinuityHash(scopeId))throw new CurrentStateFailure("invalid_request");
  const gateway=new GatewayClient({...deps,transport:"local"}),controls=openContinuityControls({durableRoot:deps.boxRuntimeRoot,scopeId});
  const policy=async()=>continuityProtection((await openConfigStore(rootConfigLayout(deps.boxRuntimeRoot)).read()).document.runtime?.continuity);
  const authorized=async(request:BotWorkflowRequest)=>{
    const config=await policy();if(!config.enabled)return false;
    for(const [id,p] of Object.entries(config.bots))if(p.enabled&&protectionRevision(id,p)===request.policyRevision){
      const state=await controls.subject(id);
      if(!state)return false;
      if(state.currentId===request.sourceId||state.currentId===(await controls.workflow(request.operationId)).targetId||state.data.previousIds?.includes(request.sourceId))return true;
    }
    return false;
  };
  const handover=async(operationId:string)=>{
    const progress=await createGatewayBotHandover(deps,scopeId,30000,authorized).program.advance(operationId,16,deps.signal);
    const convergence=await createGatewayBotConvergence(deps,scopeId,authorized).program.observe(operationId,deps.signal);
    return {...progress,convergence};
  };
  const lifecycle=createGatewayBotLifecycle(deps,{timeoutMs:180000,authorizePolicy:authorized,handover:(request)=>handover(request.operationId)});
  const native:BotProtectionPort={policy,lifecycle:lifecycle.native,handover,
    observe:async ids=>{
      const response=await gateway.getAgentOwnership([...ids],15000),snapshot=response.result as any;
      const projected=inspectOwnership({agentIds:[...ids],snapshot}),at=Date.parse(projected.serverObservedAt??"");
      const result=new Map();
      for(const row of projected.agents){
        const state=row.state==="confirmed_box"?"box":row.state==="confirmed_temporal"?"temporal":row.state==="conflict"?"conflict":"gap";
        result.set(row.agentId,{state,scopeId:projected.scope?.id??"",atMs:at});
      }
      return result;
    },
    pause:async(agentId,lossId,selected,logicalId)=>{
      const loss=continuityId(lossId,"routine-intents");
      let record=await controls.read(loss);
      if(!record){
        const raw=(await gateway.rpc("getAgentAutomations",{id:agentId},{timeoutMs:15000,maxResponseBytes:512*1024})).result;
        const view=projectNativeRoutines(agentId,raw);
        const intents=view.routines.map(r=>({id:r.id,enabled:r.enabled,definitionRevision:r.definitionRevision,mutable:r.mutable}));
        await controls.reserve(loss,agentId,"loss-routine-intents",{routines:intents,atLimit:view.coverage.atLimit});
        record=await controls.read(loss);
      }
      if(!record||!Array.isArray(record.request.routines))throw new CurrentStateFailure("material_invalid");
      let remaining=0,failed=0;
      for(const item of record.request.routines){
        if(!item.enabled)continue;
        const operationId=continuityId(lossId,`pause:${item.id}`);
        await controls.reserve(operationId,agentId,"loss-routine-pause",item);
        const op=await controls.read(operationId);if(op?.state==="complete")continue;
        const raw=(await gateway.rpc("getAgentAutomations",{id:agentId},{timeoutMs:15000,maxResponseBytes:512*1024})).result;
        const current=projectNativeRoutines(agentId,raw).routines.find(r=>r.id===item.id);
        if(!current||current.definitionRevision!==item.definitionRevision||!current.mutable){failed++;continue;}
        if(!current.enabled){if(op)await controls.transition(operationId,op.state,"complete",{state:"disabled_observed",routineId:current.id,revision:current.revision,originalEnabled:true});continue;}
        if(op?.state!=="prepared"){remaining++;continue;}
        // A changed policy may stop unstarted effects, but cannot erase prior
        // disable receipts or turn a missing receipt into permission to retry.
        const config=await policy(),effective=config.bots[logicalId],subject=await controls.subject(logicalId);
        if(!config.enabled||!effective?.enabled||!effective.pauseOnOwnershipLoss||canonicalJson(effective)!==canonicalJson(selected)
          ||subject?.currentId!==agentId||subject.data.lossId!==lossId){remaining++;continue;}
        const proof=(await gateway.getAgentOwnership([agentId],15000)).result as any;
        const at=Date.parse(proof?.serverObservedAt??"");
        if(proof?.scope?.id!==scopeId||proof.scope.stable!==true||!Number.isFinite(at)||Date.now()<at||Date.now()-at>5000){remaining++;continue;}
        await controls.transition(operationId,"prepared","effect_unknown",null);
        try{
          const result=await gateway.agentRoutines({action:"disable",agentId,routineId:current.id,expectedRevision:current.revision,operationId,confirmed:true},15000);
          const proof=result.result as any;
          await controls.transition(operationId,"effect_unknown","complete",{state:proof.state,routineId:current.id,revision:proof.afterRevision,originalEnabled:true});
        }catch{remaining++;}
      }
      return {complete:remaining===0&&failed===0&&!record.request.atLimit,remaining,failed};
    },
    notify:async(logicalId,agentId,event)=>{
      const source={scopeId,source:"ownership" as const,generation:`protection-${logicalId}`},sourceKey=continuitySourceKey(source);
      const bridge=openContinuityObservationBridge({durableRoot:deps.boxRuntimeRoot,source});
      const snapshot=await openMonitorStore(deps.boxRuntimeRoot).snapshot().catch(()=>null);
      if(!snapshot?.collectorEpoch||!snapshot.collectorRecordedRunning)return false;
      const prior=await bridge.cursor();if(prior.state!=="observed")return false;
      const cursor=prior.value?.cursor??null;if(cursor===event.id)return true;
      const result=await bridge.publish({collectorEpoch:snapshot.collectorEpoch,expectedCursor:cursor,nextCursor:event.id,atMs:Date.now(),events:[{
        name:"continuity_observation",schemaVersion:1,at:new Date(event.atMs).toISOString(),...source,sourceInstanceId:sourceKey,
        eventId:event.id,sourceSequence:event.atMs,agentId,occurrenceId:event.id,kind:event.kind,
        coverage:{state:event.kind==="source_gap"?"gap":"observed",fromAtMs:event.atMs,throughAtMs:event.atMs,gapCodes:event.kind==="source_gap"?["unavailable"]:[]},
        inboundCount:null,evidenceRefs:[],
      }]});
      return result.committed===true;
    },
    capture:async(logicalId,agentId,operationId,p)=>{
      const caps=await lifecycle.capabilities(agentId);if(caps.scopeId!==scopeId)throw new CurrentStateFailure("source_changed");
      const profile=await lifecycle.profile(agentId),model=await lifecycle.selected(agentId);
      const request=botWorkflowRequest({version:1,operationId,scopeId,kind:"clone",sourceId:agentId,profile,...model,instructions:"",snapshotId:null,
        activate:false,start:false,maxRunMs:180000,policyRevision:protectionRevision(logicalId,p)});
      // Memory tier reads only formal Memory/transcript surfaces; it never
      // captures a large native root just to discard it. Archive versions are
      // protected by the subject's bounded eight-reference ring.
      const result=p.tier==="memory"?await lifecycle.captureMemory(request,operationId):await lifecycle.native.capture(request,operationId);
      if(!isContinuityUuid(result?.snapshotId))throw new CurrentStateFailure("material_invalid");
      return {snapshotId:result.snapshotId};
    },
    request:async(logicalId,agentId,operationId,snapshotId,p)=>{
      await lifecycle.capabilities(agentId);
      const profile=await lifecycle.profile(agentId),model=await lifecycle.selected(agentId);
      const previous=await controls.read(continuityId((await controls.subject(logicalId))?.data.lossId??operationId,"routine-intents"));
      return botWorkflowRequest({version:1,operationId,scopeId,kind:p.mode==="prepare"?"clone":"replace",sourceId:agentId,
        profile:{...profile,name:`${profile.name} · 继任`,title:parseAgentTitle(profile.title).user},...model,instructions:"",snapshotId,
        activate:p.mode==="auto-replace",start:false,maxRunMs:180000,policyRevision:protectionRevision(logicalId,p),handover:p.handover,
        // Source may have later Temporal activity; snapshot remains the reliable
        // captured point. Incremental formal reads are separately attributed.
        sourceRevision:botProfileRevision(profile),
        ...(previous?{routineIntent:previous.request.routines}:{}),
      });
    },
  };
  return native;
}
