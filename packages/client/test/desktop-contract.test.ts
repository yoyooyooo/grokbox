import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeDesktopPrune, normalizeDesktopPolicy, validDesktopOperation, type DesktopOperation } from "../src/client.ts";
const I="11111111-1111-4111-8111-111111111111",A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const request=()=>({requestId:randomUUID(),expectedRevision:"a".repeat(64),confirmed:true as const});
function receipt(r:ReturnType<typeof request>):DesktopOperation{return {version:1,installationId:I,requestId:r.requestId,operationRef:`desktop-operation:${I}:${"b".repeat(64)}`,origin:"manual",expectedRevision:r.expectedRevision,state:"succeeded",acceptedAtMs:1,settledAtMs:2,rows:[{display:2,agentId:A,identity:"c".repeat(64),state:"stopped",observation:"display-dark"}],atomicSeatLease:false,botDeleted:false};}
function client(value:unknown,refusal=false){let calls=0;const api=new ManagementClient({baseUrl:"http://127.0.0.1",installationId:I,fetch:Object.assign(async()=>{calls++;return Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:!refusal,...(refusal?{error:{code:"desktop_prune_refused",message:"not reclaimed",details:{operation:value}}}:{data:value})},{status:refusal?409:200});},{preconnect:()=>undefined})as typeof fetch});return {api,count:()=>calls};}
test("desktop inputs reject executable discriminators, sparse protection sets and old implicit switches",()=>{
  let executed=0;for(const value of [{...request(),get expectedRevision(){executed++;return "a".repeat(64);}},{...request(),legacyEnabled:true}])expect(()=>normalizeDesktopPrune(value)).toThrow();
  expect(()=>normalizeDesktopPolicy({...request(),get action(){executed++;return "keep";},agentIds:[]})).toThrow();
  expect(()=>normalizeDesktopPolicy({...request(),action:"keep",agentIds:[,A]})).toThrow();expect(()=>normalizeDesktopPolicy({...request(),action:"keep",agentIds:[A,A.toUpperCase()]})).toThrow();
  expect(()=>normalizeDesktopPolicy({...request(),action:"idle-reclaim",enabled:true,minIdleMs:1000})).toThrow();expect(executed).toBe(0);
});
test("desktop receipts cannot change request, installation, approval, effects or unsettled row meaning",async()=>{
  const r=request(),good=receipt(r);expect((await client(good).api.pruneDesktop(r)).data).toEqual(good);
  for(const bad of [{...good,requestId:randomUUID()},{...good,installationId:randomUUID()},{...good,expectedRevision:"d".repeat(64)},{...good,origin:"automatic"},{...good,atomicSeatLease:true},{...good,rows:[{...good.rows[0],state:"dispatching",observation:"not-observed"}]}])await expect(client(bad).api.pruneDesktop(r)).rejects.toMatchObject({code:"operation_unknown"});
  let coerced=0;expect(validDesktopOperation({...good,expectedRevision:{toString:()=>{coerced++;return "a".repeat(64);}}},I)).toBe(false);expect(coerced).toBe(0);
});
test("a refused desktop operation must match the original review before it can unlock a browser draft",async()=>{
  const r=request(),good:DesktopOperation={...receipt(r),state:"refused",rows:[{display:2,agentId:A,identity:"c".repeat(64),state:"refused",observation:"not-observed"}]};
  await expect(client(good,true).api.pruneDesktop(r)).rejects.toMatchObject({code:"desktop_prune_refused"});
  await expect(client({...good,requestId:randomUUID()},true).api.pruneDesktop(r)).rejects.toMatchObject({code:"operation_unknown"});
});
test("a request and protection set are captured before async credential resolution; transport loss is not retried",async()=>{
  let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let calls=0,body="";
  const r={...request(),action:"keep" as const,agentIds:[A]};
  const api=new ManagementClient({baseUrl:"http://127.0.0.1",installationId:I,credential:async()=>{entered();await gate;return "synthetic";},fetch:Object.assign(async(_u:unknown,init?:RequestInit)=>{calls++;body=String(init?.body);throw Error("lost");},{preconnect:()=>undefined})as typeof fetch});
  const submitted=api.changeDesktopPolicy(r);await ready;r.agentIds.length=0;release();await expect(submitted).rejects.toMatchObject({code:"operation_unknown",details:{requestId:r.requestId,lookupPath:`/v1/desktop-policy-operations/${r.requestId}`}});expect(JSON.parse(body).agentIds).toEqual([A]);expect(calls).toBe(1);
});
