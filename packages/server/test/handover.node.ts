import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, CAPABILITIES, type HandoverAction, type HandoverChange } from "@grokbox/client";
import { startManagementServer } from "../src/server.ts";
import { handoverFixture, H_INSTALL, H_SCOPE, H_SOURCE, H_TARGET, H_PEER, H_GROUP, H_OWNER, H_READER, H_OTHER } from "../../../apps/web/test/handover-fixture.ts";
const origin="https://handover.example.test";
type Fixture=Awaited<ReturnType<typeof handoverFixture>>;
const writes=(f:Fixture)=>f.state.calls.filter(c=>/\/(updateAgent|sendPrompt|setGroupMembers|createAgentAutomation|setAgentAutomationEnabled|setHostSettings|assignAgentToSidebarSection)$/.test(c.path));
async function declaration(f:Fixture,action:HandoverAction="advance",extra:Partial<HandoverChange>={}):Promise<HandoverChange>{return {requestId:randomUUID(),handoverRef:f.ref,action,expectedRevision:(await f.client().protectionHandover(f.ref)).data.revision,confirmed:true,...extra};}
const continuation=(r:HandoverChange,action:"reconcile"|"resume"|"cancel")=>({requestId:r.requestId,scopeId:H_SCOPE,action,confirmed:true as const});
async function until<A>(read:()=>Promise<A>,check:(v:A)=>boolean){const end=Date.now()+10000;let last:unknown;do{const v=await read();if(check(v))return v;last=v;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);throw Error(`handover_wait:${JSON.stringify(last)}`);}
async function advanced(f:Fixture){
 const done=(await f.client().changeHandover(await declaration(f))).data;
 assert.equal(done.state,"completed");assert.equal(done.result!.remaining,1,"one bounded batch must follow dependencies, not storage UUID order");
}

test("handover GET uses one original CONT snapshot and exposes no private declaration or native effects",async()=>{
 const f=await handoverFixture(origin);try{
  const before=await readFile(join(f.root,"continuity/state.sqlite")),v=(await f.client(H_READER).protectionHandover(f.ref)).data;
  assert.equal(v.activated,true);assert.equal(v.assessment,null);assert.match(v.revision,/^[a-f0-9]{64}$/);assert.equal(f.state.calls.length,0);
  assert.equal(JSON.stringify(v).includes("PRIVATE_"),false);assert.deepEqual(await readFile(join(f.root,"continuity/state.sqlite")),before);
  await assert.rejects(f.client(H_READER).changeHandover(await declaration(f)),{code:"permission_denied"});assert.equal(writes(f).length,0);
 }finally{await f.close();}
});
test("managed handover executes original duties through HTTP, preserves peers and Routine ordering, and repeated requests only read history",async()=>{
 const f=await handoverFixture(origin);try{
  f.state.loseNotice=true;await advanced(f);
  assert.deepEqual(f.rows.find(r=>r.id===H_GROUP).memberIds,[H_TARGET,H_PEER]);assert.equal(f.routines.get(H_SOURCE)![0].isEnabled,false);
  assert.equal(f.routines.get(H_TARGET)!.length,1);assert.equal(f.routines.get(H_TARGET)![0].isEnabled,true);
  const create=f.state.calls.findIndex(r=>r.path.endsWith("/createAgentAutomation")),stop=f.state.calls.findIndex(r=>r.path.endsWith("/setAgentAutomationEnabled")&&r.body.id===H_SOURCE),enable=f.state.calls.findIndex(r=>r.path.endsWith("/setAgentAutomationEnabled")&&r.body.id===H_TARGET);
  assert.ok(create>=0&&stop>create&&enable>stop);assert.equal(f.state.calls[create]!.body.spec.isEnabled,false);
  assert.equal(f.state.calls.filter(c=>c.path.endsWith("/sendPrompt")&&c.body.agentId===H_PEER).length,1);
  assert.equal((await f.client().protectionHandover(f.ref)).data.remaining,1);
  const r=await declaration(f),done=(await f.client().changeHandover(r)).data;assert.equal(done.state,"completed");assert.equal(done.result!.allDutiesComplete,false);
  const calls=f.state.calls.length;f.state.unavailable=true;assert.deepEqual((await f.client().changeHandover(r)).data,done);await f.restart();
  assert.deepEqual((await f.client().handoverOperation(H_SCOPE,r.requestId)).data,done);assert.equal(f.state.calls.length,calls);
  await assert.rejects(f.client().changeHandover({...r,expectedRevision:"0".repeat(64)}),{code:"idempotency_conflict"});
 }finally{await f.close();}
});
test("another principal cannot take over a manual replacement or its retained handover requests",async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f);await assert.rejects(f.client(H_OTHER).changeHandover(r),{code:"not_found"});assert.equal(writes(f).length,0);
  await f.client().changeHandover(r);await assert.rejects(f.client(H_OTHER).handoverOperation(H_SCOPE,r.requestId),{code:"not_found"});
 }finally{await f.close();}
});
test("fresh source-account and successor ownership are required before reservation, not just a caller's permission",async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f);f.state.targetReady=false;await assert.rejects(f.client().changeHandover(r),{code:"revision_conflict"});f.state.targetReady=true;
  f.state.sourceOwned=false;await assert.rejects(f.client().changeHandover(r),{code:"revision_conflict"});assert.equal(writes(f).length,0);
  await assert.rejects(f.client().handoverOperation(H_SCOPE,r.requestId),{code:"not_found"});
 }finally{await f.close();}
});
for(const resume of [false,true])test(`lost preparation ${resume?"resumes the saved declaration":"cancels before any native work"}`,async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f);let once=true;f.hooks.afterCommit=async label=>{if(label==="managed-handover-prepare"&&once){once=false;throw Error("lost prepare");}};
  await assert.rejects(f.client().changeHandover(r),{code:"operation_unknown"});assert.equal(writes(f).length,0);
  assert.equal((await f.client().handoverOperation(H_SCOPE,r.requestId)).data.state,"admitted");
  const done=(await f.client().continueHandover(continuation(r,resume?"resume":"cancel"))).data;assert.equal(done.state,resume?"completed":"cancelled");
  const calls=f.state.calls.length;assert.deepEqual((await f.client().changeHandover(r)).data,done);assert.equal(f.state.calls.length,calls);
 }finally{await f.close();}
});
for(const phase of ["managed-handover-claim","managed-handover-settle"])test(`lost ${phase} commit acknowledgment never replaces duty identities`,async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f);let once=true;f.hooks.afterCommit=async label=>{if(label===phase&&once){once=false;throw Error("lost ack");}};
  if(phase.endsWith("claim")){await assert.rejects(f.client().changeHandover(r),{code:"operation_unknown"});assert.equal(writes(f).length,0);await f.restart();
   await assert.rejects(f.client().changeHandover({...r,requestId:randomUUID()}),{code:"revision_conflict"});
   const reconciled=(await f.client().continueHandover(continuation(r,"reconcile"))).data;assert.equal(reconciled.state,"completed");assert.equal(writes(f).length,0);
  }else{assert.equal((await f.client().changeHandover(r)).data.state,"completed");const count=writes(f).length;await f.restart();await f.client().changeHandover(r);assert.equal(writes(f).length,count);}
  assert.equal(once,false);
 }finally{await f.close();}
});
test("permission revoked by the actual duty claim prevents its native write and reconciliation cannot redispatch it",async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f);f.hooks.afterCommit=async label=>{if(label==="handover-progress"&&(await f.controls.items(f.operationId)).some(i=>i.state==="effect_unknown"))f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="handover.write");};
  await assert.rejects(f.client().changeHandover(r),{code:"operation_unknown"});assert.equal(writes(f).length,0);
  assert.ok((await f.controls.items(f.operationId)).some(i=>i.state==="effect_unknown"));f.hooks.afterCommit=undefined;f.state.grants[0]!.capabilities=[...CAPABILITIES];
  await f.client().continueHandover(continuation(r,"reconcile"));assert.equal(writes(f).length,0);
  assert.ok((await f.controls.items(f.operationId)).some(i=>i.state==="effect_unknown"));
 }finally{await f.close();}
});
test("message authority remains independent even when the saved workflow permits formal user notices",async()=>{
 const f=await handoverFixture(origin);try{
  f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="handover.messages");
  await assert.rejects(f.client().changeHandover(await declaration(f)),{code:"permission_denied"});assert.equal(writes(f).length,0);
 }finally{await f.close();}
});
test("explicit observation creates verifiable per-duty evidence without native writes; attestation reobserves that exact evidence",async()=>{
 const f=await handoverFixture(origin);try{
  await advanced(f);const count=writes(f).length,observed=(await f.client().changeHandover(await declaration(f,"observe"))).data;
  assert.equal(writes(f).length,count);assert.equal(observed.result!.outcome,"observed");assert.ok(observed.result!.assessment!.blockers.includes("deletion_boundary_unavailable"));
  const evidence=observed.result!.observations.find(o=>o.state==="complete")!;assert.ok(evidence.evidenceRef);
  const r=await declaration(f,"attest",{itemId:evidence.itemId,evidenceRef:evidence.evidenceRef!}),done=(await f.client().changeHandover(r)).data;
  assert.equal(done.result!.outcome,"attested");assert.equal(writes(f).length,count);assert.equal(done.result!.allDutiesComplete,false);
  assert.ok((await f.controls.items(f.operationId)).some(i=>i.kind==="external-task"&&i.state!=="complete"));
  assert.equal(JSON.stringify(done).includes("PRIVATE_"),false);
 }finally{await f.close();}
});
test("an arbitrary hash or fabricated/cross-principal observation cannot certify external dependencies",async()=>{
 const f=await handoverFixture(origin);try{
  await advanced(f);const observed=(await f.client().changeHandover(await declaration(f,"observe"))).data,external=observed.result!.observations.find(o=>o.state==="unsupported")!;
  const count=writes(f).length;
  const arbitrary=await declaration(f,"attest",{itemId:external.itemId,evidenceRef:"f".repeat(64)});
  assert.throws(()=>f.client().changeHandover(arbitrary),{code:"invalid_input"});
  const forged=`handover-evidence:${H_INSTALL}:${H_SCOPE}:${observed.requestId}:${external.itemId}:${"f".repeat(64)}`;
  const r=await declaration(f,"attest",{itemId:external.itemId,evidenceRef:forged});
  await assert.rejects(f.client().changeHandover(r),{code:"invalid_input"});
  await assert.rejects(f.client().handoverOperation(H_SCOPE,r.requestId),{code:"not_found"});
  assert.ok((await f.controls.items(f.operationId)).some(i=>i.itemId===external.itemId&&i.state!=="complete"));assert.equal(writes(f).length,count);
 }finally{await f.close();}
});
test("retirement consumes observed evidence but retains the source when resource or native deletion coverage is missing",async()=>{
 const f=await handoverFixture(origin);try{
  await advanced(f);const observation=(await f.client().changeHandover(await declaration(f,"observe"))).data;
  const result=(await f.client().changeHandover(await declaration(f,"retire",{evidenceRef:observation.operationRef}))).data;
  assert.equal(result.result!.outcome,"blocked");assert.equal(result.result!.sourceDeleted,false);assert.ok(f.rows.some(r=>r.id===H_SOURCE));
  assert.ok(f.state.calls.every(c=>!c.path.includes("deleteAgent")));assert.ok(result.result!.assessment!.blockers.includes("source_resources_still_referenced"));
 }finally{await f.close();}
});
test("marker-like user text remains activity and a rewritten or malformed native window remains a coverage gap",async()=>{
 const f=await handoverFixture(origin);try{
  const first=(await f.client().changeHandover(await declaration(f,"observe"))).data;assert.equal(first.result!.assessment!.newMessages,1);
  f.transcripts.get(H_SOURCE)!.push({id:"new-inbound",kind:"message",role:"user",content:"quoted [grokbox-handoff: not origin authority",timestampMs:2});
  const next=(await f.client().changeHandover(await declaration(f,"observe"))).data;assert.equal(next.result!.assessment!.newMessages,1);
  f.transcripts.get(H_SOURCE)!.at(-1)!.content="rewritten";
  const changed=(await f.client().changeHandover(await declaration(f,"observe"))).data;assert.equal(changed.result!.assessment!.gap,true);
  f.transcripts.get(H_SOURCE)!.push({...f.transcripts.get(H_SOURCE)!.at(-1)!});
  const duplicate=(await f.client().changeHandover(await declaration(f,"observe"))).data;assert.equal(duplicate.result!.assessment!.gap,true);
 }finally{await f.close();}
});
test("retirement reconciliation never probes or dispatches a new deletion opportunity",async()=>{
 const f=await handoverFixture(origin);try{
  await advanced(f);const observed=(await f.client().changeHandover(await declaration(f,"observe"))).data;
  const r=await declaration(f,"retire",{evidenceRef:observed.operationRef});let once=true;
  f.hooks.afterCommit=async label=>{if(label==="managed-handover-claim"&&once){once=false;throw Error("claim-lost");}};
  await assert.rejects(f.client().changeHandover(r),{code:"operation_unknown"});f.hooks.afterCommit=undefined;
  const calls=f.state.calls.length;f.state.unavailable=true;await f.restart();
  await assert.rejects(f.client().continueHandover(continuation(r,"reconcile")),{code:"operation_unknown"});
  assert.equal(f.state.calls.length,calls);assert.equal((await f.client().handoverOperation(H_SCOPE,r.requestId)).data.state,"unknown");
  await assert.rejects(f.client().continueHandover(continuation(r,"cancel")),{code:"revision_conflict"});assert.ok(f.rows.some(r=>r.id===H_SOURCE));
 }finally{await f.close();}
});
test("changed native duty evidence blocks attestation without overwriting the current item",async()=>{
 const f=await handoverFixture(origin);try{
  await advanced(f);const observed=(await f.client().changeHandover(await declaration(f,"observe"))).data;
  const items=await f.controls.items(f.operationId),member=items.find(i=>i.kind==="group-members")!,proof=observed.result!.observations.find(i=>i.itemId===member.itemId)!;
  f.rows.find(r=>r.id===H_GROUP).memberIds=[H_TARGET,H_PEER,H_SOURCE];const calls=writes(f).length;
  const blocked=(await f.client().changeHandover(await declaration(f,"attest",{itemId:member.itemId,evidenceRef:proof.evidenceRef!}))).data;
  assert.equal(blocked.result!.outcome,"blocked");assert.equal(blocked.result!.reason,"evidence_changed");assert.equal(writes(f).length,calls);
  assert.deepEqual((await f.controls.items(f.operationId)).find(i=>i.itemId===member.itemId),member);
 }finally{await f.close();}
});
test("concurrent Server instances share the original handover lock and never repeat its duty effects",async()=>{
 const f=await handoverFixture(origin);let second:Awaited<ReturnType<typeof startManagementServer>>|undefined;
 try{
  const r=await declaration(f);f.state.stallAfterWrite=true;const pending=f.client().changeHandover(r);void pending.catch(()=>undefined);
  await until(async()=>f.state.waiting,n=>n>0);
  second=await startManagementServer({...f.serverOptions,port:0});
  const client=new ManagementClient({baseUrl:second.url,installationId:H_INSTALL,credential:async()=>H_OWNER});
  assert.equal((await client.identity()).data.installationId,H_INSTALL);
  await assert.rejects(client.changeHandover(r),{code:"operation_unknown"});assert.equal(writes(f).length,1);
  f.state.stallAfterWrite=false;f.state.release.resolve();const done=(await pending).data;assert.equal(done.state,"completed");
  const calls=writes(f).length;assert.deepEqual((await client.handoverOperation(H_SCOPE,r.requestId)).data,done);assert.equal(writes(f).length,calls);
 }finally{f.state.release.resolve();await second?.close();await f.close();}
});
test("packed CLI reads and advances the same handover and rejects the removed direct commands",async()=>{
 const f=await handoverFixture(origin);
 async function cli(args:string[],expected=0){
  const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,...args],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,HANDOVER_MANAGEMENT_TOKEN:H_OWNER},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
  const timer=setTimeout(()=>child.kill("SIGKILL"),20000),[code,signal]=await once(child,"close");clearTimeout(timer);
  assert.equal(signal,null);assert.equal(code,expected,out+err);assert.ok(!/PRIVATE_|synthetic-handover-owner/.test(out+err));return out?JSON.parse(out):null;
 }
 try{
  const head=(await cli(["bot","handover","get",f.ref])).data,id=randomUUID();
  const done=(await cli(["bot","handover","advance",f.ref,"--expect-revision",head.revision,"--request-id",id,"--confirm"])).data;
  assert.equal(done.state,"completed");assert.equal(done.result.remaining,1);const calls=f.state.calls.length;f.state.unavailable=true;
  assert.deepEqual((await cli(["operation","get","--domain","handover","--scope-id",H_SCOPE,"--request-id",id])).data,done);assert.equal(f.state.calls.length,calls);
  await cli(["agents","handover","advance","--operation-id",f.operationId,"--scope-id",H_SCOPE,"--confirm"],2);
 }finally{await f.close();}
});
test("packed Server death after a native write leaves one unknown duty and resumes only the original identity",async()=>{
 const f=await handoverFixture(origin,{principalId:"installation-owner"});let child:ReturnType<typeof spawn>|undefined;
 async function stop(signal:NodeJS.Signals){if(!child||child.exitCode!==null||child.signalCode!==null)return;const closed=once(child,"close"),timer=setTimeout(()=>child?.kill("SIGKILL"),5000);child.kill(signal);await closed;clearTimeout(timer);child=undefined;}
 async function launch(){
  child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,"system","service","run","server","--root",f.root,"--native-discovery",join(f.root,"gateway.json"),"--port","0"],{cwd:f.root,env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root},stdio:["ignore","pipe","pipe"]});
  let out="",err="";child.stdout!.on("data",b=>out+=b);child.stderr!.on("data",b=>err+=b);await until(async()=>out.includes("\n"),Boolean);
  const started=JSON.parse(out.split("\n")[0]!);assert.equal(started.ok,true,err);return new ManagementClient({baseUrl:started.data.url,installationId:H_INSTALL,credential:async()=>H_OWNER});
 }
 try{
  const r=await declaration(f);await f.server.close();const first=await launch();f.state.stallAfterWrite=true;
  let rejection:unknown;
  const pending=first.changeHandover(r).catch(e=>{rejection=e;});await until(async()=>{if(rejection)throw rejection;return f.state.waiting;},n=>n>0);const original=writes(f)[0]!;
  await stop("SIGKILL");await pending;f.state.stallAfterWrite=false;f.state.release.resolve();const second=await launch();
  assert.equal((await second.handoverOperation(H_SCOPE,r.requestId)).data.state,"unknown");
  const result=(await second.continueHandover(continuation(r,"resume"))).data;assert.equal(result.state,"completed");
  assert.equal(writes(f).filter(c=>c.path===original.path&&JSON.stringify(c.body)===JSON.stringify(original.body)).length,1);
  await stop("SIGTERM");const before=await readFile(join(f.root,"continuity/state.sqlite"));await new Promise(r=>setTimeout(r,50));assert.deepEqual(await readFile(join(f.root,"continuity/state.sqlite")),before);
 }finally{f.state.release.resolve();await stop("SIGKILL");await f.close();}
});
test("shutdown cancels the native read, joins durable work and never performs a late CONT write",async()=>{
 const f=await handoverFixture(origin);try{
  const r=await declaration(f,"observe");f.state.stallRead="/api/getAgentTranscriptTail";const pending=f.client().changeHandover(r).catch(e=>e);
  await until(async()=>f.state.waiting,n=>n>0);await f.server.close();await pending;await until(async()=>f.state.aborted,n=>n>0);
  const file=join(f.root,"continuity/state.sqlite"),before=await readFile(file);f.state.release.resolve();await new Promise(r=>setTimeout(r,50));assert.deepEqual(await readFile(file),before);
  f.state.stallRead="";await f.restart();assert.equal((await f.client().handoverOperation(H_SCOPE,r.requestId)).data.state,"unknown");
  assert.equal((await f.client().continueHandover(continuation(r,"resume"))).data.state,"completed");
 }finally{await f.close();}
});
