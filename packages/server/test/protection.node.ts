import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startManagementServer } from "../src/server.ts";
import { openMonitorStore, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { continuitySourceKey } from "@grokbox/runtime-kernel/observation";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { ManagementClient } from "@grokbox/client";
import { protectionFixture, P_BOT, P_TARGET, P_TEMPORAL, P_INSTALL, P_OWNER, P_READER, P_SCOPE } from "../../../apps/web/test/protection-fixture.ts";
const origin="https://protection.example.test";
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until<T>(read:()=>Promise<T>,ok:(v:T)=>boolean,ms=8000):Promise<T>{
  const end=Date.now()+ms;let last:unknown;
  do{try{const v=await read();if(ok(v))return v;last=v;}catch(e){last=e;}await delay(25);}while(Date.now()<end);
  throw new Error(`protection_fixture_deadline: ${JSON.stringify(last)}`);
}
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e?.code===code);
const subject=async(f:Awaited<ReturnType<typeof protectionFixture>>)=>(await f.client().botProtection(P_BOT)).data.subject;
const policy=async(f:Awaited<ReturnType<typeof protectionFixture>>,patch:any)=>f.client().changeProtection({requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,confirmed:true,action:"set",botRef:P_BOT,patch});
const enable=async(f:Awaited<ReturnType<typeof protectionFixture>>)=>f.client().changeProtection({requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,confirmed:true,action:"system",enabled:true});
async function cli(f:Awaited<ReturnType<typeof protectionFixture>>,args:string[]){
  const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,...args],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_PROTECTION_CREDENTIAL:P_OWNER},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
  const timer=setTimeout(()=>child.kill("SIGKILL"),12000);
  try{const [code,signal]=await once(child,"close");assert.equal(signal,null);assert.equal(code,0,err+out);return JSON.parse(out).data;}
  finally{clearTimeout(timer);}
}

test("default discovery enrolls confirmed owned Box identities and exposes real capture failure without creating replacement work",async()=>{
  const f=await protectionFixture(origin);
  try{
    const view=await until(()=>f.client().protection(),v=>v.data.subjects.length===1&&v.data.subjects[0]?.lastAction==="snapshot_unavailable");
    assert.equal(view.data.subjects[0]!.botRef,`bot:${P_INSTALL}:${P_BOT}`);assert.equal(view.data.subjects[0]!.currentBotRef,view.data.subjects[0]!.botRef);
    assert.equal(view.data.enabled,true);assert.equal(view.data.defaultPolicy.mode,"alert");assert.equal(view.data.defaultPolicy.tier,"resume");
    assert.equal(view.data.subjects.some(row=>row.botRef.endsWith(P_TEMPORAL)),false);
    assert.equal(view.data.worker.owner,"management-server");assert.equal(view.data.worker.nativeExecutionProven,false);
    assert.ok(!f.state.calls.some(path=>/createAgent|WebhookCredential|sendPrompt|setAgent/.test(path)));
    assert.equal((await f.client().protectionSnapshots(P_BOT)).data.snapshots.length,0);
    for(const text of ["PRIVATE_PROFILE","PRIVATE_PROTECTION_ROUTINE",f.root])assert.ok(!JSON.stringify(view).includes(text));
  }finally{await f.close();}
});

test("explicit installation off is inert and read-only calls never initialize or contact native sources",async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    await until(()=>f.client().protection(),v=>v.data.worker.state==="disabled");
    const before=await readdir(f.root),config=await readFile(join(f.root,"config.json"));
    await f.client().botProtection(P_BOT);await f.client().protectionSnapshots(P_BOT);await f.client().protection();await delay(80);
    assert.deepEqual(await readdir(f.root),before);assert.deepEqual(await readFile(join(f.root,"config.json")),config);assert.deepEqual(f.state.calls,[]);
    assert.ok(!before.includes("continuity"));
  }finally{await f.close();}
});

for(const kind of ["stale","foreign-id","not-owner"] as const)test(`default protection never promotes ${kind} evidence into a protected Box identity`,async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    if(kind==="stale")f.state.ownershipAge=60000;if(kind==="foreign-id")f.state.foreignIdentity=true;if(kind==="not-owner")f.state.viewerOwner=false;
    await enable(f);await until(async()=>f.state.calls.length,n=>n>=2);await delay(100);
    assert.equal((await f.client().protection()).data.subjects.length,0);assert.equal(f.state.created,0);assert.equal(f.state.calls.some(c=>c.includes("setAgent")),false);
  }finally{await f.close();}
});

test("per-Bot policy uses the canonical CAS, preserves others and explicit exclusions, and reset never deletes materials",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>!!v?.lastSnapshotRef);
    const bytes=await readFile(join(f.root,"models.json")).catch(()=>null),snapshots=(await f.client().protectionSnapshots(P_BOT)).data;
    const old=(await f.client().protection()).data.revision;
    const first={requestId:randomUUID(),expectedRevision:old,confirmed:true as const,action:"set" as const,botRef:P_BOT,patch:{enabled:false,pauseOnOwnershipLoss:false,handover:{titles:false}}};
    const result=(await f.client().changeProtection(first)).data;
    await rejects(f.client().changeProtection({...first,requestId:randomUUID()}),"revision_conflict");
    await rejects(f.client().changeProtection({...first,patch:{enabled:true}}),"idempotency_conflict");
    assert.deepEqual((await f.client().changeProtection(first)).data,result);
    await delay(100);assert.equal((await f.client().botProtection(P_BOT)).data.policy.enabled,false);
    await f.client().changeProtection({requestId:randomUUID(),expectedRevision:result.revision!,confirmed:true,action:"reset",botRef:P_BOT});
    assert.equal((await f.client().botProtection(P_BOT)).data.policySource,"default");
    const snapshot=snapshots.snapshots[0]!;assert.equal((await f.client().protectionSnapshot(snapshot.snapshotRef)).data.revision,snapshot.revision);
    assert.deepEqual(await readFile(join(f.root,"models.json")).catch(()=>null),bytes);
    await rejects(f.client(P_READER).changeProtection({...first,requestId:randomUUID()}),"permission_denied");
    await rejects(f.client(P_READER).protectionOperation(P_BOT,first.requestId),"not_found");
  }finally{await f.close();}
});

test("lost policy reply recovers the historical commit after later changes, without replaying an old enable",async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    let posts=0;
    const client=new ManagementClient({baseUrl:f.server.url,installationId:P_INSTALL,credential:async()=>P_OWNER,fetch:(async(input,init)=>{
      const response=await fetch(input,init);if(init?.method==="POST"){posts++;await response.arrayBuffer();throw new Error("synthetic_lost_reply");}return response;
    }) as typeof fetch});
    const input={requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,action:"system" as const,enabled:true,confirmed:true as const};
    await rejects(client.changeProtection(input),"operation_unknown");
    const receipt=(await f.client().protectionOperation("system",input.requestId)).data;assert.equal(receipt.state,"succeeded");
    await f.client().changeProtection({requestId:randomUUID(),expectedRevision:receipt.revision!,action:"system",enabled:false,confirmed:true});
    assert.deepEqual((await f.client().changeProtection(input)).data,receipt);assert.equal((await f.client().protection()).data.enabled,false);assert.equal(posts,1);
    await f.restart();
    // A cold CLI has no pooled socket awaiting the old Server's FIN. It must
    // recover using only the persisted original locator, never the write body.
    assert.deepEqual(await cli(f,["operation","get","--domain","protection","--target","system","--request-id",input.requestId]),receipt);
  }finally{await f.close();}
});

test("confirmed loss pauses each exact Routine once, recovery does not resume it, and a later loss has a new identity",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>v?.ownership==="box");f.state.temporal.add(P_BOT);f.state.conflict=true;
    const lost=await until(()=>subject(f),v=>!!v?.lossId&&v.pause?.complete===true);assert.equal(f.state.created,0);
    assert.equal(f.state.calls.filter(c=>c==="/api/setAgentAutomationEnabled").length,1);
    // No monitor is configured. Export backlog must not prevent recovery or
    // manufacture delivered evidence, and must not lose the prior loss ID.
    f.state.temporal.delete(P_BOT);f.state.conflict=false;
    const recovered=await until(()=>subject(f),v=>v?.ownership==="box"&&v.lossId===null);
    assert.equal(recovered!.notificationDelivery,"not-observed");assert.equal(f.state.routines.get(P_BOT)![0]!.isEnabled,false);
    f.state.routines.get(P_BOT)![0]!.isEnabled=true;f.state.temporal.add(P_BOT);
    const again=await until(()=>subject(f),v=>!!v?.lossId&&v.lossId!==lost?.lossId&&v.pause?.complete===true);
    assert.notEqual(again?.lossId,lost?.lossId);assert.equal(f.state.calls.filter(c=>c==="/api/setAgentAutomationEnabled").length,2);
  }finally{await f.close();}
});

test("protection events enter the original observation store without time-derived sequence gaps or duplicate loss incidents",async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  const monitor=openMonitorStore(f.root),epoch=randomUUID();
  try{
    await monitor.initialize();await monitor.begin(epoch,Date.now(),[P_BOT]);
    await publishConfigFile(join(f.root,"config.json"),{...f.config,ops:{notifications:{mode:"off"}}});
    await enable(f);await until(()=>subject(f),v=>v?.ownership==="box"&&!v.eventExportPending);
    f.state.temporal.add(P_BOT);
    await until(()=>subject(f),v=>!!v?.lossId&&!v.eventExportPending&&v.pause?.complete===true);
    const sourceKey=continuitySourceKey({scopeId:P_SCOPE,source:"ownership",generation:`protection-events-v2-${P_BOT}`});
    const health=await monitor.evidenceSourceStatus(sourceKey);
    assert.equal(health.knownMissingEvents,0,"A wall-clock timestamp is not a source event sequence.");
    const incidents=await monitor.incidents();assert.equal(incidents.filter(row=>row.rule==="continuity_attention").length,1);
    assert.equal((await monitor.notificationWork()).length,0);
    await delay(100);assert.equal((await monitor.incidents()).length,incidents.length);
    await f.restart();await until(()=>f.client().protection(),v=>v.data.worker.state==="running");
    f.state.temporal.delete(P_BOT);
    await until(()=>subject(f),v=>v?.ownership==="box"&&v.lossId===null&&!v.eventExportPending);
    await f.server.close();
    const continued=await monitor.evidenceSourceStatus(sourceKey);
    assert.equal(continued.knownMissingEvents,0);assert.equal(continued.conflicts,0);
    // Cancellation during shutdown can legitimately record a source_gap.
    // Verify the actual retained sequence rather than prescribing a fixed
    // event count that would require hiding this observed interruption.
    const db=await openMonitorSqlite(monitor.path,"read");
    try{
      const rows=await db.all("SELECT source_seq,payload FROM evidence WHERE source_key=? ORDER BY source_seq",[sourceKey]);
      assert.ok(rows.length>=3);assert.deepEqual(rows.map(row=>row.source_seq),rows.map((_,index)=>index));
      assert.equal(continued.lastSequence,rows.length-1);
      const events=rows.map(row=>JSON.parse(String(row.payload)));
      assert.equal(events.filter(event=>event.kind==="ownership_lost").length,1);
      assert.ok(events.every(event=>["ownership_observed","ownership_lost","source_gap"].includes(event.kind)));
    }finally{await db.close();}
    assert.equal((await monitor.notificationWork()).length,0);
    await monitor.finish(epoch,Date.now());
  }finally{await f.close();}
});

test("a source gap and a foreign identity conflict cannot cause replacement or Routine pause",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>v?.ownership==="box");await policy(f,{mode:"auto-replace"});
    f.state.temporal.add(P_BOT);f.state.foreignIdentity=true;
    await until(()=>subject(f),v=>v?.ownership==="gap");await delay(150);
    assert.equal(f.state.created,0);assert.equal(f.state.calls.some(c=>c==="/api/setAgentAutomationEnabled"),false);
    f.state.foreignIdentity=false;f.state.ownershipAge=60000;
    await until(()=>f.client().protection(),v=>v.data.worker.state==="blocked");assert.equal(f.state.created,0);
  }finally{await f.close();}
});

test("the original staged lifecycle promotes one successor and restart does not enroll it as another logical Bot",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>!!v?.lastSnapshotRef);await policy(f,{mode:"auto-replace",pauseOnOwnershipLoss:false});
    f.state.temporal.add(P_BOT);
    const promoted=await until(()=>subject(f),v=>v?.currentBotRef===`bot:${P_INSTALL}:${P_TARGET}`);
    assert.equal(promoted?.generation,1);assert.equal(f.state.created,1);assert.deepEqual(promoted?.previousBotRefs,[`bot:${P_INSTALL}:${P_BOT}`]);
    const history=promoted?.handoverRefs;
    assert.equal(history?.length,1,"Promoting the successor must not discard the link to its unfinished handover.");
    const handover=(await f.client().protectionHandover(history![0]!)).data;
    assert.equal(handover.phase,"active_with_handover");assert.equal(handover.targetBotRef,`bot:${P_INSTALL}:${P_TARGET}`);
    await rejects(f.client().changeProtection({requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,confirmed:true,action:"set",botRef:P_TARGET,patch:{enabled:true}}),"protection_target_conflict");
    await f.restart();await until(()=>f.client().protection(),v=>v.data.worker.state==="running");await delay(100);
    assert.equal(f.state.created,1);assert.equal((await f.client().protection()).data.subjects.length,1);
    assert.deepEqual((await subject(f))?.handoverRefs,history);
    assert.ok(!f.state.calls.some(c=>c==="/api/sendPrompt"));
  }finally{await f.close();}
});

test("unknown native creation remains blocked through restart and never creates a replacement request",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>!!v?.lastSnapshotRef);await policy(f,{mode:"auto-replace",pauseOnOwnershipLoss:false});f.state.lostBirth=true;f.state.temporal.add(P_BOT);
    const current=await until(()=>subject(f),v=>v?.lastAction==="blocked"&&!!v.pendingHandoverRef);
    assert.equal(f.state.created,1);const handover=(await f.client().protectionHandover(current!.pendingHandoverRef!)).data;
    assert.equal(handover.phase,"blocked");assert.ok(handover.steps.some(s=>s.step==="create"&&s.state==="effect_unknown"));
    assert.equal(handover.targetUsability,"not-observed");assert.equal(handover.privateInputsIncluded,false);
    await f.restart();await delay(200);assert.equal(f.state.created,1);assert.equal((await subject(f))?.pendingHandoverRef,current?.pendingHandoverRef);
  }finally{await f.close();}
});

for(const total of [37,132])test(`default discovery rotates past the first ownership batch and bounds ${total} candidates without a new subject for overflow`,async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    f.state.bots=Array.from({length:total},()=>randomUUID());f.state.temporal.clear();
    f.timings.observationMs=200;f.timings.advancementMs=1000;
    await f.restart();await enable(f);
    const view=await until(()=>f.client().protection(),v=>v.data.worker.targets===Math.min(total,128));
    assert.equal(view.data.worker.rosterSize,total);assert.equal(view.data.worker.discovered,Math.min(total,128));
    assert.equal(view.data.worker.discoveryCoverage,total>128?"capacity-limited":"rotating-batch");
    assert.ok(view.data.subjects.length<=128);assert.equal(f.state.created,0);
    assert.equal(f.state.calls.includes("/api/setAgentAutomationEnabled"),false);
    assert.equal((await f.client().identity()).data.installationId,P_INSTALL);
  }finally{await f.close();}
});

test("a competing management process cannot acquire the protection worker and keeps its ordinary API responsive",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});let other:Awaited<ReturnType<typeof startManagementServer>>|undefined;
  try{
    await until(()=>f.client().protection(),v=>v.data.worker.state==="running");
    other=await startManagementServer({...f.serverOptions,port:0},{protection:f.timings});
    const second=new ManagementClient({baseUrl:other.url,installationId:P_INSTALL,credential:async()=>P_OWNER});
    await until(()=>second.protection(),v=>v.data.worker.reason==="competing-owner");
    assert.equal((await second.identity()).data.installationId,P_INSTALL);
    await other.close();other=undefined;assert.equal((await f.client().protection()).data.worker.state,"running");
  }finally{await other?.close();await f.close();}
});

test("management shutdown cancels slow native reads and waits for final CONT writes before reporting stopped",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>!!v?.lastSnapshotRef);f.state.slowOwnership=true;await until(async()=>f.state.stalled,n=>n>0);
    const before=Date.now();await f.server.close();assert.ok(Date.now()-before<4000);await until(async()=>f.state.aborted,n=>n>0,1000);
    const path=join(f.root,"continuity/state.sqlite"),bytes=await readFile(path);await delay(100);assert.deepEqual(await readFile(path),bytes);
  }finally{await f.close();}
});

test("another account scope or a missing known safety database cannot replace retained protection history",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>!!v?.lastSnapshotRef);f.state.scopeId="f".repeat(64);
    await until(()=>f.client().protection(),v=>v.data.worker.reason==="scope-mismatch");
    const at=await readFile(join(f.root,"continuity/state.sqlite"));await delay(100);assert.deepEqual(await readFile(join(f.root,"continuity/state.sqlite")),at);
    assert.equal((await f.client().protection()).data.scopeId,P_SCOPE);
    await f.server.close();await unlink(join(f.root,"continuity/state.sqlite"));f.state.scopeId=P_SCOPE;await f.restart();
    await until(()=>f.client().protection(),v=>v.data.worker.reason==="store-unavailable");
    await assert.rejects(lstat(join(f.root,"continuity/state.sqlite")),(e:any)=>e.code==="ENOENT");
  }finally{await f.close();}
});

test("ownership that recovers during Routine inspection cannot be paused by an earlier loss observation",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    await until(()=>subject(f),v=>v?.ownership==="box");f.state.restoreOnRoutineRead=true;f.state.temporal.add(P_BOT);
    await until(async()=>f.state.calls.filter(path=>path==="/api/getAgentAutomations").length,n=>n>0);
    await until(()=>subject(f),v=>v?.ownership==="box"&&v.lossId===null);
    assert.equal(f.state.routines.get(P_BOT)![0]!.isEnabled,true);assert.equal(f.state.calls.includes("/api/setAgentAutomationEnabled"),false);
  }finally{await f.close();}
});

test("protection history reads preserve bytes after policy shutdown and use no native source",async()=>{
  const f=await protectionFixture(origin,{simulatedRestore:true});
  try{
    const current=await until(()=>subject(f),v=>!!v?.lastSnapshotRef);
    await f.client().changeProtection({requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,action:"system",enabled:false,confirmed:true});
    await until(()=>f.client().protection(),v=>v.data.worker.state==="disabled");
    const path=join(f.root,"continuity/state.sqlite"),before=await readFile(path),info=await lstat(path),calls=f.state.calls.length;
    await f.client().protection();await f.client().botProtection(P_BOT);await f.client().protectionSnapshots(P_BOT);await f.client().protectionSnapshot(current!.lastSnapshotRef!);
    assert.deepEqual(await readFile(path),before);assert.equal((await lstat(path)).mtimeMs,info.mtimeMs);assert.equal(f.state.calls.length,calls);
  }finally{await f.close();}
});

test("permission revoked at the final configuration admission blocks publication without deleting its old policy",async()=>{
  const f=await protectionFixture(origin,{disabled:true});let reads=0,revoke=false;
  try{
    f.serverOptions.readGrants=async()=>{reads++;const grants=structuredClone(f.state.grants);if(revoke&&reads>=2)grants[0]!.capabilities=grants[0]!.capabilities.filter(cap=>cap!=="protection.write");return grants;};
    await f.restart();const revision=(await f.client().protection()).data.revision,before=await readFile(join(f.root,"config.json"));reads=0;revoke=true;
    await rejects(f.client().changeProtection({requestId:randomUUID(),expectedRevision:revision,action:"system",enabled:true,confirmed:true}),"permission_denied");
    assert.ok(reads>=2);assert.deepEqual(await readFile(join(f.root,"config.json")),before);assert.equal(f.state.calls.length,0);
  }finally{await f.close();}
});

test("packaged Node protection survives SIGKILL with its same subject and loss guard, without a second native pause",async()=>{
  const f=await protectionFixture(origin);let child:ReturnType<typeof spawn>|undefined;
  async function launch(){
    child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,"system","service","run","server","--root",f.root,"--native-discovery",join(f.root,"gateway.json"),"--port","0"],{
      cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root},stdio:["ignore","pipe","pipe"]});
    let line="",errors="";child.stdout!.on("data",b=>line+=b);child.stderr!.on("data",b=>errors+=b);
    await until(async()=>line,v=>v.includes("\n"));const started=JSON.parse(line.trim().split("\n")[0]!);assert.equal(started.ok,true,errors);
    return new ManagementClient({baseUrl:started.data.url,installationId:P_INSTALL,credential:async()=>P_OWNER});
  }
  async function stop(signal:NodeJS.Signals){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const closed=once(child,"close"),timer=setTimeout(()=>child?.kill("SIGKILL"),5000);child.kill(signal);await closed;clearTimeout(timer);child=undefined;
  }
  try{
    await f.server.close();const first=await launch();
    await until(()=>first.botProtection(P_BOT),v=>v.data.subject?.ownership==="box");f.state.temporal.add(P_BOT);
    // This packaged process uses the production 30-second observation period,
    // not the millisecond ports used by the in-process fixture. Wait for that
    // real next observation; do not speed up production polling to pass a test.
    const loss=await until(()=>first.botProtection(P_BOT),v=>v.data.subject?.pause?.complete===true,40000);const id=loss.data.subject!.lossId;
    assert.equal(f.state.calls.filter(p=>p==="/api/setAgentAutomationEnabled").length,1);
    await stop("SIGKILL");const restarted=await launch();await until(()=>restarted.protection(),v=>v.data.worker.state==="running");
    const current=(await restarted.botProtection(P_BOT)).data.subject;assert.equal(current?.lossId,id);assert.equal(current?.pause?.complete,true);
    assert.equal(f.state.calls.filter(p=>p==="/api/setAgentAutomationEnabled").length,1);
    await stop("SIGTERM");const bytes=await readFile(join(f.root,"continuity/state.sqlite"));await delay(100);assert.deepEqual(await readFile(join(f.root,"continuity/state.sqlite")),bytes);
  }finally{await stop("SIGKILL");await f.close();}
});

test("a short internal Routine deadline cancels the native HTTP body instead of leaving it behind",async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    f.state.slowRoutines=true;
    const gateway=f.native.continuityAccess(new AbortController().signal);
    const started=Date.now();
    await assert.rejects(gateway.agentRoutines({action:"list",agentId:P_BOT},100));
    // The caller's timeout is not enough: the native socket must also close,
    // well before the fixture's separate one-second source deadline.
    await until(async()=>f.state.routineAborted,n=>n===1,400);
    assert.ok(Date.now()-started<800);
    assert.equal(f.state.calls.filter(path=>path==="/api/getAgentAutomations").length,1);
    assert.equal(f.state.calls.some(path=>path==="/api/setAgentAutomationEnabled"),false);
  }finally{await f.close();}
});

test("packaged CLI reads and changes policy through the same authenticated Server and original receipt",async()=>{
  const f=await protectionFixture(origin,{disabled:true});
  try{
    const before=await cli(f,["system","protection","get"]),id=randomUUID();
    const result=await cli(f,["system","protection","set","--enabled","false","--request-id",id,"--expect-revision",before.revision,"--confirm"]);
    assert.deepEqual(await cli(f,["operation","get","--domain","protection","--target","system","--request-id",id]),result);
    assert.equal((await cli(f,["bot","protection","get",P_BOT])).policySource,"default");assert.equal(f.state.calls.length,0);
  }finally{await f.close();}
});
