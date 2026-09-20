import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { ManagementClient } from "@grokbox/client";
import { startManagementServer } from "../src/server.ts";
import { readHostHealthJournal } from "../../box-runtime/src/internal/io/provenance.node.ts";
import { hostHealthFixture, H_INSTALL, H_OWNER, H_READER } from "../../../apps/web/test/host-health-fixture.ts";
const origin="https://health.example.test", delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>Promise<T>,ok:(value:T)=>boolean,ms=8000){const end=Date.now()+ms;let last:unknown;do{try{const v=await read();if(ok(v))return v;last=v;}catch(e){last=String(e);}await delay(25);}while(Date.now()<end);throw Error(`health_test_deadline:${JSON.stringify(last)}`);}
const health=(f:Awaited<ReturnType<typeof hostHealthFixture>>)=>f.client().hostHealth();
const incidents=async(f:Awaited<ReturnType<typeof hostHealthFixture>>)=>(await f.observations.incidents()).filter(r=>r.rule==="host_patch_health");

test("actual TS candidate passes four Rust checks through the management owner with no Bot roster or native RPC",async()=>{
 const f=await hostHealthFixture(origin);try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.equal(v.data.assessment,"degraded");assert.equal(v.data.qualified,false);assert.equal(v.data.latest!.loaded,"not-observed");
  assert.deepEqual(v.data.latest!.uncoveredSlices,["create-session"]);assert.equal(v.data.latest!.notificationCoverage,"local-only");assert.equal(f.state.nativeCalls,0);assert.equal((await incidents(f)).length,0);
  const journal=await readHostHealthJournal(f.root,H_INSTALL), report=journal!.receipts.at(-1)!.analysis!;
  assert.equal(report.parser,"oxc-0.75.0");assert.equal(report.checks.length,4);assert.ok(report.checks.every(r=>r.state==="passed"));
  const count=f.state.pids.length;for(let i=0;i<4;i++)await health(f);await delay(650);assert.equal(f.state.pids.length,count);
  for(const pid of f.state.pids)assert.throws(()=>process.kill(pid,0));
  for(const secret of [f.root,"contextCheckpoint",H_OWNER,"Symbol.for","native-gateway"])assert.ok(!JSON.stringify(v).includes(secret));
 }finally{await f.close();}
});

test("a definite recipe mismatch becomes one installation incident even when the Rust binary is unavailable",async()=>{
 const f=await hostHealthFixture(origin,{badRecipe:true,ports:{binaryDirectory:"/definitely-absent-verifier"}});try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="unavailable"&&v.data.intake==="committed");
  assert.equal(v.data.assessment,"blocked");const rows=await incidents(f);assert.ok(rows.length>=1);assert.ok(rows.every(r=>r.agentId===null));
  const initial=rows.map(r=>r.id).sort();await delay(700);assert.deepEqual((await incidents(f)).map(r=>r.id).sort(),initial);assert.equal(f.state.nativeCalls,0);
  const journal=await readHostHealthJournal(f.root,H_INSTALL);assert.ok(journal!.receipts.some(r=>r.event.applicability==="mismatch"&&r.event.analysis==="pending"));
  const work=await f.observations.notificationWork();assert.ok(work.length>=1); // work is not native delivery or permission
 }finally{await f.close();}
});

test("a semantically broken retry with freshly pinned valid source/candidate hashes opens a semantic condition and exact positive evidence resolves it",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed");
  const broken=f.slices.map(s=>s.id==="managed-turn-retry-gate"?{...s,replacement:s.replacement.replace("return false;","return true;")}:s);
  await f.writeProfile(f.source,broken);
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.deepEqual(v.data.latest!.failedChecks,["retry.turn-guard"]);
  const rows=await incidents(f);assert.equal(rows.filter(r=>r.status==="open").length,1);const id=rows.find(r=>r.status==="open")!.id;
  await f.writeProfile();await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"resolved");
 }finally{await f.close();}
});

test("lost lease-finally semantics become an installation incident before any native execution and survive restart",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  const broken=f.slices.map(s=>s.id==="compact-register"?{...s,replacement:s.replacement.replace("__grokbox_compact_active = false;","__grokbox_compact_active = true;")}:s);
  await f.writeProfile(f.source,broken);
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal(v.data.latest!.applicability,"exact");assert.deepEqual(v.data.latest!.failedChecks,["context.lease-finally"]);
  const id=(await incidents(f)).find(r=>r.status==="open")!.id;
  await f.restart();await until(()=>health(f),v=>v.data.latest?.analysis==="violated"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,1);assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"open");
  await f.writeProfile();await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).find(r=>r.id===id)!.status,"resolved");assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("source disappearance is a detector gap, never evidence that a known recipe failure was repaired",async()=>{
 const f=await hostHealthFixture(origin,{badRecipe:true});try{
  await until(()=>health(f),v=>v.data.latest?.applicability==="mismatch"&&v.data.intake==="committed");const before=await incidents(f);
  await unlink(f.paths.source);const missing=await until(()=>health(f),v=>v.data.latest?.sourceState==="unavailable"&&v.data.intake==="committed");
  assert.equal(missing.data.latest!.sourceSha,null);assert.equal(missing.data.latest!.sourceSet,null);assert.equal(missing.data.assessment,"unknown");
  for(const row of before.filter(r=>r.status==="open"))assert.equal((await incidents(f)).find(r=>r.id===row.id)!.status,"open");
  await writeFile(f.paths.source,f.source,{mode:0o600});await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,0);
 }finally{await f.close();}
});

test("a retained receipt interrupted before OBS intake is replayed on restart without a duplicate incident or work item",async()=>{
 let retained=false;const f=await hostHealthFixture(origin,{badRecipe:true,ports:{afterRetain:async()=>{retained=true;throw Error("synthetic-after-retain");}}});
 try{
  await until(async()=>retained,v=>v);await f.server.close();assert.equal((await incidents(f)).length,0);
  const prior=(await readHostHealthJournal(f.root,H_INSTALL))!.receipts[0]!.event;
  delete f.ports.afterRetain;await f.restart();await until(()=>health(f),v=>v.data.intake==="committed"&&v.data.latest?.analysis!=="pending");
  assert.equal((await incidents(f)).filter(r=>r.status==="open").length,1);
  const id=(await incidents(f))[0]!.id,count=(await f.observations.notificationWork()).length;
  await f.restart();await until(()=>health(f),v=>v.data.intake==="committed"&&v.data.latest?.analysis!=="pending");
  assert.equal((await incidents(f))[0]!.id,id);assert.equal((await f.observations.notificationWork()).length,count);
  assert.equal((await readHostHealthJournal(f.root,H_INSTALL))!.receipts[0]!.event.eventId,prior.eventId);
 }finally{await f.close();}
});

test("source A to B to A retains separate observation episodes but reuses immutable static analysis, not loaded qualification",async()=>{
 const f=await hostHealthFixture(origin);try{
  const first=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  await writeFile(f.paths.worker,"module.exports = {changed:true};\n",{mode:0o600});
  const next=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.latest?.sourceSet!==first.data.latest!.sourceSet);
  await writeFile(f.paths.worker,"// Independent companion.\nmodule.exports = {};\n",{mode:0o600});
  const restored=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.latest?.sourceSet===first.data.latest!.sourceSet&&v.data.latest.sourceSequence>next.data.latest!.sourceSequence);
  assert.notEqual(restored.data.latest!.eventId,first.data.latest!.eventId);assert.equal(restored.data.analyses,2);assert.equal(restored.data.latest!.loaded,"not-observed");
 }finally{await f.close();}
});

test("unconfigured OBS leaves local-only evidence and does not silently initialize an observation database",async()=>{
 const f=await hostHealthFixture(origin,{noMonitor:true});try{
  const v=await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="unavailable");
  assert.equal(v.data.latest!.notificationCoverage,"local-only");await assert.rejects(f.observations.snapshot());assert.equal(f.state.nativeCalls,0);
 }finally{await f.close();}
});

test("explicit disabled intent is inert and GET does not initialize health or native stores",async()=>{
 const f=await hostHealthFixture(origin,{disabled:true,noMonitor:true});try{
  await until(()=>health(f),v=>v.data.state==="disabled");const before=await readdir(f.root);await health(f);await delay(80);
  assert.deepEqual(await readdir(f.root),before);assert.equal(f.state.pids.length,0);assert.equal(f.state.nativeCalls,0);assert.ok(!before.includes("host-bundles"));
 }finally{await f.close();}
});

test("a competing Server keeps ordinary HTTP responsive but cannot run the installation producer",async()=>{
 const f=await hostHealthFixture(origin);let other:Awaited<ReturnType<typeof startManagementServer>>|undefined;try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed");
  other=await startManagementServer({...f.options,port:0},{hostHealth:f.ports});
  const client=new ManagementClient({baseUrl:other.url,installationId:H_INSTALL,credential:async()=>H_OWNER});
  await until(()=>client.hostHealth(),v=>v.data.reason==="competing-owner");assert.equal((await client.identity()).data.installationId,H_INSTALL);
  const before=f.state.pids.length;await delay(100);assert.equal(f.state.pids.length,before);
 }finally{await other?.close();await f.close();}
});

test("health HTTP and packed CLI are read-only, authorized and scoped; shutdown leaves no writes or child",async()=>{
 const f=await hostHealthFixture(origin);try{
  await until(()=>health(f),v=>v.data.latest?.analysis==="passed"&&v.data.intake==="committed");
  await assert.rejects(f.client(H_READER).hostHealth(),(e:any)=>e.code==="permission_denied");
  const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,"system","host","health"],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_HEALTH_CREDENTIAL:H_OWNER},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);const [code]=await once(child,"close");assert.equal(code,0,err+out);assert.equal(JSON.parse(out).data.latest.analysis,"passed");
  const reads=f.state.nativeCalls;await f.server.close();for(const pid of f.state.pids)assert.throws(()=>process.kill(pid,0));
  const journal=await readHostHealthJournal(f.root,H_INSTALL);await delay(100);assert.deepEqual(await readHostHealthJournal(f.root,H_INSTALL),journal);assert.equal(f.state.nativeCalls,reads);
 }finally{await f.close();}
});
