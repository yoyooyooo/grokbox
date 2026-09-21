import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagementClient, normalizeHandoverChange, normalizeHandoverContinuation, handoverOperation, handoverOperationRef,
  handoverEvidenceRef, type HandoverChange, type HandoverOperation } from "../src/client.ts";
const I="11111111-1111-4111-8111-111111111111",S="a".repeat(64),R="b".repeat(64),W="cccccccc-cccc-4ccc-8ccc-cccccccccccc",T=`handover:${I}:${S}:${W}`;
const input=():HandoverChange=>({requestId:randomUUID(),handoverRef:T,action:"advance",expectedRevision:R,confirmed:true});
const receipt=(r:HandoverChange):HandoverOperation=>({requestId:r.requestId,operationRef:handoverOperationRef(I,S,r.requestId),handoverRef:r.handoverRef,action:r.action,
  expectedRevision:r.expectedRevision,state:"completed",result:{outcome:"advanced",reason:null,revision:R,remaining:1,unknown:0,complete:4,assessment:null,observations:[],observationsTruncated:false,sourceDeleted:false,allDutiesComplete:false},createdAtMs:Date.now(),privateInputsIncluded:false});
const reply=(data:unknown)=>Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:true,data});
test("handover declarations have explicit action authority and reject arbitrary attestation hashes before IO",()=>{
 const r=input();expect(normalizeHandoverChange(r,I)).toEqual(r);
 for(const patch of [{confirmed:false},{action:"delete"},{expectedRevision:"old"},{itemId:randomUUID()},{evidenceRef:R},{instructions:"private"},{action:"retire"},{action:"attest",itemId:randomUUID(),evidenceRef:R}])expect(()=>normalizeHandoverChange({...r,...patch},I)).toThrow();
 let calls=0;expect(()=>normalizeHandoverChange({...r,get handoverRef(){calls++;return T;}},I)).toThrow();
 expect(()=>normalizeHandoverChange({...r,action:{toString(){calls++;return "advance";}}},I)).toThrow();
 expect(()=>normalizeHandoverContinuation({requestId:r.requestId,scopeId:S,action:"resume",confirmed:true,handoverRef:T})).toThrow();expect(calls).toBe(0);
});
test("bounded handover receipts cannot fabricate complete duty coverage, native deletion or another observation's evidence",()=>{
 const r=input(),v=receipt(r);expect(handoverOperation(v,I,S,r.requestId)).toBe(true);
 for(const patch of [{sourceDeleted:true},{allDutiesComplete:true},{remaining:0,unknown:1},{outcome:"retired"},{observationsTruncated:true}])expect(handoverOperation({...v,result:{...v.result,...patch}},I,S,r.requestId)).toBe(false);
 const item=randomUUID(),observed={...v,action:"observe",result:{...v.result!,outcome:"observed",observations:[{itemId:item,inputDigest:R,state:"complete",evidenceHash:R,evidenceRef:handoverEvidenceRef(I,S,r.requestId,item,R)}]}};
 expect(handoverOperation(observed,I,S,r.requestId)).toBe(true);
 expect(handoverOperation({...observed,result:{...observed.result,observations:[{...observed.result.observations[0],evidenceRef:handoverEvidenceRef(I,S,randomUUID(),item,R)}]}},I,S,r.requestId)).toBe(false);
 for(const state of ["admitted","unknown","cancelled"]){expect(handoverOperation({...v,state,result:null},I,S,r.requestId)).toBe(true);expect(handoverOperation({...v,state},I,S,r.requestId)).toBe(false);}
});
test("lost and mismatched handover responses retain the original operation locator and never retry",async()=>{
 for(const fault of ["transport","target","action","revision"]){const r=input();let calls=0;
  const client=new ManagementClient({baseUrl:"https://management.example.test",installationId:I,credential:async()=>"synthetic",
   fetch:(async()=>{calls++;if(fault==="transport")throw Error("lost");const v=receipt(r);return reply({...v,...fault==="target"?{handoverRef:`handover:${I}:${S}:${randomUUID()}`}:fault==="action"?{action:"observe",result:{...v.result,outcome:"observed"}}:{expectedRevision:"f".repeat(64)}});}) as unknown as typeof fetch});
  await expect(client.changeHandover(r)).rejects.toMatchObject({code:"operation_unknown",details:{requestId:r.requestId,lookupPath:`/v1/handover-operations/${S}/${r.requestId}`}});expect(calls).toBe(1);
 }
});
test("credential awaits cannot mutate the approved handover or request identity",async()=>{
 const r=input(),original=structuredClone(r);let release!:()=>void,seen:unknown;const wait=new Promise<void>(r=>release=r);
 const client=new ManagementClient({baseUrl:"https://management.example.test",installationId:I,credential:async()=>{await wait;return "synthetic";},fetch:(async(_url,init)=>{seen=JSON.parse(String(init?.body));return reply(receipt(seen as HandoverChange));}) as typeof fetch});
 const pending=client.changeHandover(r);r.requestId=randomUUID();r.action="retire";r.expectedRevision="f".repeat(64);release();await pending;expect(seen).toEqual(original);
});
