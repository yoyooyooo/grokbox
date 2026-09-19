import {expect,test} from "bun:test";
import {mkdtemp,rm,stat} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";import {randomUUID} from "node:crypto";
import {openBotProtection,startPolicyBoundBotProtection,openContinuityControls,type BotProtectionPort,type BotLifecyclePort} from "../src/runtime.ts";
import {continuityProtection,botWorkflowRequest,protectionRevision} from "@grokbox/runtime-kernel/continuity";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",scopeId="c".repeat(64);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"bot-protection-test-"));let config=continuityProtection({enabled:true,bots:{[id]:{mode:"auto-replace"}}});
 let ownership:"box"|"temporal"|"gap"="box",age=0,created=0,paused=0,notified=0,captured=0;
 const lifecycle:BotLifecyclePort={authorize:async request=>({allowed:config.enabled,scopeId,policyRevision:request.policyRevision,observedAtMs:Date.now()}),
  capture:async(_r,snapshotId)=>({snapshotId,revision:"1".repeat(64),quality:"native_checkpoint",gaps:[]}),
  create:async()=>{created++;return {agentId:target,created:true,started:false};},load:async(_r,agentId)=>({agentId,loaded:true}),model:async()=>({modelId:"official"}),
  compose:async(_r,_t,_s,snapshotId)=>({snapshotId,revision:"2".repeat(64),quality:"native_checkpoint",gaps:[]}),initialize:async(_r,_t,_s,operationId)=>({operationId,state:"prepared"}),
  activate:async()=>({state:"released",started:false}),startup:async()=>({state:"settled",started:true}),handover:async()=>({state:"active_with_handover",remaining:1})};
 const native:BotProtectionPort={policy:async()=>config,lifecycle,
  observe:async ids=>new Map(ids.map(agentId=>[agentId,{state:ownership,scopeId,atMs:Date.now()-age}])),
  pause:async()=>{paused++;return {complete:true,remaining:0,failed:0};},notify:async()=>{notified++;return true;},
  capture:async(_l,_a,operationId)=>{captured++;return {snapshotId:operationId};},
  request:async(logical,agent,operationId,snapshotId,p)=>botWorkflowRequest({version:1,operationId,scopeId,kind:p.mode==="prepare"?"clone":"replace",sourceId:agent,
    profile:{name:"successor"},modelRef:null,instructions:"",snapshotId,activate:p.mode==="auto-replace",start:false,maxRunMs:1000,policyRevision:protectionRevision(logical,p)}),handover:async()=>({})};
 const program=openBotProtection({durableRoot:root,scopeId,native});
 return {root,program,native,controls:openContinuityControls({durableRoot:root,scopeId}),config:()=>config,
  update:(patch:any)=>{config=continuityProtection({...config,...patch});},state:(value:typeof ownership,ms=0)=>{ownership=value;age=ms;},
  counts:()=>({created,paused,notified,captured}),close:()=>rm(root,{recursive:true,force:true})};
}
test("disabled protection observes nothing and creates no store",async()=>{
 const f=await fixture();try{f.update({enabled:false});expect(await f.program.observe()).toMatchObject({state:"off"});expect(await f.program.advance()).toMatchObject({state:"off"});
 expect(f.counts()).toEqual({created:0,paused:0,notified:0,captured:0});expect(await stat(join(f.root,"continuity")).then(()=>true,()=>false)).toBe(false);
 }finally{await f.close();}
});
test("confirmed loss creates a persistent condition, pauses once, notifies, and promotes one prepared successor",async()=>{
 const f=await fixture();try{
 await f.program.observe();await f.program.advance();expect(f.counts().captured).toBe(1);
 f.state("temporal");await f.program.observe();await f.program.observe();expect(f.counts().paused).toBe(1);
 const before=await f.controls.subject(id);expect(before?.data.lossId).toBeString();
 const first=await f.program.advance();expect(first.state).toBe("active_with_handover");expect(f.counts().created).toBe(1);
 const current=await f.controls.subject(id);expect(current).toMatchObject({currentId:target,generation:1});expect(current?.data.previousIds).toEqual([id]);
 await f.program.advance();expect(f.counts().created).toBe(1);
 }finally{await f.close();}
});
test("first observed Temporal is protected; a stale or failed sample never starts replacement",async()=>{
 const f=await fixture();try{
 f.state("temporal",6000);await f.program.observe();await f.program.advance();expect(f.counts().created).toBe(0);expect(f.counts().paused).toBe(0);
 f.state("gap");await f.program.observe();await f.program.advance();expect(f.counts().created).toBe(0);
 f.state("temporal");await f.program.observe();expect(f.counts().paused).toBe(1);expect((await f.controls.subject(id))?.data.lossAtMs).toBeGreaterThan(0);
 }finally{await f.close();}
});
test("pause opt-out and prepare-only policy remain distinct from automatic activation",async()=>{
 const f=await fixture();try{
 f.update({bots:{[id]:{mode:"prepare",pauseOnOwnershipLoss:false}}});f.state("temporal");await f.program.observe();
 expect(f.counts().paused).toBe(0);expect((await f.program.advance()).state).toBe("ready");expect((await f.controls.subject(id))?.currentId).toBe(id);
 await f.program.advance();expect(f.counts().created).toBe(1);
 }finally{await f.close();}
});
test("normal daemon lifecycle does not instantiate native controller while config is off",async()=>{
 const f=await fixture();let reads=0,created=0;
 const worker=startPolicyBoundBotProtection({durableRoot:f.root,read:async()=>{reads++;return {enabled:false,scopeId:null};},create:()=>{created++;return f.native;}});
 try{for(let i=0;i<100&&reads===0;i++)await new Promise(r=>setTimeout(r,2));await worker.close();expect(reads).toBeGreaterThan(0);expect(created).toBe(0);expect(worker.status().closed).toBe(true);
 }finally{await worker.close();await f.close();}
});
