import { expect, test } from "bun:test";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { botWorkflowRequest, botWorkflowDigest } from "@grokbox/runtime-kernel/continuity";
import { continuityWorkflowPrograms } from "../src/internal/io/continuity-workflows.node.ts";
import { readProtectionHandover } from "../src/internal/io/protection-views.node.ts";
import { handoverManagementPrograms, type ManagedHandoverDeclaration } from "../src/internal/io/handover-management.node.ts";
import type { ContinuityStoreHooks } from "../src/internal/io/continuity-database.node.ts";
const I="11111111-1111-4111-8111-111111111111",S="a".repeat(64),A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",R="c".repeat(64);
const run=<A>(value:Effect.Effect<A,unknown>)=>Effect.runPromise(value);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"handover-owner-")),db=continuityWorkflowPrograms({durableRoot:root,scopeId:S}),hooks:ContinuityStoreHooks={},owner=handoverManagementPrograms(root,S,hooks);
 const request=botWorkflowRequest({version:1,operationId:randomUUID(),scopeId:S,kind:"replace",sourceId:A,profile:{name:"target"},modelRef:null,instructions:"",snapshotId:null,activate:true,start:false,maxRunMs:1000,policyRevision:R});
 await run(db.initialize());await run(db.create(request));await run(db.beginStep(request.operationId,"create"));await run(db.completeStep(request.operationId,"create",{agentId:B,created:true,started:false}));
 const view=()=>readProtectionHandover(root,S,request.operationId);
 const declaration=async():Promise<ManagedHandoverDeclaration>=>({installationId:I,principalId:"owner",requestId:randomUUID(),scopeId:S,workflowId:request.operationId,workflowDigest:botWorkflowDigest(request),sourceId:A,targetId:B,expectedRevision:(await view()).revision,action:"advance",itemId:null,evidenceRef:null});
 return {root,db,owner,hooks,request,view,declaration,close:()=>rm(root,{recursive:true,force:true})};
}
test("the original CONT handover owner permits one dispatch claim and protects another pending request",async()=>{
 const f=await fixture();try{
  const q=await f.declaration(),r=await run(f.owner.reserve(q));const claims=await Promise.all([run(f.owner.claim(r.operationId)),run(f.owner.claim(r.operationId))]);
  expect(claims.filter(c=>c.dispatch)).toHaveLength(1);await expect(run(f.owner.reserve({...q,requestId:randomUUID()}))).rejects.toThrow("conflict");
  await expect(run(f.owner.cancel(r.operationId))).rejects.toThrow("conflict");expect((await run(f.owner.read(r.operationId)))?.state).toBe("effect_unknown");
  expect((await run(f.owner.reserve(q))).operationId).toBe(r.operationId);await expect(run(f.owner.reserve({...q,targetId:randomUUID()}))).rejects.toThrow("conflict");
 }finally{await f.close();}
});
for(const label of ["managed-handover-prepare","managed-handover-claim","managed-handover-settle"] as const)test(`lost ${label} acknowledgment preserves exact original history`,async()=>{
 const f=await fixture();try{
  const q=await f.declaration();let once=true;f.hooks.afterCommit=async stage=>{if(stage===label&&once){once=false;throw Error("ack-lost");}};
  let id:string;
  if(label.endsWith("prepare")){await expect(run(f.owner.reserve(q))).rejects.toThrow("commit_unknown");f.hooks.afterCommit=undefined;id=(await run(f.owner.reserve(q))).operationId;expect((await run(f.owner.read(id)))?.state).toBe("prepared");}
  else {id=(await run(f.owner.reserve(q))).operationId;if(label.endsWith("claim")){await expect(run(f.owner.claim(id))).rejects.toThrow("commit_unknown");expect((await run(f.owner.claim(id))).dispatch).toBe(false);}
   else{await run(f.owner.claim(id));const value={outcome:"advanced",revision:q.expectedRevision};await expect(run(f.owner.settle(id,value))).rejects.toThrow("commit_unknown");expect((await run(f.owner.read(id)))?.result).toEqual(value);}}
  expect(once).toBe(false);
 }finally{await f.close();}
});
test("attestation verifies dependent duty state in the same transaction as its management receipt",async()=>{
 const f=await fixture();try{
  const parent=randomUUID(),item=randomUUID(),id=f.request.operationId;
  await run(f.db.putHandover(id,parent,"group-notice",{targetId:B,dependsOn:[]}));await run(f.db.settleHandover(id,parent,"prepared","complete",{state:"complete",evidence:R}));
  await run(f.db.putHandover(id,item,"group-members",{targetId:B,dependsOn:[parent]}));
  const q={...await f.declaration(),action:"attest" as const,itemId:item,evidenceRef:"bounded-fixture-observation"},r=await run(f.owner.reserve(q));await run(f.owner.claim(r.operationId));
  const selected=(await f.view()).items.find(i=>i.itemId===item)!;await run(f.db.settleHandover(id,parent,"complete","blocked",{state:"unsupported"}));
  const value={outcome:"attested",revision:q.expectedRevision};await expect(run(f.owner.settle(r.operationId,value,{itemId:item,inputDigest:selected.inputDigest,evidenceHash:R,nativeResult:{state:"complete",evidence:R}}))).rejects.toThrow("conflict");
  expect((await f.view()).items.find(i=>i.itemId===item)?.state).toBe("prepared");expect((await run(f.owner.read(r.operationId)))?.result).toBeNull();
 }finally{await f.close();}
});
test("handover record capacity refuses new requests without evicting an unknown or breaking exact replay",async()=>{
 const f=await fixture();try{
  let first:string|undefined;
  for(let i=0;i<511;i++){const r=await run(f.owner.reserve(await f.declaration()));first??=r.operationId;await run(f.owner.cancel(r.operationId));}
  const q=await f.declaration(),last=await run(f.owner.reserve(q));await run(f.owner.claim(last.operationId));
  expect((await run(f.owner.read(first!)))?.cancelled).toBe(true);expect((await run(f.owner.reserve(q))).state).toBe("effect_unknown");
  await run(f.owner.settle(last.operationId,{outcome:"advanced",revision:q.expectedRevision}));
  await expect(run(f.owner.reserve(await f.declaration()))).rejects.toThrow("capacity");expect((await run(f.owner.read(last.operationId)))?.state).toBe("complete");
 }finally{await f.close();}
},30000);
