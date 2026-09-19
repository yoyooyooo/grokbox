import {expect,test} from "bun:test";
import {mkdtemp,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";import {randomUUID} from "node:crypto";
import {openBotLifecycle,openBotHandover,openContinuityControls,type BotLifecyclePort,type BotHandoverPort} from "../src/runtime.ts";
import {botWorkflowRequest,continuityId,handoverItemId} from "@grokbox/runtime-kernel/continuity";
const source="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",scopeId="c".repeat(64);
async function fixture(kind:"clone"|"replace"|"spawn"="clone"){
 const root=await mkdtemp(join(tmpdir(),"bot-lifecycle-test-")),calls:string[]=[],request=botWorkflowRequest({version:1,operationId:randomUUID(),scopeId,kind,sourceId:kind==="spawn"?null:source,profile:{name:"new bot"},modelRef:null,instructions:"explicit duty",snapshotId:null,activate:kind!=="clone",start:kind==="spawn",maxRunMs:1000,policyRevision:"d".repeat(64)});
 let allowed=true,crashCreate=false,crashStage:string|null=null;
 const once=async(name:string)=>{calls.push(name);if(crashStage===name)throw Error("owned-failure");};
 const native:BotLifecyclePort={authorize:async()=>({allowed,scopeId,policyRevision:request.policyRevision,observedAtMs:Date.now()}),
  capture:async(_r,id)=>{await once("capture");return {snapshotId:id,revision:"1".repeat(64),quality:"native_checkpoint",gaps:[]};},
  create:async()=>{await once("create");if(crashCreate)throw Error("native-created-response-lost");return {agentId:target,created:true,started:false};},
  load:async(_r,id)=>{await once("load");return {agentId:id,loaded:true};},model:async()=>{await once("model");return {modelId:"official"};},
  compose:async(_r,_id,_src,snapshotId)=>{await once("compose");return {snapshotId,revision:"2".repeat(64),quality:"semantic_resume",gaps:["missing_history"]};},
  initialize:async(_r,_id,_snapshot,operationId)=>{await once("initialize");return {operationId,state:"prepared"};},
  activate:async()=>{await once("activate");return {state:"released",started:false};},
  startup:async()=>{await once("startup");return {state:"settled",started:true,businessComplete:false};},
  handover:async()=>{await once("handover");return {count:3,remaining:2,state:"active_with_handover"};}};
 const program=openBotLifecycle({durableRoot:root,scopeId,native});
 return {root,calls,request,native,program,stop:()=>{allowed=false;},crashCreate:()=>{crashCreate=true;},fail:(name:string|null)=>{crashStage=name;},close:()=>rm(root,{recursive:true,force:true})};
}
test("clone uses one real durable lifecycle and remains prepared; re-entry performs no side effect",async()=>{
 const f=await fixture();try{
  const result=await f.program.advance(f.request);expect(result).toMatchObject({phase:"ready",targetId:target,blocked:false});
  expect(f.calls).toEqual(["capture","create","load","model","compose","initialize"]);
  const fresh=openBotLifecycle({durableRoot:f.root,scopeId,native:f.native});expect((await fresh.advance(f.request)).phase).toBe("ready");expect(f.calls).toHaveLength(6);
  expect(await fresh.request(f.request.operationId)).toEqual(f.request);expect(JSON.stringify(await fresh.status(f.request.operationId))).not.toContain("explicit duty");
 }finally{await f.close();}
});
test("spawn installs state before startup and cannot be mistaken for a user message or completed business",async()=>{
 const f=await fixture("spawn");try{
  const result=await f.program.advance(f.request);expect(result).toMatchObject({phase:"active",blocked:false});
  expect(f.calls).toEqual(["create","load","model","compose","initialize","activate","startup"]);
  expect(result.steps.find(s=>s.step==="startup")?.result).toMatchObject({state:"settled",started:true});
 }finally{await f.close();}
});
test("replace can be active while relationships remain incomplete",async()=>{
 const f=await fixture("replace");try{
  const result=await f.program.advance(f.request);expect(result).toMatchObject({phase:"active_with_handover",blocked:false});
  expect(result.steps.find(s=>s.step==="handover")?.result).toMatchObject({remaining:2});
 }finally{await f.close();}
});
test("unknown create is never reissued and a second replacement cannot bypass the source lock",async()=>{
 const f=await fixture("replace");try{
  f.crashCreate();expect((await f.program.advance(f.request)).blocked).toBe(true);
  const fresh=openBotLifecycle({durableRoot:f.root,scopeId,native:f.native});expect((await fresh.advance(f.request)).blocked).toBe(true);
  expect(f.calls.filter(s=>s==="create")).toHaveLength(1);
  await expect(fresh.advance({...f.request,operationId:randomUUID()})).rejects.toThrow("conflict");
 }finally{await f.close();}
});
test("later failure retains target identity and resumes the same safe phase without copying again",async()=>{
 const f=await fixture();try{
  f.fail("model");expect(await f.program.advance(f.request)).toMatchObject({blocked:true,targetId:target});f.fail(null);
  expect((await f.program.advance(f.request)).phase).toBe("ready");expect(f.calls.filter(s=>s==="create")).toHaveLength(1);
  f.stop();await expect(f.program.advance({...f.request,instructions:"changed"})).rejects.toThrow("conflict");
 }finally{await f.close();}
});
test("authority revocation stops before identity or native state changes",async()=>{
 const f=await fixture();try{f.stop();expect((await f.program.advance(f.request)).blocked).toBe(true);expect(f.calls).toEqual([]);}finally{await f.close();}
});
test("handover checks independent dependencies, never redispatches unknown messages, and accepts later readback",async()=>{
 const f=await fixture("replace");try{
  await f.program.advance(f.request);const control=openContinuityControls({durableRoot:f.root,scopeId});
  const a=handoverItemId(f.request.operationId,"dm-notice",target),b=handoverItemId(f.request.operationId,"title-new",target),c=handoverItemId(f.request.operationId,"group-members",source);
  const effects:string[]=[],visible=new Set<string>();
  const port:BotHandoverPort={authorize:async()=>true,discover:async(_r,_t,known)=>({coverage:"partial",items:[
    {itemId:a,kind:"dm-notice",dependsOn:[],input:{targetId:target}},
    {itemId:b,kind:"title-new",dependsOn:[],input:{targetId:target}},
    {itemId:c,kind:"group-members",dependsOn:[a],input:{targetId:target}},
  ].filter(i=>!known.includes(i.itemId)) as any}),
  inspect:async(_r,item)=>visible.has(item.itemId)?{state:"complete",evidence:"1".repeat(64)}:{state:"not_dispatched"},
  perform:async(_r,item)=>{effects.push(item.itemId);if(item.itemId===a)return {state:"unknown"};visible.add(item.itemId);return {state:"complete",evidence:"2".repeat(64)};}};
  const h=openBotHandover({durableRoot:f.root,scopeId,native:port});const first=await h.advance(f.request.operationId);
  expect(first.unknown).toBe(1);expect(effects).toContain(b);expect(effects).not.toContain(c);
  await h.advance(f.request.operationId);expect(effects.filter(id=>id===a)).toHaveLength(1);
  visible.add(a);await h.advance(f.request.operationId);await h.advance(f.request.operationId);expect(effects).toContain(c);
  expect((await control.items(f.request.operationId)).every(i=>i.state==="complete")).toBe(true);
 }finally{await f.close();}
});
