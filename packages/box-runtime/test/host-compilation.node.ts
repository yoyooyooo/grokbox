import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { ChildProcess } from "node:child_process";
import { launchPublicHost as launch, preparePublicHost as prepare, stopPublicHost as stop } from "../../../apps/web/test/host-compilation-fixture.ts";
import { mkdir, readFile, writeFile, rm, chmod, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { projectHostCompileReceipt, projectHostRuntimeObservation, hostRuntimeCondition, type HostRuntimeEvidence } from "@grokbox/runtime-kernel/host-health";
import { hostHealthFixture } from "../../../apps/web/test/host-health-fixture.ts";
import { installCompileHook } from "../src/internal/host/compile-hook.ts";
import { profileFromSource } from "../src/internal/host/profile.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";
import { observeHostCompilation } from "../src/internal/io/host-compilation.node.ts";
import { inspectPid } from "../src/internal/host/self-identity.node.ts";
import { readHostRuntimeJournal, retainHostRuntimeEvidence, acknowledgeHostRuntimeEvidence } from "../src/internal/io/provenance.node.ts";

const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>Promise<T>,ok:(value:T)=>boolean,ms=10000){let last:unknown;const end=Date.now()+ms;do{try{const value=await read();if(ok(value))return value;last=value;}catch(e){last=String(e);}await pause(20);}while(Date.now()<end);throw Error(`compile_test_deadline:${JSON.stringify(last)}`);}
type Fixture=Awaited<ReturnType<typeof hostHealthFixture>>;
async function runtime(f:Fixture){return (await f.client().hostHealth()).data.runtime;}
async function compilationIncidents(f:Fixture){return (await f.observations.incidents()).filter(r=>r.rule==="host_patch_health");}

// This checks the real Module._compile, not an observer-shaped fake.
test("an observer exception cannot replace a native result or its original thrown object",()=>{
 const filename="/tmp/host-main.cjs",proto=Module.prototype as any,original=proto._compile;
 for(const fail of [false,true]){
  const error={private:"PRIVATE_COMPILE_EXCEPTION"};(globalThis as any)[Symbol.for("grokbox.test.compile-failure")]=error;
  const source=SYNTHETIC_HOST+(fail?'\nthrow globalThis[Symbol.for("grokbox.test.compile-failure")];':""),observations:any[]=[];
  const hook=installCompileHook({targetPath:filename,argv:["node",filename],profile:profileFromSource(source,SYNTHETIC_SLICES),
   onCompilation:r=>{observations.push(r);throw Error("observer-failed");},onTransformed:()=>{throw Error("marker-failed");}});
  try{const module=new Module(filename) as any;if(fail)assert.throws(()=>module._compile(source,filename),e=>e===error);else{module._compile(source,filename);assert.equal(typeof module.exports.runTurn,"function");}
   assert.equal(proto._compile,original);assert.equal(observations.length,1);assert.equal(observations[0].nativeCompilation,fail?"threw":"returned");assert.equal(hook.applied(),!fail);assert.ok(!JSON.stringify(observations).includes("PRIVATE_COMPILE_EXCEPTION"));
  }finally{hook.restore();delete (globalThis as any)[Symbol.for("grokbox.test.compile-failure")];}
 }
});

test("packed preload positive receipt binds actual loaded bytes and PID generation independently from later disk changes",async()=>{
 const f=await hostHealthFixture("https://compile.example.test");let child:ChildProcess|undefined;
 try{const source=await prepare(f),p=await launch(f);child=p.child;
  assert.equal(p.result.compiled,true);assert.equal(p.result.compilationObservation.sourceSha,sha256Text(source));assert.ok(projectHostCompileReceipt(p.result.compilationObservation));
  const first=await until(()=>runtime(f),v=>v?.state==="current");assert.equal(first!.process,"same-generation");assert.equal(first!.attachment,"not-observed");assert.equal(first!.qualified,false);
  await writeFile(f.paths.source,source+"// newer on disk\n");await until(()=>f.client().hostHealth(),v=>v.data.latest?.sourceSha===sha256Text(source+"// newer on disk\n"));
  assert.equal((await runtime(f))!.receipt!.sourceSha,sha256Text(source));assert.equal((await runtime(f))!.state,"current");assert.equal(child.exitCode,null);
  await stop(child);await until(()=>runtime(f),v=>v?.state==="historical");assert.equal(f.state.nativeCalls,0);
 }finally{if(child)await stop(child);await f.close();}
});

test("refused patch leaves original native evaluation intact, becomes a persistent incident, and static recovery cannot repair the running unpatched generation",async()=>{
 const f=await hostHealthFixture("https://compile-refusal.example.test");let child:ChildProcess|undefined;
 try{const source=await prepare(f),changed=source+"// changed upstream\n";await writeFile(f.paths.source,changed);const p=await launch(f);child=p.child;
  assert.equal(p.result.transformed,false);assert.equal(p.result.compiled,false);assert.equal(p.result.compilationObservation.nativeCompilation,"returned");assert.equal(p.result.compilationObservation.code,"unknown-sha");assert.equal(p.result.compilationObservation.sourceSha,sha256Text(changed));
  await until(()=>runtime(f),v=>v?.state==="current"&&v.receipt?.patch==="refused");await until(()=>compilationIncidents(f),v=>v.some(r=>r.status==="open"));
  await f.writeProfile(changed);await until(()=>f.client().hostHealth(),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed"&&v.data.runtimeIntake==="committed");
  const failed=await compilationIncidents(f);assert.equal(failed.filter(r=>r.status==="open").length,1);const id=failed.find(r=>r.status==="open")!.id;
  assert.equal(child.exitCode,null);await stop(child);await until(()=>runtime(f),v=>v?.state==="historical");assert.equal((await compilationIncidents(f)).find(r=>r.id===id)!.status,"open");
  const second=await launch(f);child=second.child;await until(()=>runtime(f),v=>v?.state==="current"&&v.receipt?.patch==="applied");
  await until(()=>compilationIncidents(f),v=>v.find(r=>r.id===id)?.status==="resolved");assert.equal(f.state.nativeCalls,0);
  // Restoring an older marker gives a new observation sequence, not a new
  // failed compile. It must not reopen the later repaired condition.
  await writeFile(p.marker,JSON.stringify(p.result),{mode:0o600});await until(()=>runtime(f),v=>v?.receipt?.observationId===p.result.compilationObservation.observationId);
  await until(()=>f.client().hostHealth(),v=>v.data.runtimeIntake==="committed");assert.equal((await compilationIncidents(f)).find(r=>r.id===id)!.status,"resolved");
 }finally{if(child)await stop(child);await f.close();}
});

for(const [name,extra] of [["native throw",'throw new Error("PRIVATE_COMPILE_EXCEPTION");'],["syntax failure","const = ;"]] as const){
 test(`${name} survives process exit as a bounded negative marker and reaches original OBS`,async()=>{
  const f=await hostHealthFixture("https://compile-failed.example.test");let child:ChildProcess|undefined;
  try{await prepare(f,extra);const p=await launch(f);child=p.child;await until(async()=>child!.exitCode,c=>c!==null);
   const r=projectHostCompileReceipt(p.result.compilationObservation)!;assert.equal(r.nativeCompilation,"threw");assert.equal(r.code,"native-compile-failed");assert.equal(p.result.compiled,false);
   await until(()=>runtime(f),v=>v?.state==="historical"&&v.receipt?.observationId===r.observationId);
   await until(()=>compilationIncidents(f),v=>v.some(r=>r.status==="open"));
   const view=(await f.client().hostHealth()).data;for(const privateText of [f.root,"PRIVATE_COMPILE_EXCEPTION","Error:","const ="] )assert.ok(!JSON.stringify(view).includes(privateText));
   await until(()=>f.client().hostHealth(),v=>v.data.latest?.analysis!=="pending"&&v.data.intake==="committed"&&v.data.runtimeIntake==="committed");
   const ids=(await compilationIncidents(f)).map(r=>r.id).sort();await pause(150);assert.deepEqual((await compilationIncidents(f)).map(r=>r.id).sort(),ids);
  }finally{if(child)await stop(child);await f.close();}
 });
}

test("PID reuse, changed executable, foreign root and tampered legacy fields never provide current compilation proof",async()=>{
 const f=await hostHealthFixture("https://compile-identity.example.test");let child:ChildProcess|undefined;
 try{await prepare(f);const p=await launch(f);child=p.child;const info=inspectPid(child.pid!)!;
  const read=(inspect:typeof inspectPid)=>observeHostCompilation(f.root,f.ports.runtime!.runRoot!,f.paths.source,{inspect});
  for(const value of [{...info,start:info.start+1},{...info,exe:info.exe+"-replaced"},{...info,cmdline:[...info.cmdline,"different"]}])assert.equal((await read(()=>value)).state,"historical");
  assert.equal((await read(()=>null)).process,"absent-or-unverifiable");
  const original=await readFile(p.marker,"utf8");for(const modify of [(m:any)=>{m.compiled=false;},(m:any)=>{m.compilationObservation.rootDigest="f".repeat(64);},(m:any)=>{m.compilationObservation.at="2099-01-01T00:00:00.000Z";}]){
   const m=JSON.parse(original);modify(m);await writeFile(p.marker,JSON.stringify(m),{mode:0o600});assert.equal((await read(()=>info)).state,"invalid");
  }
  await writeFile(p.marker,original);await chmod(p.marker,0o666);assert.equal((await read(()=>info)).state,"invalid");await chmod(p.marker,0o600);
  await rm(p.marker);await symlink(f.paths.profile,p.marker);assert.notEqual((await read(()=>info)).state,"current");
 }finally{if(child)await stop(child);await f.close();}
});

test("missing or corrupt markers do not repair a compilation failure; service restart replays original evidence without duplicate work",async()=>{
 const f=await hostHealthFixture("https://compile-restart.example.test");let child:ChildProcess|undefined;
 try{await prepare(f,'throw new Error("synthetic failed load");');const p=await launch(f);child=p.child;
  await until(()=>runtime(f),v=>v?.receipt?.nativeCompilation==="threw");await until(()=>compilationIncidents(f),v=>v.some(r=>r.status==="open"));
  const ids=(await compilationIncidents(f)).filter(r=>r.status==="open").map(r=>r.id),work=(await f.observations.notificationWork()).length;
  await f.restart();await until(()=>f.client().hostHealth(),v=>v.data.runtimeIntake==="committed"&&v.data.runtime?.receipt?.nativeCompilation==="threw");
  assert.deepEqual((await compilationIncidents(f)).filter(r=>r.status==="open").map(r=>r.id),ids);assert.equal((await f.observations.notificationWork()).length,work);
  await writeFile(p.marker,"{}");await until(()=>runtime(f),v=>v?.state==="not-observed");await rm(p.marker);await pause(100);
  assert.ok((await compilationIncidents(f)).some(r=>ids.includes(r.id)&&r.status==="open"));
  await f.server.close();const journal=await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111");await pause(80);assert.deepEqual(await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111"),journal);
 }finally{if(child)await stop(child);await f.close();}
});

test("retain-before-intake interruption replays the original compilation receipt after Server restart",async()=>{
 const f=await hostHealthFixture("https://compile-intake.example.test");let child:ChildProcess|undefined;
 try{await until(()=>f.client().hostHealth(),v=>v.data.runtimeIntake==="committed");
  let resolve!:()=>void;const retained=new Promise<void>(r=>resolve=r);
  f.ports.runtime!.afterRetain=async()=>{const j=await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111");if(j?.receipts.at(-1)?.event.observation.receipt?.nativeCompilation==="threw"){assert.notEqual((await f.client().hostHealth()).data.runtimeIntake,"committed");resolve();throw Error("synthetic-interruption-before-intake");}};
  await prepare(f,'throw new Error("synthetic failed module");');const p=await launch(f);child=p.child;await retained;await f.server.close();
  const journal=(await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111"))!,last=journal.receipts.at(-1)!.event;assert.ok(journal.acknowledgedThrough<last.sourceSequence);
  delete f.ports.runtime!.afterRetain;await f.restart();await until(()=>f.client().hostHealth(),v=>v.data.runtimeIntake==="committed");
  assert.ok((await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111"))!.receipts.some(r=>r.event.eventId===last.eventId));
  assert.ok((await compilationIncidents(f)).some(r=>r.status==="open"));const ids=(await compilationIncidents(f)).map(r=>r.id).sort();
  await f.restart();await until(()=>f.client().hostHealth(),v=>v.data.runtimeIntake==="committed");assert.deepEqual((await compilationIncidents(f)).map(r=>r.id).sort(),ids);
 }finally{if(child)await stop(child);await f.close();}
});

test("without OBS, compilation evidence stays local; stopping the observer never signals the running Host",async()=>{
 const f=await hostHealthFixture("https://compile-local.example.test",{noMonitor:true});let child:ChildProcess|undefined;
 try{await prepare(f);const p=await launch(f);child=p.child;await until(()=>f.client().hostHealth(),v=>v.data.runtime?.state==="current"&&v.data.runtimeIntake==="unavailable");
  await assert.rejects(f.observations.snapshot());assert.ok(await readHostRuntimeJournal(f.root,"11111111-1111-4111-8111-111111111111"));
  await f.server.close();assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);assert.ok(inspectPid(child.pid!));assert.equal(f.state.nativeCalls,0);
 }finally{if(child)await stop(child);await f.close();}
});

test("runtime provenance remains bounded and never evicts unindexed evidence to manufacture a new sequence",async()=>{
 const f=await hostHealthFixture("https://compile-capacity.example.test",{disabled:true,noMonitor:true});
 try{const installation="11111111-1111-4111-8111-111111111111",sourceInstanceId=sha256Text(canonicalJson(["host-runtime",installation]));
  const observation={state:"not-observed" as const,process:"not-checked" as const,observedAtMs:Date.now(),receipt:null,coverage:"selected-launch-marker" as const,attachment:"not-observed" as const,exercised:"not-exercised" as const,qualified:false as const};
  const event=(n:number):HostRuntimeEvidence=>({name:"host_runtime_health",schemaVersion:1,eventId:randomUUID(),at:new Date().toISOString(),installationId:installation,sourceInstanceId,sourceSequence:n,observation});
  for(let n=0;n<64;n++)await retainHostRuntimeEvidence(f.root,installation,event(n));
  await assert.rejects(retainHostRuntimeEvidence(f.root,installation,event(64)),/capacity/);assert.equal((await readHostRuntimeJournal(f.root,installation))!.nextSequence,64);
  await acknowledgeHostRuntimeEvidence(f.root,installation,10);await retainHostRuntimeEvidence(f.root,installation,event(64));const journal=(await readHostRuntimeJournal(f.root,installation))!;
  assert.equal(journal.receipts.length,64);assert.equal(journal.receipts[0]!.event.sourceSequence,1);assert.equal(hostRuntimeCondition(journal.receipts[0]!.event),"unknown");
 }finally{await f.close();}
});

test("runtime contract rejects property accessors, invented attachment proof and contradictory current state",()=>{
 const raw:any={state:"not-observed",process:"not-checked",observedAtMs:Date.now(),receipt:null,coverage:"selected-launch-marker",attachment:"not-observed",exercised:"not-exercised",qualified:false};
 assert.ok(projectHostRuntimeObservation(raw));for(const patch of [{state:"current"},{attachment:"attached"},{qualified:true},{privateSource:"private"}])assert.equal(projectHostRuntimeObservation({...raw,...patch}),null);
 let read=0;Object.defineProperty(raw,"receipt",{enumerable:true,get(){read++;return null;}});assert.equal(projectHostRuntimeObservation(raw),null);assert.equal(read,0);
});
