import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createAlertObserver, HOST_ALERT_OBSERVATION_SYMBOL } from "../src/internal/host/alert-observation.ts";
import { ALERT_OBSERVATION_SLICES } from "../src/internal/host/alert-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import type { AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";

// Independent minimal interop fixture, not a copy of the private Host bundle.
// Only integration anchors resemble native syntax; all collaborators are fakes.
const SOURCE = `
function applySendRosterSideEffects(tm, session, trimmedPrompt, readAddressedTranscript) {
  tm.sideEffects++;
  tm.trayErrors.clearForAgent(session.id);
  return readAddressedTranscript(trimmedPrompt);
}
var traysExtension = defineHostExtension({
  start: () => {
    const trays = new TrayManager();
    return { clearForAgent: (agentId) => trays.clearForAgent(agentId), manager: trays };
  }
});
class Runner {
  constructor(tm) { this.tm = tm; this.cleaned = 0; this.automationFailureOccurrences = new Map(); }
  forgetTemplateSetupWriteHints() { this.cleaned++; }
  async run(session, epoch, options2, fault) {
    const turnTrace = {}, turnMessageIds = [];
    try { throw fault; }
    catch (error41) {
        markTurnTraceError(turnTrace, error41);
        if (epoch === this.tm.sendPipeline.currentTurnEpoch(session)) {
          const description7 = describeAgentRunError(error41);
          const requestId2 = session.db.getRequestIds().at(-1)?.id;
          this.tm.trayErrors.pushError({
            agentId: session.id,
            requestId: requestId2,
            ...description7,
            ...hostTrayTitle({ kind: turnTrayTitleKind(description7.errorKind), description: description7 })
          });
        }
        await this.tm.roster.emitAgentUpdate(session.id);
      } finally {
        this.forgetTemplateSetupWriteHints(session.id, turnMessageIds);
      }
  }
  notifyAutomationFailure(session, automation, trigger2, description7) {
    if (isBackgroundAutomationTrigger(trigger2)) return;
    const occurrence = trigger2;
    if (!shouldNotifyAutomationFailure(occurrence)) return;
    this.tm.trayErrors.pushError({agentId: session.id, ...description7});
  }
  clearAutomationFailureState(agentId, automationId) { return undefined; }
}
({ Runner, traysExtension, applySendRosterSideEffects });
`;
class FakeManager {
  values:any[]=[]; listeners:any[]=[]; count=0;
  getTrays(){return this.values;}
  emit(event:any){this.listeners.push(event);}
  pushError(value:any){const tray={...value,kind:"error",id:"tray-"+(++this.count)};this.values.push(tray);this.emit({type:"pushed",tray});return tray;}
  clearForAgent(agentId:string){for(const tray of [...this.values])if(tray.agentId===agentId){this.values=this.values.filter(t=>t!==tray);this.emit({type:"dismissed",id:tray.id});}}
}
function fixture(instrumented:boolean){
 const events:AlertObservationEvent[]=[];const observer=createAlertObserver({generation:"host",emit:e=>events.push(e)});
 const global:Record<string|symbol,unknown>={TrayManager:FakeManager,defineHostExtension:(x:any)=>x,markTurnTraceError:()=>undefined,
 describeAgentRunError:()=>({errorKind:"unknown_failure"}),hostTrayTitle:()=>({titleKind:"botFailedToReply"}),turnTrayTitleKind:()=>"botFailedToReply",
 isBackgroundAutomationTrigger:(x:any)=>x==="background",shouldNotifyAutomationFailure:(n:number)=>n===1};
 if(instrumented)global[Symbol.for(HOST_ALERT_OBSERVATION_SYMBOL)]=observer;
 const transformed=transformUnchecked(SOURCE,ALERT_OBSERVATION_SLICES);expect(transformed.ok).toBe(true);if(!transformed.ok)throw Error(JSON.stringify(transformed));
 const api=runInNewContext(transformed.source,global);const manager=api.traysExtension.start().manager;
 let epochReads=0;const tm={trayErrors:manager,sideEffects:0,sendPipeline:{currentTurnEpoch:()=>{epochReads++;return 1;}},roster:{emitAgentUpdate:async()=>undefined}};
 return {events,observer,api,manager,tm,runner:new api.Runner(tm),epochReads:()=>epochReads};
}
for(const instrumented of [false,true])test(`patched native decisions preserve exact branch semantics (observer=${instrumented})`,async()=>{
 const f=fixture(instrumented),session={id:"agent",db:{getRequestIds:()=>[{id:"native-request"}]}};
 await f.runner.run(session,1,{clientNonce:"nonce"},Error("synthetic"));expect(f.manager.values).toHaveLength(1);expect(f.runner.cleaned).toBe(1);expect(f.epochReads()).toBe(1);
 await f.runner.run(session,0,{},Error("old"));expect(f.manager.values).toHaveLength(1);expect(f.runner.cleaned).toBe(2);expect(f.epochReads()).toBe(2);
 const result=f.api.applySendRosterSideEffects(f.tm,session,"hello",(x:string)=>x+"-result");expect(result).toBe("hello-result");expect(f.tm.sideEffects).toBe(1);expect(f.manager.values).toHaveLength(0);
 if(instrumented){expect(f.events.filter(e=>e.kind==="decision").map(e=>e.decision)).toEqual(["emit","suppress"]);expect(f.events.find(e=>e.kind==="tray_removed")?.removalReason).toBe("new_input_cleanup");}
});
test("automation suppression is observed without replacing native throttle or executing extra alerts",()=>{
 const f=fixture(true),session={id:"agent"};for(const trigger of ["background",2,1])f.runner.notifyAutomationFailure(session,{},trigger,{});
 expect(f.manager.values).toHaveLength(1);expect(f.events.filter(e=>e.decision==="suppress").map(e=>e.reason)).toEqual(["background_automation","native_rate_limit"]);
});
test("observation slices reject drift instead of installing partial/wildcard hooks",()=>{
 const bad=SOURCE.replace("const trays = new TrayManager();","const trays = new DifferentManager();");
 expect(transformUnchecked(bad,ALERT_OBSERVATION_SLICES)).toMatchObject({ok:false,code:"find-missing",sliceId:"alert-manager-observation"});
});
