import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES, protectionReference } from "@grokbox/client";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import { openBotLifecycle, openContinuityControls, createManagementGateway, openRuntimeStore, publishConfigFile, publishLayoutAliases,
  type BotLifecyclePort } from "@grokbox/box-runtime/runtime";
import { botWorkflowRequest, continuityId } from "@grokbox/runtime-kernel/continuity";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";
import type { ContinuityStoreHooks } from "../../../packages/box-runtime/src/internal/io/continuity-database.node.ts";
export const H_INSTALL="11111111-1111-4111-8111-111111111111",H_SOURCE="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",H_TARGET="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  H_PEER="cccccccc-cccc-4ccc-8ccc-cccccccccccc",H_GROUP="dddddddd-dddd-4ddd-8ddd-dddddddddddd",H_SCOPE="e".repeat(64),H_OWNER="synthetic-handover-owner",H_READER="synthetic-handover-reader",H_OTHER="synthetic-handover-other";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
export function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
/** Original CONT workflow/provision owners and real management/Gateway HTTP.
 * Account, native collections and earlier activation effects are controlled.
 * No private Host, Bot, model, scheduler or external recipient is contacted. */
export async function handoverFixture(origin:string,options:{allowMessages?:boolean;principalId?:string}={}){
  const principalId=options.principalId??"owner";
  const root=await mkdtemp(join(tmpdir(),"handover-management-")),requestId=randomUUID(),operationId=continuityId(H_INSTALL,canonicalJson(["manual-lifecycle-v1",principalId,requestId]));
  const request=botWorkflowRequest({version:1,operationId,scopeId:H_SCOPE,kind:"replace",sourceId:H_SOURCE,profile:{name:"New"},modelRef:null,instructions:"PRIVATE_LIFECYCLE_INSTRUCTIONS",snapshotId:null,
    activate:true,start:false,maxRunMs:1000,policyRevision:"f".repeat(64),handover:{allowUserMessages:options.allowMessages??true},
    management:{installationId:H_INSTALL,principalId,requestId,intentDigest:"c".repeat(64)}});
  const native:BotLifecyclePort={authorize:async()=>({allowed:true,scopeId:H_SCOPE,policyRevision:request.policyRevision,observedAtMs:Date.now()}),
    capture:async(_r,snapshotId)=>({snapshotId,revision:"1".repeat(64),quality:"native_checkpoint",gaps:[]}),create:async()=>({agentId:H_TARGET,created:true,started:false}),
    load:async()=>({agentId:H_TARGET,loaded:true}),model:async()=>({modelId:"official"}),compose:async(_r,_t,_s,snapshotId)=>({snapshotId,revision:"2".repeat(64),quality:"native_checkpoint",gaps:[]}),
    initialize:async(_r,_t,_s,id)=>({operationId:id,state:"prepared"}),activate:async()=>({state:"released",started:false}),startup:async()=>({state:"settled",started:true}),handover:async()=>({state:"active_with_handover"})};
  await openBotLifecycle({durableRoot:root,scopeId:H_SCOPE,native}).advance(request);
  const rows:any[]=[{id:H_SOURCE,name:"Old",description:"PRIVATE_SOURCE_PERSONA",title:"Old role",isGroup:false},{id:H_TARGET,name:"New",description:"PRIVATE_TARGET_PERSONA",title:"New role",isGroup:false},
    {id:H_PEER,name:"Peer",description:"",title:"",isGroup:false},{id:H_GROUP,name:"Group",isGroup:true,memberIds:[H_SOURCE,H_PEER]}];
  const transcripts=new Map<string,any[]>([[H_SOURCE,[{id:"source-inbound",kind:"message",role:"user",content:"PRIVATE_EXISTING_TASK",timestampMs:1,fromAgent:{id:H_PEER}}]],[H_TARGET,[]],[H_GROUP,[]],[H_PEER,[]]]);
  const routines=new Map<string,any[]>([[H_SOURCE,[{id:"cron-source",name:"Daily",prompt:"PRIVATE_ROUTINE",trigger:{type:"cron",schedule:"0 8 * * *"},isEnabled:true,createdAt:1}]],[H_TARGET,[]]]);
  const state={scopeId:H_SCOPE,targetReady:true,sourceOwned:true,unavailable:false,hasMore:false,loseNotice:false,stallAfterWrite:false,stallRead:"",waiting:0,aborted:0,release:deferred(),
    beforeRead:undefined as undefined|((path:string)=>void),calls:[] as Array<{path:string;body:any}>,sections:[] as any[],
    grants:[{principalId,tokenSha256:hash(H_OWNER),capabilities:[...CAPABILITIES]},
      {principalId:"other",tokenSha256:hash(H_OTHER),capabilities:[...CAPABILITIES]},
      {principalId:"reader",tokenSha256:hash(H_READER),capabilities:["protection.read","operations.read","console.grants.create"]}] as AccessGrant[]};
  let next=0;const tasks=new Set<Promise<void>>();
  const nativeServer=createServer((req,res)=>{
    const task=(async()=>{
      if(req.headers.authorization!=="Bearer synthetic-handover-native"){res.writeHead(401);res.end();return;}
      let text="";for await(const part of req)text+=part;const body=JSON.parse(text),path=req.url!;state.calls.push({path,body});state.beforeRead?.(path);
      if(state.unavailable){res.writeHead(503);res.end();return;}
      const send=(value:unknown)=>{if(!res.destroyed){res.setHeader("content-type","application/json");res.end(JSON.stringify(value));}};
      const stall=async()=>{state.waiting++;res.once("close",()=>state.aborted++);await state.release.promise;};
      if(state.stallRead===path)await stall();
      if(path==="/api/getHostStatus"){
        const proof=ownedOwnershipSnapshot([H_SOURCE,H_TARGET,H_PEER,H_GROUP],{scopeId:state.scopeId,nowMs:Date.now(),serverHarness:"box",localHarness:"box"});
        if(!state.targetReady){const row=proof.agents.find(r=>r.agentId===H_TARGET)!;row.server.harness="temporal";row.local.before.harness="temporal";row.local.after.harness="temporal";}
        proof.agents.find(r=>r.agentId===H_SOURCE)!.server.viewerIsOwner=state.sourceOwned;send({grokboxOwnership:proof});return;
      }
      if(path==="/api/listAgents"){send(rows);return;}
      if(path==="/api/getAgentTranscriptTail"){send({entries:transcripts.get(body.id)??[],hasMore:state.hasMore});return;}
      if(path==="/api/getAgentAutomations"){send(routines.get(body.id)??[]);return;}
      if(path==="/api/getHostSettings"){send({sidebarSections:state.sections});return;}
      let value:unknown;
      if(path==="/api/createAgentAutomation"){const list=routines.get(body.id)!;list.push({id:`created-${++next}`,...body.spec,createdAt:2});value=list;}
      else if(path==="/api/setAgentAutomationEnabled"){const list=routines.get(body.id)!;list.find(r=>r.id===body.automationId).isEnabled=body.isEnabled;value=list;}
      else if(path==="/api/updateAgent"){Object.assign(rows.find(r=>r.id===body.id),body.profile);value=rows.find(r=>r.id===body.id);}
      else if(path==="/api/setHostSettings"){state.sections=body.sidebarSections;value={sidebarSections:state.sections};}
      else if(path==="/api/assignAgentToSidebarSection"){state.sections.find(s=>s.id===body.sectionId)?.agentIds.push(body.agentId);value=null;}
      else if(path==="/api/sendPrompt"){
        transcripts.get(body.agentId)!.push({id:`notice-${body.clientNonce}`,kind:"message",role:"user",content:body.prompt,timestampMs:Date.now(),clientNonce:body.clientNonce});value={accepted:true};
        if(state.loseNotice){state.loseNotice=false;res.destroy();return;}
      }else if(path==="/api/setGroupMembers"){rows.find(r=>r.id===body.id).memberIds=body.memberAgentIds;value=rows.find(r=>r.id===body.id);}
      else{res.writeHead(404);res.end();return;}
      if(state.stallAfterWrite)await stall();send(value);
    })();tasks.add(task);void task.catch(()=>{if(!res.destroyed){res.writeHead(500);res.end();}}).finally(()=>tasks.delete(task));
  });
  nativeServer.listen(0,"127.0.0.1");await once(nativeServer,"listening");const address=nativeServer.address();if(!address||typeof address==="string")throw Error("fixture-address");
  const discoveryPath=join(root,"gateway.json");await publishConfigFile(discoveryPath,{scheme:"http",host:"127.0.0.1",port:address.port,pid:4242,startedAt:1000,token:"synthetic-handover-native"});
  await publishConfigFile(join(root,"config.json"),validateConfig({...defaultConfig(),runtime:{desiredMode:"disabled",continuity:{enabled:false}}}));
  const store=openRuntimeStore(root,{}),gateway=createManagementGateway({discoveryPath,configurationRoot:root,timeoutMs:2000}),hooks:ContinuityStoreHooks={};
  const serverOptions={store,installationId:H_INSTALL,native:gateway,env:{},allowedOrigins:[origin],readGrants:async()=>structuredClone(state.grants),port:0};
  let server=await startManagementServer(serverOptions,{hostHealth:{enabled:false},context:{hooks}});serverOptions.port=Number(new URL(server.url).port);
  await publishConfigFile(join(root,"config.json"),validateConfig({...defaultConfig(),runtime:{desiredMode:"disabled",continuity:{enabled:false}},
    client:{currentProfile:"default",profiles:{default:{serverUrl:server.url,installationId:H_INSTALL,daemonTokenRef:"env:HANDOVER_MANAGEMENT_TOKEN"}}}}));
  await publishConfigFile(join(root,"state","installation.json"),{schemaVersion:1,installationId:H_INSTALL,role:"box",root,daemon:{tokenSha256:hash(H_OWNER)}});
  await publishLayoutAliases(root,root,H_INSTALL);
  const ref=protectionReference("handover",H_INSTALL,H_SCOPE,operationId);
  return {root,store,hooks,state,rows,transcripts,routines,request,operationId,ref,serverOptions,controls:openContinuityControls({durableRoot:root,scopeId:H_SCOPE}),get server(){return server;},
    client:(credential=H_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:H_INSTALL,credential:async()=>credential,timeoutMs:30000,
      fetch:(async(url,init)=>{const headers=new Headers(init?.headers);headers.set("connection","close");return fetch(url,{...init,headers});}) as typeof fetch}),
    restart:async()=>{await server.close();server=await startManagementServer(serverOptions,{hostHealth:{enabled:false},context:{hooks}});},
    close:async()=>{state.release.resolve();await server.close();nativeServer.closeAllConnections();await Promise.allSettled([...tasks]);await new Promise<void>(r=>nativeServer.close(()=>r()));await rm(root,{recursive:true,force:true});}
  };
}
