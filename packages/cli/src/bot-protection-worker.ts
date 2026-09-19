import { openConfigStore,rootConfigLayout,startPolicyBoundBotProtection } from "@grokbox/box-runtime/runtime";
import { continuityProtection,isContinuityHash } from "@grokbox/runtime-kernel/continuity";
import { GatewayClient } from "./gateway.ts";
import { createGatewayBotProtection } from "./gateway-bot-protection.ts";
import type { CliDeps } from "./deps.ts";

/** Composition only. The runtime owns fibers, cancellation and actual callback
 * settlement. Disabled config has no native access or CONT initialization. */
export function startGatewayBotProtection(deps:CliDeps){
  let scopeId:string|null=null;
  return startPolicyBoundBotProtection({durableRoot:deps.boxRuntimeRoot,
    read:async()=>{
      const config=continuityProtection((await openConfigStore(rootConfigLayout(deps.boxRuntimeRoot)).read()).document.runtime?.continuity);
      const ids=Object.keys(config.bots).filter(id=>config.bots[id]!.enabled);
      if(!config.enabled||!ids.length)return {enabled:false,scopeId:null};
      if(scopeId!==null)return {enabled:true,scopeId};
      const observed=(await new GatewayClient({...deps,transport:"local"}).getAgentOwnership(ids.slice(0,16),15000)).result as any;
      if(observed?.scope?.stable===true&&isContinuityHash(observed.scope.id))scopeId=observed.scope.id;
      return {enabled:true,scopeId};
    },
    create:id=>createGatewayBotProtection(deps,id),
  });
}
