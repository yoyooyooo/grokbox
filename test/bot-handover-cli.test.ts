import {expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";import {join} from "node:path";import {tmpdir} from "node:os";import {randomUUID} from "node:crypto";
import {openBotLifecycle,openContinuityControls,createNativeBotHandover,createManagementGateway,publishConfigFile,type BotLifecyclePort} from "../packages/box-runtime/src/runtime.ts";
import {botWorkflowRequest,handoverItemId} from "../packages/runtime-kernel/src/continuity.ts";
import {ownedOwnershipSnapshot} from "../packages/box-runtime/test/ownership-fixture.ts";
const old="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",peer="cccccccc-cccc-4ccc-8ccc-cccccccccccc",group="dddddddd-dddd-4ddd-8ddd-dddddddddddd",scopeId="e".repeat(64);
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"handover-cli-")),operationId=randomUUID();
 const request=botWorkflowRequest({version:1,operationId,scopeId,kind:"replace",sourceId:old,profile:{name:"new"},modelRef:null,instructions:"",snapshotId:null,activate:true,start:false,maxRunMs:1000,policyRevision:"f".repeat(64),handover:{allowUserMessages:true}});
 const native:BotLifecyclePort={authorize:async()=>({allowed:true,scopeId,policyRevision:request.policyRevision,observedAtMs:Date.now()}),capture:async(_r,snapshotId)=>({snapshotId,revision:"1".repeat(64),quality:"native_checkpoint",gaps:[]}),
 create:async()=>({agentId:target,created:true,started:false}),load:async()=>({agentId:target,loaded:true}),model:async()=>({modelId:"official"}),compose:async(_r,_t,_s,snapshotId)=>({snapshotId,revision:"2".repeat(64),quality:"native_checkpoint",gaps:[]}),
 initialize:async(_r,_t,_s,id)=>({operationId:id,state:"prepared"}),activate:async()=>({state:"released",started:false}),startup:async()=>({state:"settled",started:true}),handover:async()=>({state:"active_with_handover"})};
 await openBotLifecycle({durableRoot:root,scopeId,native}).advance(request);
 const rows:any[]=[{id:old,name:"Old",description:"original persona",title:"Old role",isGroup:false},{id:target,name:"New",description:"new persona",title:"New role",isGroup:false},{id:peer,name:"Peer",description:"",title:"",isGroup:false},{id:group,name:"Group",isGroup:true,memberIds:[old,peer]}];
 const transcripts=new Map<string,any[]>([[old,[{id:"old-inbound",kind:"message",role:"user",content:"Existing task",timestampMs:1,fromAgent:{id:peer}}]],[target,[]],[group,[]],[peer,[]]]);
 const routines=new Map<string,any[]>([[old,[{id:"cron-old",name:"Daily",prompt:"routine-work",trigger:{type:"cron",schedule:"0 8 * * *"},isEnabled:true,createdAt:1}]],[target,[]]]);
 const calls:Array<{path:string;body:any}>=[];let sections:any[]=[],next=0,loseNotice=true;
 const state={targetReady:true,sourceOwned:true,beforeRead:undefined as undefined|((path:string)=>void)};
 const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:async req=>{
  const path=new URL(req.url).pathname;if(path==="/health")return Response.json({ok:true});
  if(req.headers.get("Authorization")!=="Bearer owned-token")return Response.json({}, {status:401});
  const b=await req.json() as any;calls.push({path,body:b});
  state.beforeRead?.(path);
  if(path==="/api/getHostStatus"){
   const proof=ownedOwnershipSnapshot([old,target,peer,group],{scopeId,nowMs:Date.now(),serverHarness:"box",localHarness:"box"});
   if(!state.targetReady){const row=proof.agents.find(r=>r.agentId===target)!;row.server.harness="temporal";row.local.before.harness="temporal";row.local.after.harness="temporal";}
   proof.agents.find(r=>r.agentId===old)!.server.viewerIsOwner=state.sourceOwned;
   return Response.json({grokboxOwnership:proof});
  }
  if(path==="/api/listAgents")return Response.json(rows);
  if(path==="/api/getAgentTranscriptTail")return Response.json({entries:transcripts.get(b.id)??[],hasMore:false});
  if(path==="/api/getAgentAutomations")return Response.json(routines.get(b.id)??[]);
  if(path==="/api/createAgentAutomation"){
   const list=routines.get(b.id)!;list.push({id:`new-${++next}`,name:b.spec.name,prompt:b.spec.prompt,trigger:b.spec.trigger,isEnabled:b.spec.isEnabled,createdAt:2});return Response.json(list);
  }
  if(path==="/api/setAgentAutomationEnabled"){
   const list=routines.get(b.id)!;const row=list.find(r=>r.id===b.automationId);if(row)row.isEnabled=b.isEnabled;return Response.json(list);
  }
  if(path==="/api/updateAgent"){Object.assign(rows.find(r=>r.id===b.id),b.profile);return Response.json(rows.find(r=>r.id===b.id));}
  if(path==="/api/getHostSettings")return Response.json({sidebarSections:sections});
  if(path==="/api/setHostSettings"){sections=b.sidebarSections;return Response.json({sidebarSections:sections});}
  if(path==="/api/assignAgentToSidebarSection"){sections.find(s=>s.id===b.sectionId)?.agentIds.push(b.agentId);return Response.json(null);}
  if(path==="/api/sendPrompt"){
   transcripts.get(b.agentId)!.push({id:`note-${b.clientNonce}`,kind:"message",role:"user",content:b.prompt,timestampMs:Date.now()});
   if(b.agentId===peer&&loseNotice){loseNotice=false;return Response.json({error:"unknown"},{status:500});}
   return Response.json({accepted:true});
  }
  if(path==="/api/setGroupMembers"){rows.find(r=>r.id===b.id).memberIds=b.memberAgentIds;return Response.json(rows.find(r=>r.id===b.id));}
  return Response.json({error:"unexpected"},{status:404});
 }});
 const discoveryPath=join(root,"gateway.json");await publishConfigFile(discoveryPath,{scheme:"http",host:"127.0.0.1",port:server.port!,pid:12345,startedAt:123456,token:"owned-token"});
 const deps={configDir:join(root,"config"),boxRuntimeRoot:root,env:{},discoveryPath,transport:"local" as const,skillsDir:join(import.meta.dir,"../skills")};
 const management=createManagementGateway({discoveryPath,configurationRoot:root,timeoutMs:2000}),signal=new AbortController().signal;
 const context={boxRuntimeRoot:root,env:{},signal,gateway:()=>management.continuityAccess(signal),ownershipRead:management.ownershipRead};
 return {root,operationId,request,state,rows,routines,transcripts,calls,sections:()=>sections,deps,
  adapter:(authorized?:()=>Promise<boolean>)=>createNativeBotHandover(context,scopeId,2000,authorized),
  close:async()=>{server.stop(true);await rm(root,{recursive:true,force:true});}};
}
for(const change of ["target-lost", "permission-revoked", "permission-after-ownership"] as const) test(`native handover ${change} during its last profile read refuses the actual write`,async()=>{
 const f=await fixture();let allowed=true;
 try {
  const adapter=f.adapter(async()=>allowed);expect(await adapter.port.authorize(f.request)).toBe(true);
  f.state.beforeRead=path=>{if(change==="permission-after-ownership"){if(path==="/api/getHostStatus")allowed=false;}else if(path==="/api/listAgents"){if(change==="target-lost")f.state.targetReady=false;else allowed=false;}};
  const item={itemId:handoverItemId(f.operationId,"old-guidance",old),kind:"old-guidance" as const,dependsOn:[],input:{agentId:old,targetId:target}};
  await expect(adapter.port.perform(f.request,item,new Map())).rejects.toThrow("policy_changed");
  expect(f.calls.some(c=>c.path==="/api/updateAgent")).toBe(false);expect(f.rows.find(r=>r.id===old).description).toBe("original persona");
 }finally{await f.close();}
});
test("mechanical handover requires current successor ownership and the original source account, not only a stable scope",async()=>{
 const f=await fixture();try{
  f.state.targetReady=false;await expect(f.adapter().program.advance(f.operationId)).rejects.toThrow("policy_changed");
  f.state.targetReady=true;f.state.sourceOwned=false;await expect(f.adapter().program.advance(f.operationId)).rejects.toThrow("policy_changed");
  expect(f.calls.every(c=>c.path==="/api/getHostStatus")).toBe(true);
  expect(await openContinuityControls({durableRoot:f.root,scopeId}).items(f.operationId)).toEqual([]);
 }finally{await f.close();}
});
test("mechanical handover uses formal user notices, preserves group peers, creates disabled cron then stops old before enabling new",async()=>{
 const f=await fixture();try{
  for(let i=0;i<8;i++){
   const result=await f.adapter().program.advance(f.operationId,16);
   expect(result.sourceDeleted).toBe(false);
  }
  expect(f.rows.find(r=>r.id===group).memberIds).toEqual([target,peer]);
  expect(f.rows.find(r=>r.id===old).description).toContain(`successor=${target}`);expect(f.rows.find(r=>r.id===old).title).toContain("handoff=redirecting");
  expect(f.sections()[0]?.agentIds).toContain(old);
  expect(f.routines.get(old)?.[0].isEnabled).toBe(false);expect(f.routines.get(target)).toHaveLength(1);expect(f.routines.get(target)?.[0]).toMatchObject({isEnabled:true,trigger:{type:"cron",schedule:"0 8 * * *"}});
  const create=f.calls.findIndex(r=>r.path==="/api/createAgentAutomation"),stop=f.calls.findIndex(r=>r.path==="/api/setAgentAutomationEnabled"&&r.body.id===old),enable=f.calls.findIndex(r=>r.path==="/api/setAgentAutomationEnabled"&&r.body.id===target);
  expect(create).toBeGreaterThan(-1);expect(f.calls[create]?.body.spec.isEnabled).toBe(false);expect(stop).toBeGreaterThan(create);expect(enable).toBeGreaterThan(stop);
  expect(f.calls.filter(r=>r.path==="/api/sendPrompt"&&r.body.agentId===peer)).toHaveLength(1);
  expect(f.calls.some(r=>/deleteAgent|deliverAgentMessage|WebhookKey/.test(r.path))).toBe(false);
  const status=await openContinuityControls({durableRoot:f.root,scopeId}).items(f.operationId);
  expect(status.filter(i=>i.state!=="complete").map(i=>i.kind)).toEqual(["external-task"]);
 }finally{await f.close();}
},30000);
