import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeJobStart, type JobView, type JobStart } from "../src/client.ts";
import { jobView, jobLogs, jobCancellation } from "../src/job-validation.ts";
const I="11111111-1111-4111-8111-111111111111",id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",ref=`job:${I}:${id}`,hash="f".repeat(64);
const input=():JobStart=>({requestId:randomUUID(),expectedRevision:hash,confirmed:true,argv:["node","-e","process.exit(0)"],environment:{VISIBLE:"private-env-value"},cwd:"workspace:/",runTimeoutMs:1000,output:"capture",shell:false});
const row=(r:JobStart):JobView=>({version:1,jobRef:ref,requestId:r.requestId,policyRevision:r.expectedRevision,state:"queued",observation:"current-service",createdAt:1,startedAt:null,finishedAt:null,cwd:"workspace:/",command:{executable:"node",argumentCount:2,shell:false},output:"capture",runTimeoutMs:1000,exitCode:null,signal:null,reason:null,cancelOperationId:null,logs:{bytes:0,nextOffset:0,truncated:false},effectsReverted:false});
const envelope=(data:unknown)=>Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:true,data});
test("strict Job input never reads accessors, inherits authority, expands shell, or resolves credentials for invalid fields",async()=>{
  let getters=0,calls=0;const api=new ManagementClient({baseUrl:"http://127.0.0.1:3000",installationId:I,credential:async()=>{calls++;return "credential";},fetch:Object.assign(async()=>{throw Error("unexpected");},{preconnect:()=>undefined})});
  const getter={...input()};Object.defineProperty(getter,"confirmed",{enumerable:true,get:()=>{getters++;return true;}});
  const inherited=Object.create(input()),hidden={...input()};Object.defineProperty(hidden,"secret",{value:true});
  const array=input();Object.defineProperty(array.argv,"0",{get:()=>{getters++;return "node";},enumerable:true});
  for(const r of [getter,inherited,hidden,array,{...input(),[Symbol("hidden")]:true},{...input(),confirmed:false},{...input(),argv:["node",undefined]},{...input(),runTimeoutMs:-1},{...input(),expectedRevision:"old"},{...input(),shell:true},{...input(),url:"arbitrary"}])await expect(api.startJob(r as never)).rejects.toMatchObject({code:"invalid_input"});
  expect(getters).toBe(0);expect(calls).toBe(0);
  const original=input(),captured=normalizeJobStart(original);original.argv[0]="changed";original.environment.VISIBLE="changed";expect(captured.argv[0]).toBe("node");expect(captured.environment.VISIBLE).toBe("private-env-value");
});
test("lost Job reply preserves the original immutable request and exact recovery path, with one POST",async()=>{
  const r=input(),old=structuredClone(r);let release!:(s:string)=>void,body="",calls=0;
  const api=new ManagementClient({baseUrl:"http://127.0.0.1:3000",installationId:I,credential:()=>new Promise(done=>release=done),fetch:Object.assign(async(_u:string|URL|Request,init?:RequestInit)=>{calls++;body=String(init?.body);throw Error("lost");},{preconnect:()=>undefined})});
  const pending=api.startJob(r);await Promise.resolve();r.argv[0]="substitute";r.requestId=randomUUID();r.expectedRevision="a".repeat(64);release("private-test-credential");
  await expect(pending).rejects.toMatchObject({code:"operation_unknown",details:{requestId:old.requestId,lookupPath:`/v1/job-operations/${old.requestId}`}});expect(JSON.parse(body)).toEqual(old);expect(calls).toBe(1);
});
test("Job receipts must match request, policy and projected inputs; unverified writes stay unknown",async()=>{
  const r=input(),valid=row(r);
  for(const change of [{requestId:randomUUID()},{policyRevision:"a".repeat(64)},{effectsReverted:true},{argv:r.argv},{state:"succeeded"},{observation:"retained-record"},{command:{...valid.command,executable:"other"}}]){
    const api=new ManagementClient({baseUrl:"http://127.0.0.1:3000",installationId:I,fetch:Object.assign(async()=>envelope({...valid,...change}),{preconnect:()=>undefined})});
    await expect(api.startJob(r)).rejects.toMatchObject({code:"operation_unknown"});
  }
  expect(jobView({...valid,state:"unknown",observation:"retained-record"},I)).toBe(true);
});
test("output uses contiguous canonical bytes and unknown cannot mean a completed stream",()=>{
  const page={jobRef:ref,offset:0,nextOffset:1,state:"succeeded",complete:true,truncated:false,events:[{offset:0,nextOffset:1,stream:"stdout",observedAt:1,bytes:1,contentBase64:"/w=="}]};
  expect(jobLogs(page,I,ref,0,65536)).toBe(true);
  for(const change of [{state:"unknown"},{nextOffset:2},{events:[{...page.events[0],contentBase64:"/x=="}]},{events:[{...page.events[0],offset:1}]},{events:[{...page.events[0],contentBase64:"/w==",bytes:2}]}])expect(jobLogs({...page,...change},I,ref,0,65536)).toBe(false);
});
test("a different cancellation identity cannot masquerade as the current request's success",()=>{
  const requestId=randomUUID(),job={...row(input()),cancelOperationId:requestId};
  const r={version:1,requestId,jobRef:ref,state:"requested",cancelOperationId:requestId,job,effectsReverted:false};
  expect(jobCancellation(r,I,ref,requestId)).toBe(true);
  const other=randomUUID();expect(jobCancellation({...r,cancelOperationId:other,job:{...job,cancelOperationId:other}},I,ref,requestId)).toBe(false);
  expect(jobCancellation({...r,state:"settled"},I,ref,requestId)).toBe(false);
});
