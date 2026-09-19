import { openBotConvergence,openContinuityControls,type BotConvergencePort } from "@grokbox/box-runtime/runtime";
import { CurrentStateFailure,type BotWorkflowRequest } from "@grokbox/runtime-kernel/continuity";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { sha256Text,canonicalJson } from "@grokbox/runtime-kernel/hash";
import { createGatewayBotHandover } from "./gateway-bot-handover.ts";
import { GatewayClient } from "./gateway.ts";
import type { CliDeps } from "./deps.ts";

export function createGatewayBotConvergence(deps:CliDeps,scopeId:string,authorized?:(request:BotWorkflowRequest)=>Promise<boolean>){
  const gateway=new GatewayClient({...deps,transport:"local"}),controls=openContinuityControls({durableRoot:deps.boxRuntimeRoot,scopeId});
  const relations=createGatewayBotHandover(deps,scopeId,30000,authorized);
  const native:BotConvergencePort={authorize:relations.port.authorize,
    observe:async(request,targetId,previous)=>{
      const at=Date.now(),view=await relations.tail(request.sourceId!),entries=view.entries as any[];
      const last=entries.at(-1)?.id;
      const prior=typeof previous?.lastEntryId==="string"?previous.lastEntryId:null;
      const index=prior===null?-1:entries.findIndex(e=>e.id===prior);
      const contiguous=prior===null?view.hasMore===false:index>=0;
      const tail=prior===null?entries:index>=0?entries.slice(index+1):entries;
      const newMessages=tail.filter(e=>e.kind==="message"&&e.role==="user"&&!e.continuitySource
        &&!(typeof e.content==="string"&&e.content.includes("[grokbox-handoff:"))).length;
      const proof=(await gateway.getAgentOwnership([targetId],15000)).result;
      const target=decideManagedOwnership({agentId:targetId,snapshot:proof,nowMs:Date.now()});
      const items=await controls.items(request.operationId);
      const external=items.filter(i=>i.kind==="external-task"),dependenciesVerified=external.length>0&&external.every(i=>i.state==="complete");
      // A bounded transcript without an attachment is not proof that no blob,
      // file or shared dependency points into the old Bot's directory.
      const resourcesIndependent=false;
      return {cursor:typeof last==="string"?sha256Text(last):null,observedAtMs:Math.max(at,Date.now()),newMessages,contiguous,
        state:{lastEntryId:typeof last==="string"?last:prior,sourceWindowHash:sha256Text(canonicalJson(entries.map(e=>[e.id,e.timestampMs]))),scope:"native_default_window"},
        targetUsable:target.ok&&(proof as any)?.scope?.id===scopeId,dependenciesVerified,resourcesIndependent,
        // The public delete endpoint has no compare-and-delete/ingress drain
        // token. Absence of traffic cannot synthesize that atomic boundary.
        deletionFenceAvailable:false};
    },
    delete:async()=>{throw new CurrentStateFailure("native_unavailable");},
  };
  return {program:openBotConvergence({durableRoot:deps.boxRuntimeRoot,scopeId,native}),native};
}
