import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeSetupRequest, type SetupRequest } from "../src/client.ts";
const I="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",D="33333333-3333-4333-8333-333333333333",R="a".repeat(64);
const botRef=`bot:${I}:${B}`,routineRef=`routine:${I}:${B}:routine-1`;
const request=():SetupRequest=>({action:"apply",requestId:randomUUID(),confirmed:true,expectedRevision:null,botRef,blueprint:{schemaVersion:1,key:"notice",name:"Notice",prompt:"Fixed bounded prompt",isEnabled:false,trigger:{type:"webhook"}}});
const response=(data:unknown)=>Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:true,data});
function client(reply:()=>Response){let calls=0;const fetch=Object.assign(async()=>{calls++;return reply();},{preconnect:()=>undefined})as typeof globalThis.fetch;return {client:new ManagementClient({baseUrl:"http://127.0.0.1:12345",installationId:I,fetch}),calls:()=>calls};}
const receipt=(input:SetupRequest)=>({version:1,kind:"routine",action:"apply",requestId:input.requestId,operationRef:`setup-operation:${I}:routine:${B}:${R}`,targetRef:botRef,resultRef:routineRef,state:"succeeded",beforeRevision:null,revision:R,evidence:"disabled-definition-observed",nativeCompareAndSwap:false,webhookInvoked:false,grantsPermission:false});

test("setup rejects unscoped targets, mixed actions, implicit consent and secret-bearing input fields before transport",async()=>{
  const f=client(()=>{throw Error("unexpected transport");}),input=request();
  for(const patch of [{confirmed:false},{requestId:"bad"},{botRef:`bot:${D}:${B}`},{unexpected:"secret"},{action:"enable"},{expectedRevision:1}]){
    await expect(f.client.changeSetup({...input,...patch}as never)).rejects.toBeDefined();
  }
  await expect(f.client.changeSetup({...input,blueprint:{...(input as Extract<SetupRequest,{action:"apply"}>).blueprint,isEnabled:true}}as never)).rejects.toMatchObject({code:"invalid_input"});
  expect(f.calls()).toBe(0);
});

test("settings and native Routine responses reject private additions and unbounded source shapes",async()=>{
  const settings={revision:R,mode:"off",installationBudget:2,selectedAlias:"default",advancedRouting:false,opsEnabled:true,targets:[{alias:"default",botRef:null,routineKey:null,targetBudget:2,enabled:true}],source:"configuration",grantsPermission:false};
  expect((await client(()=>response(settings)).client.notificationSettings()).data.targets).toHaveLength(1);
  for(const patch of [{secret:"private"},{installationBudget:null},{grantsPermission:true},{targets:[settings.targets[0],settings.targets[0]]}])await expect(client(()=>response({...settings,...patch})).client.notificationSettings()).rejects.toMatchObject({code:"protocol_error"});
  const routine={id:"routine-1",name:"Notice",enabled:false,trigger:{type:"webhook"},revision:R,definitionRevision:R,mutable:true,createdAtMs:1,lastRunAtMs:null,nextRunAtMs:null,promptIncluded:false,credentialsIncluded:false,nativeCompareAndSwap:false,routineRef,botRef};
  const page={botRef,routines:[routine],generation:R,coverage:{kind:"native_returned_window",limit:100,atLimit:false,complete:false}};
  expect((await client(()=>response(page)).client.routine(routineRef)).data.routines).toHaveLength(1);
  for(const patch of [{prompt:"private"},{credentialsIncluded:true},{routineRef:`routine:${I}:${B}:another`},{nativeCompareAndSwap:true}])await expect(client(()=>response({...page,routines:[{...routine,...patch}]})).client.routine(routineRef)).rejects.toMatchObject({code:"protocol_error"});
});

test("successful setup response must bind original action, target, revision, installation and explicit evidence boundary",async()=>{
  const input=request(),good=receipt(input);
  expect((await client(()=>response(good)).client.changeSetup(input)).data.state).toBe("succeeded");
  for(const patch of [{action:"enable"},{targetRef:`bot:${I}:${D}`},{requestId:randomUUID()},{beforeRevision:R},{grantsPermission:true},{webhookInvoked:true},{nativeCompareAndSwap:true},{evidence:"credential-stored"},{operationRef:`setup-operation:${I}:routine:${B}:extra:${R}`}]){
    const f=client(()=>response({...good,...patch}));
    await expect(f.client.changeSetup(input)).rejects.toMatchObject({code:"operation_unknown",details:{requestId:input.requestId,lookupPath:`/v1/setup-operations/routine/${B}/${input.requestId}`}});expect(f.calls()).toBe(1);
  }
});

test("caller edits during credential resolution cannot change native setup or recovery identity",async()=>{
  let release!:(value:string)=>void,sent:unknown;
  const input=request(),original=input.requestId;
  const f=new ManagementClient({baseUrl:"http://127.0.0.1:12345",installationId:I,credential:()=>new Promise(resolve=>{release=resolve;}),
    fetch:Object.assign(async(_url:unknown,init?:RequestInit)=>{sent=JSON.parse(String(init?.body));throw Error("lost");},{preconnect:()=>undefined})as typeof fetch});
  const pending=f.changeSetup(input);await Promise.resolve();input.requestId=randomUUID();(input as Extract<SetupRequest,{action:"apply"}>).blueprint.prompt="changed-after-submission";release("synthetic-credential");
  await expect(pending).rejects.toMatchObject({code:"operation_unknown",details:{requestId:original}});
  expect(sent).toMatchObject({requestId:original,blueprint:{prompt:"Fixed bounded prompt"}});
});

test("normalization separates definition changes, private binding, and explicit reconciliation without fetching keys",()=>{
  expect(normalizeSetupRequest({action:"bind",requestId:randomUUID(),confirmed:true,routineRef,databaseId:D,alias:"default",expectedRevision:R,expectedBindingRevision:0},I)).toMatchObject({action:"bind",expectedBindingRevision:0});
  expect(normalizeSetupRequest({action:"reconcile",requestId:randomUUID(),confirmed:true,routineRef,expectedRevision:R},I)).toMatchObject({action:"reconcile"});
  expect(()=>normalizeSetupRequest({action:"settings",requestId:randomUUID(),confirmed:true,expectedRevision:R,settings:{alias:"default",botRef,routineKey:"notice",mode:"off",installationBudget:2,targetBudget:2,key:"never"}},I)).toThrow();
});
