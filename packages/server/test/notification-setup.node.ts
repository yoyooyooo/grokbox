import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ManagementClient, type SetupRequest } from "@grokbox/client";
import { openConfigStore, rootConfigLayout, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { setupOperationKey } from "../src/notification-setup.ts";
import { MonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { setupFixture, SETUP_BOT, SETUP_INSTALLATION, SETUP_OWNER, SETUP_READER, SETUP_KEY } from "../../../apps/web/test/setup-fixture.ts";

async function cli(f:Awaited<ReturnType<typeof setupFixture>>,args:string[],input?:unknown,expected=0) {
  assert.ok(process.env.GROKBOX_TEST_CLI_ENTRY);
  const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,...args],{cwd:f.root,stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_SETUP_CREDENTIAL:SETUP_OWNER,GROKBOX_TEST_ALLOW_NATIVE:"0",GROKBOX_TEST_NATIVE_HOST:"0"}});
  let stdout="",stderr="";child.stdout.on("data",bytes=>{stdout+=bytes.toString();if(stdout.length>512*1024)child.kill("SIGKILL");});child.stderr.on("data",bytes=>{stderr+=bytes.toString();});
  child.stdin.on("error",()=>undefined);child.stdin.end(input===undefined?undefined:JSON.stringify(input));
  const timer=setTimeout(()=>child.kill("SIGKILL"),15000);const [code,signal]=await once(child,"close");clearTimeout(timer);
  assert.equal(signal,null);assert.equal(code,expected,stdout+stderr);assert.equal(stderr,"");assert.ok(!stdout.includes(SETUP_KEY));
  return JSON.parse(stdout);
}

export const SETUP_ORIGIN="https://setup.example.test";
export const setupBotRef=`bot:${SETUP_INSTALLATION}:${SETUP_BOT}`;
const rejects=(promise:Promise<unknown>,code:string)=>assert.rejects(promise,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
export async function configureSetup(f:Awaited<ReturnType<typeof setupFixture>>) {
  const settings=(await f.client().notificationSettings()).data;
  const request:SetupRequest={action:"settings",requestId:randomUUID(),confirmed:true,expectedRevision:settings.revision,
    settings:{alias:"default",botRef:setupBotRef,routineKey:"ops-notice",mode:"actionable-user",installationBudget:10,targetBudget:10}};
  const result=(await f.client().changeSetup(request)).data;
  return {request,result};
}
export async function prepareRoutine(f:Awaited<ReturnType<typeof setupFixture>>) {
  await configureSetup(f);
  const blueprint=(await f.client().notificationBlueprint("default")).data;
  const request:SetupRequest={action:"apply",requestId:randomUUID(),confirmed:true,botRef:setupBotRef,expectedRevision:null,blueprint};
  const result=(await f.client().changeSetup(request)).data;
  return {request,result};
}
export async function prepareBinding(f:Awaited<ReturnType<typeof setupFixture>>) {
  const {result:routine}=await prepareRoutine(f);
  const request:SetupRequest={action:"bind",requestId:randomUUID(),confirmed:true,alias:"default",routineRef:routine.resultRef!,databaseId:f.databaseId,
    expectedRevision:routine.revision as string,expectedBindingRevision:0};
  const result=(await f.client().changeSetup(request)).data;
  return {request,result,routine};
}
async function until(check:()=>boolean,max=5000) { const end=Date.now()+max;while(!check()){if(Date.now()>end)throw Error("setup_test_timeout");await new Promise(r=>setTimeout(r,10));} }

test("unprepared settings/Routine/receiver reads are bounded and do not initialize pairing or provision stores",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const before=await readdir(join(f.root,"state"));
    const settings=(await f.client().notificationSettings()).data;
    assert.equal(settings.targets[0]!.botRef,null);assert.equal(settings.targets[0]!.targetBudget,settings.installationBudget);
    assert.deepEqual((await f.client().routines(setupBotRef)).data.routines,[]);
    assert.deepEqual((await f.client().receivers()).data.receivers,[]);
    assert.deepEqual(await readdir(join(f.root,"state")),before);assert.equal(f.deliveries.length,0);
    assert.deepEqual(f.calls.map(c=>c.method),["getAgentAutomations"]);
  }finally{await f.close();}
});

test("first setup through shared API reaches automatic delivery without a legacy command, prior incident or test",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {result:binding,routine}=await prepareBinding(f);
    assert.equal(f.rows.length,1);assert.equal(f.rows[0]!.isEnabled,false);assert.equal(f.deliveries.length,0);
    assert.equal((await f.observations.incidents()).length,0);assert.equal((await f.client().notifications()).data.notifications.length,0);
    const enabled=(await f.client().changeSetup({action:"enable",routineRef:routine.resultRef!,requestId:randomUUID(),confirmed:true,expectedRevision:routine.revision as string})).data;
    assert.equal(enabled.grantsPermission,false);assert.equal(enabled.webhookInvoked,false);
    const receiver=(await f.client().receiver(binding.resultRef!)).data,verification=(await f.client().verifyReceiver(receiver.receiverRef)).data;
    assert.equal(verification.state,"ready");assert.equal(verification.testRequired,false);
    await f.client().changeReceiver({action:"enable",receiverRef:receiver.receiverRef,requestId:randomUUID(),confirmed:true,expectedRevision:receiver.revision,expectedModelRevision:verification.modelRevision!});
    assert.equal(f.deliveries.length,0);
    await f.emit();await until(()=>f.deliveries.length===1);
    const list=(await f.client().notifications()).data.notifications;assert.equal(list.length,1);assert.equal(list[0]!.purpose,"incident");
    assert.equal(list[0]!.userRead,"not_observed");assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);
    assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,1);
    for(const data of [binding,enabled,receiver,list]) assert.ok(!JSON.stringify(data).includes(SETUP_KEY));
  }finally{await f.close();}
});

test("settings commit preserves unrelated configuration; completed receipt survives later edits and corrupt config",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const initial=JSON.parse(await readFile(join(f.root,"config.json"),"utf8"));
    initial.desktop={keepAgentIds:[SETUP_BOT]};initial.ops={monitor:{enabled:false},targets:{other:{agentId:SETUP_BOT,routineKey:"untouched",enabled:false}},routing:{defaultTarget:"other"}};
    await publishConfigFile(join(f.root,"config.json"),initial);
    const {request,result}=await configureSetup(f),current=JSON.parse(await readFile(join(f.root,"config.json"),"utf8"));
    assert.deepEqual(current.desktop,initial.desktop);assert.deepEqual(current.client,initial.client);assert.deepEqual(current.ops.targets.other,initial.ops.targets.other);assert.equal(current.ops.monitor.enabled,false);
    await rejects(f.client().changeSetup({...request,settings:{...(request as Extract<SetupRequest,{action:"settings"}>).settings,targetBudget:3}} as SetupRequest),"idempotency_conflict");
    await rejects(f.client().changeSetup({...request,requestId:randomUUID()}),"revision_conflict");
    await publishConfigFile(join(f.root,"config.json"),{broken:true});
    assert.deepEqual((await f.client().changeSetup(request)).data,result);
    assert.deepEqual((await f.client().setupOperation("settings","installation",request.requestId)).data,result);
    assert.equal(f.calls.length,0);assert.equal(f.deliveries.length,0);
  }finally{await f.close();}
});

test("prepared config cannot acquire historical success merely because current bytes match its after hash",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {request}=await configureSetup(f),key=setupOperationKey(SETUP_INSTALLATION,"owner","settings","installation",request.requestId);
    const path=join(f.root,"state/config-operations",`${createHash("sha256").update(key).digest("hex")}.json`);
    const row=JSON.parse(await readFile(path,"utf8"));row.phase="prepared";await publishConfigFile(path,row);
    const before=await readFile(join(f.root,"config.json"));
    await rejects(f.client().changeSetup(request),"operation_unknown");
    assert.equal((await f.client().setupOperation("settings","installation",request.requestId)).data.state,"unknown");
    assert.deepEqual(await readFile(join(f.root,"config.json")),before);
    await assert.rejects(openConfigStore(rootConfigLayout(f.root)).receipt(key),{code:"config_commit_unknown"});
    assert.equal(JSON.parse(await readFile(path,"utf8")).phase,"prepared");
  }finally{await f.close();}
});

for(const phase of ["createAgentAutomation","getAutomationWebhookCredential","setAgentAutomationEnabled"] as const) test(`lost ${phase} reply keeps original guard across retries and management restart`,async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    let request:SetupRequest,kind:"routine"|"pairing",scope:string;
    if(phase==="createAgentAutomation"){
      await configureSetup(f);request={action:"apply",botRef:setupBotRef,blueprint:(await f.client().notificationBlueprint("default")).data,expectedRevision:null,requestId:randomUUID(),confirmed:true};kind="routine";scope=SETUP_BOT;
    }else{
      const {result}=await prepareRoutine(f);request=phase==="getAutomationWebhookCredential"
        ?{action:"bind",alias:"default",routineRef:result.resultRef!,databaseId:f.databaseId,expectedRevision:result.revision as string,expectedBindingRevision:0,requestId:randomUUID(),confirmed:true}
        :{action:"enable",routineRef:result.resultRef!,expectedRevision:result.revision as string,requestId:randomUUID(),confirmed:true};
      kind=phase==="getAutomationWebhookCredential"?"pairing":"routine";scope=kind==="pairing"?"installation":SETUP_BOT;
    }
    f.state.loseReply=phase;await rejects(f.client().changeSetup(request),"operation_unknown");
    const once=f.calls.filter(c=>c.method===phase).length;
    await rejects(f.client().changeSetup(request),"operation_unknown");assert.equal(f.calls.filter(c=>c.method===phase).length,once);
    await rejects(f.client().changeSetup({...request,requestId:randomUUID()}),phase==="setAgentAutomationEnabled"?"revision_conflict":"operation_unknown");
    await f.restart();
    // New fetch avoids a pooled socket whose previous server has just closed.
    const cold=new ManagementClient({baseUrl:f.server.url,installationId:SETUP_INSTALLATION,credential:async()=>SETUP_OWNER,fetch:(async (u,i)=>fetch(u,{...i,headers:{...Object.fromEntries(new Headers(i?.headers)),connection:"close"}})) as typeof fetch});
    assert.equal((await cold.setupOperation(kind,scope,request.requestId)).data.state,"unknown");
    assert.equal(f.calls.filter(c=>c.method===phase).length,once);assert.equal(f.deliveries.length,0);
  }finally{await f.close();}
});

test("pairing history survives unbind and another binding; repeating old bind does not mint again",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {request,result,routine}=await prepareBinding(f);
    const receiver=(await f.client().receiver(result.resultRef!)).data;
    await f.client().changeReceiver({action:"unbind",receiverRef:receiver.receiverRef,expectedRevision:receiver.revision,requestId:randomUUID(),confirmed:true});
    const changed=(await f.client().changeSetup({...request,requestId:randomUUID(),expectedBindingRevision:receiver.revision+1} as SetupRequest)).data;
    assert.notEqual(changed.resultRef,result.resultRef);
    assert.deepEqual((await f.client().changeSetup(request)).data,result);assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,2);
    assert.deepEqual((await f.client().setupOperation("pairing","installation",request.requestId)).data,result);
    assert.equal((await f.client().routine(routine.resultRef!)).data.routines[0]!.enabled,false);
  }finally{await f.close();}
});

test("independent capabilities and principal-scoped receipts prevent credential minting and disclosure",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {request,result}=await configureSetup(f);
    await rejects(f.client(SETUP_READER).changeSetup({...request,requestId:randomUUID()}),"permission_denied");
    await rejects(f.client(SETUP_READER).setupOperation("settings","installation",request.requestId),"not_found");
    const token="another-setup-owner";f.state.grants.push({principalId:"other",tokenSha256:createHash("sha256").update(token).digest("hex"),capabilities:[...CAPABILITIES_FOR_SETTINGS]});
    const other=(await f.client(token).changeSetup({...request,expectedRevision:(await f.client().notificationSettings()).data.revision})).data;
    assert.notEqual(other.operationRef,result.operationRef);
    const routine=await prepareRoutine(f);
    f.state.grants[1]!.capabilities = [...f.state.grants[1]!.capabilities,"routines.write"];
    await rejects(f.client(SETUP_READER).changeSetup({action:"bind",alias:"default",routineRef:routine.result.resultRef!,databaseId:f.databaseId,expectedRevision:routine.result.revision as string,expectedBindingRevision:0,confirmed:true,requestId:randomUUID()}),"permission_denied");
    assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,0);
  }finally{await f.close();}
});
const CAPABILITIES_FOR_SETTINGS=["notifications.write","notifications.read","operations.read"] as const;

test("managed Routine updates preserve exact native identity and unrelated definitions",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const unrelated={id:"unrelated",name:"Unrelated",prompt:"PRIVATE_UNRELATED_PROMPT",trigger:{type:"webhook"},isEnabled:true,createdAt:5};f.rows.push(structuredClone(unrelated));
    const {request,result}=await prepareRoutine(f);assert.equal(request.action,"apply");
    const updated=(await f.client().changeSetup({...request,requestId:randomUUID(),expectedRevision:result.revision as string,blueprint:{...(request as Extract<SetupRequest,{action:"apply"}>).blueprint,prompt:"A different bounded test-only reminder."}} as SetupRequest)).data;
    assert.equal(updated.resultRef,result.resultRef);assert.deepEqual(f.rows.find(r=>r.id==="unrelated"),unrelated);
    assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);assert.equal(f.calls.filter(c=>c.method==="updateAgentAutomation").length,1);
    assert.equal(f.rows.find(r=>r.id!=="unrelated")!.isEnabled,false);
    assert.ok(!JSON.stringify((await f.client().routines(setupBotRef)).data).includes("PRIVATE_UNRELATED_PROMPT"));
  }finally{await f.close();}
});

test("invalid native output is neither an empty success nor exported as error text",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    f.state.invalidMethod="getAgentAutomations";const error=await f.client().routines(setupBotRef).catch(e=>e);
    assert.ok(error.code==="source_invalid"||error.code==="source_unavailable");assert.ok(!JSON.stringify(error).includes("PRIVATE_SETUP_BAD_NATIVE"));assert.equal(f.rows.length,0);
  }finally{await f.close();}
});

test("packaged CLI completes first setup and retrieves the same scoped domain receipts",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const settings=(await cli(f,["notification","settings","get"])).data;
    const configure:SetupRequest={action:"settings",requestId:randomUUID(),confirmed:true,expectedRevision:settings.revision,settings:{alias:"default",botRef:setupBotRef,routineKey:"ops-notice",mode:"actionable-user",installationBudget:10,targetBudget:10}};
    const config=(await cli(f,["notification","settings","apply","--input","-"],configure)).data;
    assert.deepEqual((await cli(f,["operation","get","--domain","notification-settings","--request-id",configure.requestId])).data,config);
    const blueprint=(await cli(f,["notification","receiver","blueprint","default"])).data;
    const create:SetupRequest={action:"apply",requestId:randomUUID(),confirmed:true,expectedRevision:null,botRef:setupBotRef,blueprint};
    const created=(await cli(f,["routine","apply","--input","-"],create)).data;
    const routine=(await cli(f,["routine","list","--bot",SETUP_BOT])).data.routines[0];assert.equal(routine.routineRef,created.resultRef);
    const requestId=randomUUID();const bound=(await cli(f,["notification","receiver","bind","default","--routine-ref",routine.routineRef,"--database-id",f.databaseId,"--expect-revision",routine.revision,"--expect-binding-revision","0","--request-id",requestId,"--confirm"])).data;
    assert.deepEqual((await cli(f,["operation","get","--domain","pairing","--request-id",requestId])).data,bound);
    const enabled=(await cli(f,["routine","enable",routine.routineRef,"--expect-revision",routine.revision,"--request-id",randomUUID(),"--confirm"])).data;
    assert.equal(enabled.evidence,"requested-state-observed");assert.equal((await cli(f,["routine","get",routine.routineRef])).data.routines[0].enabled,true);
    assert.equal((await cli(f,["notification","receiver","verify",bound.resultRef])).data.state,"ready");
    assert.equal(f.deliveries.length,0);assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,1);
  }finally{await f.close();}
});

test("exact-ID provision reconciliation settles only the original guard and never recreates",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    await configureSetup(f);const request:SetupRequest={action:"apply",botRef:setupBotRef,blueprint:(await f.client().notificationBlueprint("default")).data,expectedRevision:null,confirmed:true,requestId:randomUUID()};
    f.state.loseReply="createAgentAutomation";await rejects(f.client().changeSetup(request),"operation_unknown");
    const routine=(await f.client().routines(setupBotRef)).data.routines[0]!;
    const result=(await cli(f,["operation","reconcile","--domain","routine","--request-id",request.requestId,"--routine-ref",routine.routineRef,"--expect-revision",routine.revision,"--confirm"])).data;
    assert.equal(result.state,"succeeded");assert.equal(result.resultRef,routine.routineRef);assert.equal(result.evidence,"disabled-definition-observed");
    assert.deepEqual((await f.client().changeSetup(request)).data,result);assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);
    const writes=f.calls.filter(c=>!c.method.startsWith("get")).length;
    await cli(f,["operation","reconcile","--domain","routine","--request-id",request.requestId,"--routine-ref",routine.routineRef,"--expect-revision",routine.revision,"--confirm"]);
    assert.equal(f.calls.filter(c=>!c.method.startsWith("get")).length,writes);
  }finally{await f.close();}
});

test("Routine state history survives later state changes and does not claim cancellation or causal attribution",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {result}=await prepareRoutine(f),ref=result.resultRef!;
    const enable:SetupRequest={action:"enable",routineRef:ref,expectedRevision:result.revision as string,requestId:randomUUID(),confirmed:true};
    const original=(await f.client().changeSetup(enable)).data;
    const disabled=(await f.client().changeSetup({action:"disable",routineRef:ref,expectedRevision:original.revision as string,requestId:randomUUID(),confirmed:true})).data;
    assert.deepEqual((await f.client().changeSetup(enable)).data,original);assert.equal((await f.client().routine(ref)).data.routines[0]!.enabled,false);
    const removed=(await f.client().changeSetup({action:"delete",routineRef:ref,expectedRevision:disabled.revision as string,requestId:randomUUID(),confirmed:true})).data;
    assert.equal(removed.evidence,"absent-in-returned-window");assert.equal(removed.nativeCompareAndSwap,false);assert.equal(removed.webhookInvoked,false);
    assert.deepEqual((await f.client().setupOperation("routine",SETUP_BOT,enable.requestId)).data,original);
    assert.equal(f.calls.filter(c=>c.method==="setAgentAutomationEnabled").length,2);
  }finally{await f.close();}
});

test("shutdown during credential retrieval leaves a recoverable unknown pairing, not a detached mint or writer",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {result}=await prepareRoutine(f),requestId=randomUUID();f.state.slowMethod="getAutomationWebhookCredential";
    const pending=f.client().changeSetup({action:"bind",alias:"default",routineRef:result.resultRef!,databaseId:f.databaseId,expectedRevision:result.revision as string,expectedBindingRevision:0,confirmed:true,requestId}).catch(e=>e);
    await until(()=>f.calls.some(c=>c.method==="getAutomationWebhookCredential"));await f.server.close();await pending;
    const before=await readFile(join(f.root,"state/ops-pairing/bindings.json"));await new Promise(r=>setTimeout(r,30));assert.deepEqual(await readFile(join(f.root,"state/ops-pairing/bindings.json")),before);
    f.state.slowMethod="";await f.restart();
    const resultRead=(await cli(f,["operation","get","--domain","pairing","--request-id",requestId])).data;
    assert.equal(resultRead.state,"unknown");assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,1);
  }finally{await f.close();}
});

test("concurrent Routine submissions share the original dispatch guard instead of sending twice",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    const {result}=await prepareRoutine(f),input:SetupRequest={action:"enable",routineRef:result.resultRef!,expectedRevision:result.revision as string,confirmed:true,requestId:randomUUID()};
    const outcomes=await Promise.allSettled([f.client().changeSetup(input),f.client().changeSetup(input)]);
    assert.ok(outcomes.some(r=>r.status==="fulfilled"));
    for(const r of outcomes)if(r.status==="rejected")assert.ok(["operation_unknown","source_unavailable"].includes(r.reason.code));
    assert.equal(f.calls.filter(c=>c.method==="setAgentAutomationEnabled").length,1);
    assert.equal((await f.client().setupOperation("routine",SETUP_BOT,input.requestId)).data.state,"succeeded");
    assert.equal((await f.client().changeSetup(input)).data.state,"succeeded");
    assert.equal(f.calls.filter(c=>c.method==="setAgentAutomationEnabled").length,1);
  }finally{await f.close();}
});

test("a lost Routine reservation COMMIT callback leaves a durable no-dispatch guard",async()=>{
  const f=await setupFixture(SETUP_ORIGIN),run=MonitorSqlite.prototype.run;
  let selected:MonitorSqlite|undefined,injected=false;
  try{
    const {result}=await prepareRoutine(f),input:SetupRequest={action:"enable",routineRef:result.resultRef!,expectedRevision:result.revision as string,confirmed:true,requestId:randomUUID()};
    MonitorSqlite.prototype.run=async function(sql,params){
      if(sql.startsWith("INSERT INTO state_operations"))selected=this;
      await run.call(this,sql,params);
      if(this===selected&&sql==="COMMIT"&&!injected){injected=true;throw Error("synthetic_lost_setup_commit");}
    };
    await rejects(f.client().changeSetup(input),"operation_unknown");MonitorSqlite.prototype.run=run;
    assert.equal(injected,true);assert.equal((await f.client().setupOperation("routine",SETUP_BOT,input.requestId)).data.state,"unknown");
    await rejects(f.client().changeSetup(input),"operation_unknown");
    await rejects(f.client().changeSetup({...input,requestId:randomUUID()}),"operation_unknown");
    assert.equal(f.calls.filter(c=>c.method==="setAgentAutomationEnabled").length,0);
  }finally{MonitorSqlite.prototype.run=run;await f.close();}
});

test("generation changes after preflight prevent dispatch to a replacement native process",async()=>{
  const f=await setupFixture(SETUP_ORIGIN);try{
    await configureSetup(f);const blueprint=(await f.client().notificationBlueprint("default")).data;
    f.state.changeGenerationAfterList=true;
    await rejects(f.client().changeSetup({action:"apply",botRef:setupBotRef,blueprint,expectedRevision:null,confirmed:true,requestId:randomUUID()}),"operation_unknown");
    assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,0);
  }finally{await f.close();}
});
