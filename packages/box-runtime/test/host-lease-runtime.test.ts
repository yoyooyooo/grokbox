import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
import { applyPatchProfile, profileFromSource, HOST_COMPACT_SYMBOL } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { bindHostCompactHook, noteHostManagedStep, resetHostCompactSlotForTests } from "../src/internal/host/compact.ts";
import type { HostWitnessNote } from "@grokbox/runtime-kernel/host-health";

function deferred<T=void>() { let resolve!: (value:T)=>void, reject!: (error:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
afterEach(()=>resetHostCompactSlotForTests());
const tuple=()=>({agentId:randomUUID(),turnId:randomUUID(),stepId:randomUUID()});
function raw(t=tuple(),root={}) { return {orchestrator:{handleSummarization:async()=>undefined},ctx:{signal:{aborted:false}},stateHandler:{},rootPromptExecutor:root,
  invocationId:t.stepId,turnId:t.turnId,agentId:t.agentId,stepClosed:()=>false}; }
function transformed(hook:ReturnType<typeof bindHostCompactHook>) {
  const source=readFileSync(join(import.meta.dir,"../../../test/fixtures/host-verifier/sources/contracts.cjs"),"utf8");
  const selected=LIVE_SLICE_PATCHES.filter(s=>["create-session","agent-id","managed-turn-retry-gate","compact-register"].includes(s.id));
  const candidate=applyPatchProfile(source,profileFromSource(source,selected));if(!candidate.ok)throw Error(candidate.code);
  const globals:Record<PropertyKey,unknown>={Symbol,Error,TypeError,AggregateError,requestIdKey:Symbol("request"),module:{exports:{}}};
  globals[Symbol.for(HOST_COMPACT_SYMBOL)]=hook;
  const exports=runInNewContext(candidate.source+"\nmodule.exports",globals,{timeout:1000,contextCodeGeneration:{strings:false,wasm:false}});
  return (t:ReturnType<typeof tuple>,root:object,signal:AbortSignal)=>exports.perform.call({orchestrator:{handleSummarization:async()=>undefined},config:{conversationGroupId:t.agentId},interactionListener:{},resourceAccessor:{}},
    {get:()=>t.turnId,signal},{},root,async()=>{}, {},t.stepId,{});
}
test("production transform holds the actual lease through awaited provider settlement and closes it once",async()=>{
  const t=tuple(),preflight=deferred(),provider=deferred<object>(),entered=deferred(),notes:HostWitnessNote[]=[];let called=0,closed:()=>boolean=()=>false;
  const hook=bindHostCompactHook({context:(capture,valid)=>{closed=()=>!valid()||(capture as any).stepClosed();return {preflight:()=>{entered.resolve();return preflight.promise;},recover:async()=>undefined};},witness:n=>notes.push(n)});
  const run=transformed(hook)(t,{executeToolStream(){called++;return {response:provider.promise};}},new AbortController().signal);
  await entered.promise;expect(called).toBe(0);expect(closed()).toBe(false);preflight.resolve();await Promise.resolve();await Promise.resolve();
  expect(noteHostManagedStep(t)).toBe(true);expect(closed()).toBe(false);const value={exact:true};provider.resolve(value);
  expect(await run).toBe(value);expect(called).toBe(1);expect(closed()).toBe(true);expect(noteHostManagedStep(t)).toBe(false);
  expect(notes.map(n=>n.stage)).toEqual(["lease-open","preflight-settled","lease-close"]);
});
test("production transform closes the lease on preflight rejection without entering the main provider",async()=>{
  const t=tuple(),notes:HostWitnessNote[]=[];let called=0;
  const run=transformed(bindHostCompactHook({context:()=>({preflight:async()=>{throw Error("PRIVATE");},recover:async()=>undefined}),witness:n=>notes.push(n)}));
  await expect(run(t,{executeToolStream(){called++;return {}; }},new AbortController().signal)).rejects.toThrow();
  expect(called).toBe(0);expect(noteHostManagedStep(t)).toBe(false);expect(notes.map(n=>n.stage)).toEqual(["lease-open","preflight-settled","lease-close"]);
});
test("context factory failure cannot leave an unreachable registered slot or exhaust later capacity",()=>{
  const thrown={original:true},hook=bindHostCompactHook({context:()=>{throw thrown;}});
  for(let i=0;i<20;i++) {const t=tuple();let error:unknown;try{hook(raw(t));}catch(e){error=e;}expect(error).toBe(thrown);expect(noteHostManagedStep(t)).toBe(false);}
  const t=tuple(),lease=bindHostCompactHook()(raw(t));expect(lease).toBeDefined();lease![Symbol.dispose]();
});
for(const stop of ["dispose","abort","new-owner"] as const)test(`preflight ${stop} while pending cannot become a late successful result`,async()=>{
  const t=tuple(),capture=raw(t),wait=deferred<object>(),notes:HostWitnessNote[]=[];
  const hook=bindHostCompactHook({context:()=>({preflight:()=>wait.promise,recover:async()=>undefined}),witness:n=>notes.push(n)});
  const lease=hook(capture)!,running=lease.preflight!();let next:ReturnType<typeof hook>;
  if(stop==="dispose")lease[Symbol.dispose]();if(stop==="abort")capture.ctx.signal.aborted=true;
  if(stop==="new-owner")next=hook(raw({...t,stepId:randomUUID()},capture.rootPromptExecutor));
  wait.resolve({late:true});await expect(running).rejects.toThrow();expect(notes.filter(n=>n.stage==="preflight-settled")).toMatchObject([{outcome:"threw"}]);
  lease[Symbol.dispose]();next?.[Symbol.dispose]();
});
test("already invalid leases refuse preflight before invoking its context client",async()=>{
  const t=tuple();let calls=0;const hook=bindHostCompactHook({context:()=>({preflight:async()=>{calls++;},recover:async()=>undefined})});
  const lease=hook(raw(t))!;lease[Symbol.dispose]();await expect(lease.preflight!()).rejects.toThrow();expect(calls).toBe(0);
});
