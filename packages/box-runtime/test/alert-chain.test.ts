import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { hostVisibleStreamError } from "../src/internal/host/session.ts";
import { projectAlertEvent, traceAlerts, classifyAlert, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { observeEvents } from "../src/internal/io/journal.node.ts";
class NativeTrayFake {
  trays: any[]=[]; emitted:any[]=[]; throws=false;
  getTrays(){return this.trays;}
  emit(event:any){this.emitted.push(event);if(this.throws)throw Error("native-listener-failure");}
  pushError(value:any){const existing=this.trays.find(t=>t.id===value.id);const tray={...value,kind:"error",count:(existing?.count??0)+1};this.trays=this.trays.filter(t=>t.id!==value.id).concat(tray);this.emit({type:"pushed",tray});return tray;}
  dismiss(id:string){if(!this.trays.some(t=>t.id===id))return false;this.trays=this.trays.filter(t=>t.id!==id);this.emit({type:"dismissed",id});return true;}
  clearAll(){if(!this.trays.length)return;this.trays=[];this.emit({type:"cleared"});}
  clearForAgent(agentId:string){for(const t of [...this.trays])if(t.agentId===agentId)this.dismiss(t.id);}
  enforceCap(){if(this.trays.length>2)this.dismiss(this.trays[0].id);}
}
const fixture=()=>{const events:AlertObservationEvent[]=[];const observer=createAlertObserver({generation:"host-a",emit:e=>events.push(e)});const native=new NativeTrayFake();observer.attachManager(native);return {events,observer,native};};
test("native creation, dedupe, publication and cleanup are distinct, with direct failure linkage",()=>{
 const f=fixture();const error=hostVisibleStreamError({failureId:"failure-a",agentId:"agent-a",invocationId:"step-a",code:"parallel_tools",message:"PRIVATE_SENTINEL",userVisible:true});
 const input={id:"tray-a",agentId:"agent-a",requestId:"native-request",detail:"PRIVATE_SENTINEL",actions:[{url:"https://secret.invalid"}]};
 const result=f.observer.decision(new Error("wrapped",{cause:error}),{agentId:"agent-a",clientNonce:"nonce-a"},true,()=>f.native.pushError(input));
 expect(result.detail).toBe("PRIVATE_SENTINEL");
 f.native.pushError(input);f.observer.withRemovalReason("new_input_cleanup",()=>f.native.clearForAgent("agent-a"));
 expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE_SENTINEL|secret.invalid/);
 expect(f.events.filter(e=>e.kind==="tray_created")).toHaveLength(1);expect(f.events.filter(e=>e.kind==="tray_updated")).toHaveLength(1);
 expect(f.events.find(e=>e.kind==="tray_created")).toMatchObject({stepId:"step-a",failureId:"failure-a",stepEvidence:"direct",classificationEvidence:"direct"});
 expect(f.events.find(e=>e.kind==="tray_removed")).toMatchObject({removalReason:"new_input_cleanup",actor:"unknown"});
 const trace=traceAlerts(f.events,{trayId:"tray-a"},{complete:true});expect(trace.traces[0].trays[0]).toMatchObject({hostState:"removed_observed",appRendered:"not_observed",userRead:"not_proven"});
 expect(f.events.map(e=>e.sourceSequence)).toEqual(f.events.map((_,i)=>i));
});
test("stale-run suppression is a decision, not a fabricated Tray",()=>{
 const f=fixture();let called=0;const result=f.observer.decision({}, {agentId:"a"},false,()=>{called++;return 7;});
 expect(result).toBe(7);expect(called).toBe(1);expect(f.events.filter(e=>e.kind==="decision")).toMatchObject([{decision:"suppress",reason:"stale_run"}]);expect(f.native.trays).toEqual([]);
});
test("observer failure never changes native result, throw, clear or receiver",()=>{
 const observer=createAlertObserver({generation:"h",emit(){throw Error("observer-failure");}}),native=new NativeTrayFake();const detach=observer.attachManager(native);
 expect(observer.decision({}, {},true,()=>native.pushError({id:"x"}))).toMatchObject({id:"x"});
 native.throws=true;expect(()=>native.dismiss("x")).toThrow("native-listener-failure");expect(native.trays).toEqual([]);
 detach?.();expect(Object.hasOwn(native,"emit")).toBe(false);
});
test("committed mutation survives a native publisher throw without a false published receipt",()=>{
 const f=fixture();f.native.throws=true;expect(()=>f.native.pushError({id:"x"})).toThrow();expect(f.events.some(e=>e.kind==="tray_created")).toBe(true);expect(f.events.some(e=>e.kind==="channel_published")).toBe(false);
});
test("legacy code/STEP extraction is labelled and cannot manufacture direct execution identity",()=>{
 const value={kind:"error",id:"x",agentId:"a",code:"parallel_tools",detail:"Parallel tool calls are not supported. Rejected calls were not executed. (invocationId=old-step)"};
 expect(classifyAlert(value)).toMatchObject({evidence:"direct",stepEvidence:"legacy_text_derived"});
 const f=fixture();f.native.pushError(value);expect(f.events.find(e=>e.kind==="tray_created")).toMatchObject({stepEvidence:"legacy_text_derived"});
 expect(traceAlerts(f.events,{trayId:"x"}).traces[0].trays[0].executions).toEqual([]);
});
test("clear, evict and explicit dismiss are observed independently, never human-read receipts",()=>{
 const f=fixture();for(const id of ["a","b","c"])f.native.pushError({id});f.native.enforceCap();f.native.dismiss("b");f.native.clearAll();
 expect(f.events.filter(e=>e.kind==="tray_removed").map(e=>e.removalReason)).toEqual(["evicted","explicit_dismiss","clear_all"]);
});
test("shared trace separates identical Tray IDs across Host/source instances",()=>{
 const a=fixture(),b=fixture();a.native.pushError({id:"same",agentId:"a"});b.native.pushError({id:"same",agentId:"a"});a.native.dismiss("same");
 const report=traceAlerts([...a.events,...b.events],{trayId:"same"});expect(report.ambiguous).toBe(true);expect(report.traces).toHaveLength(2);
 expect(report.traces.map(t=>t.trays[0].hostState)).toEqual(["removed_observed","present_at_last_observation"]);
});
test("native observer to writer/projector/reader/trace retains lifecycle and safe direct references",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"alert-chain-"));const f=fixture();
 try{f.native.pushError({id:"trace-a",agentId:"a"});f.native.clearAll();for(const e of f.events)expect(await appendHostJournal(dir,e)).toBe("written");
 const observed=await observeEvents(dir,4096,{trayId:"trace-a"});expect(observed.state).toBe("present");expect(traceAlerts(observed.events,{trayId:"trace-a"}).traces[0].trays[0].removalReason).toBe("clear_all");
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("safe projector never invokes getter or copies unknown raw payload",()=>{
 let accesses=0;const f=fixture(),event=f.events[0];const fake={...event,raw:"PRIVATE_SENTINEL",get reason(){accesses++;throw Error();}};
 expect(projectAlertEvent(fake)).toMatchObject({kind:"observer_started"});expect(accesses).toBe(0);expect(JSON.stringify(projectAlertEvent(fake))).not.toContain("PRIVATE_SENTINEL");
});
