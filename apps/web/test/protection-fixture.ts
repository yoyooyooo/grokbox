import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { botWorkflowRequest, protectionRevision, botSupplement, materialFromBotSupplement, ContinuityFailure } from "@grokbox/runtime-kernel/continuity";
import { createManagementGateway, openRuntimeStore, openContinuityControls, openContinuityRecoveryStore, publishConfigFile, publishLayoutAliases,
  createNativeBotProtection, type BotLifecyclePort, type ProtectionServiceTestPorts } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";

export const P_INSTALL="11111111-1111-4111-8111-111111111111", P_BOT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", P_TARGET="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", P_TEMPORAL="cccccccc-cccc-4ccc-8ccc-cccccccccccc", P_SCOPE="d".repeat(64);
export const P_OWNER="synthetic-protection-owner",P_READER="synthetic-protection-reader";
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
/** Real management + Gateway HTTP, original SQLite/store/effect programs. All
 * native facts are private synthetic state. Optional restoration port simulates
 * native checkpoints, never a production fallback or model/real Bot call. */
export async function protectionFixture(origin:string,options:{disabled?:boolean;simulatedRestore?:boolean}={}) {
  const root=await mkdtemp(join(tmpdir(),"protection-management-")),store=openRuntimeStore(root,{}),discoveryPath=join(root,"gateway.json");
  const state={scopeId:P_SCOPE,ownershipAge:0,failOwnership:false,slowOwnership:false,stalled:0,aborted:0,slowRoutines:false,routineAborted:0,created:0,captures:0,lostBirth:false,stopped:false,restoreOnRoutineRead:false,
    bots:[P_BOT,P_TEMPORAL],temporal:new Set([P_TEMPORAL]),conflict:false,foreignIdentity:false,viewerOwner:true,
    calls:[] as string[],routines:new Map<string,Record<string,unknown>[]>([[P_BOT,[{id:"original-routine",name:"Reminder",prompt:"PRIVATE_PROTECTION_ROUTINE",trigger:{type:"webhook"},isEnabled:true,createdAt:1}]]]),
    grants:[{principalId:"owner",tokenSha256:hash(P_OWNER),capabilities:[...CAPABILITIES]},
      {principalId:"reader",tokenSha256:hash(P_READER),capabilities:["protection.read","operations.read","console.grants.create"]}] as AccessGrant[]};
  const nativeServer=createServer(async(req,res)=>{
    try{
      if(req.headers.authorization!=="Bearer synthetic-protection-native"){res.writeHead(401);res.end();return;}
      let body="";for await(const chunk of req)body+=chunk.toString();const input=JSON.parse(body);state.calls.push(req.url!);
      res.setHeader("content-type","application/json");
      if(req.url==="/api/listAgents"){res.end(JSON.stringify(state.bots.map(id=>({id,name:id===P_BOT?"Protected Bot":"Other Bot",isGroup:false,harness:state.temporal.has(id)?"temporal":"box",description:"PRIVATE_PROFILE"}))));return;}
      if(req.url==="/api/getHostStatus"){
        if(state.slowOwnership){state.stalled++;res.once("close",()=>state.aborted++);return;}
        if(state.failOwnership){res.writeHead(503);res.end();return;}
        const ids=input.grokboxOwnershipAgentIds??[];
        const snapshot=ownedOwnershipSnapshot(ids,{scopeId:state.scopeId,nowMs:Date.now()-state.ownershipAge});
        for(const row of snapshot.agents){row.server.harness=state.temporal.has(row.agentId)?"temporal":"box";row.local.before.harness=state.conflict?"box":row.server.harness;row.local.after.harness=row.local.before.harness;row.server.viewerIsOwner=state.viewerOwner;
          if(state.foreignIdentity){row.server.serverId="unrelated-native-id";}}
        res.end(JSON.stringify({grokboxOwnership:snapshot}));return;
      }
      if(req.url==="/api/getAgentAutomations"){
        if(state.slowRoutines){res.once("close",()=>state.routineAborted++);return;}
        if(state.restoreOnRoutineRead){state.temporal.delete(input.id);state.conflict=false;}res.end(JSON.stringify(state.routines.get(input.id)??[]));return;
      }
      if(req.url==="/api/setAgentAutomationEnabled"){
        const rows=state.routines.get(input.id)??[],row=rows.find(r=>r.id===input.automationId);if(row)row.isEnabled=input.isEnabled;
        res.end(JSON.stringify(rows));return;
      }
      if(req.url==="/api/grokboxCurrentStateControl"){res.end(JSON.stringify({ok:false,error:{code:"native_unavailable"}}));return;}
      res.writeHead(404);res.end(JSON.stringify({error:"synthetic-unsupported-native-call"}));
    }catch{if(!res.destroyed){res.writeHead(500);res.end();}}
  });
  nativeServer.listen(0,"127.0.0.1");await once(nativeServer,"listening");const address=nativeServer.address();if(!address||typeof address==="string")throw Error("fixture-listen");
  await publishConfigFile(discoveryPath,{scheme:"http",host:"127.0.0.1",port:address.port,pid:4242,startedAt:1000,token:"synthetic-protection-native"});
  const document=validateConfig({...defaultConfig(),ops:{observation:{enabled:false}},runtime:{desiredMode:"disabled",...(options.disabled?{continuity:{enabled:false}}:{})}});
  await publishConfigFile(join(root,"config.json"),document);
  const native=createManagementGateway({discoveryPath,configurationRoot:root,timeoutMs:1000});
  const timings:ProtectionServiceTestPorts={pollMs:20,discoveryMs:40,observationMs:30,advancementMs:35,handoverMs:50};
  if(options.simulatedRestore)timings.create=(context,scopeId,policy)=>{
    const actual=createNativeBotProtection(context,scopeId,policy),recovery=openContinuityRecoveryStore({durableRoot:root,scopeId});
    const capture=async(agentId:string,snapshotId:string)=>{
      context.signal?.throwIfAborted();state.captures++;
      try { const prior=await recovery.readSnapshot(snapshotId);return {snapshotId,revision:prior.reference.revision,quality:prior.manifest.quality,gaps:prior.manifest.gaps}; }
      catch(error){if(!(error instanceof ContinuityFailure && error.code==="not_found"))throw error;}
      const supplement=botSupplement({version:1,sourceId:agentId,memory:[{content:"PRIVATE_RECOVERY_MATERIAL",createdAt:1,kind:"profile"}],history:[],memoryComplete:true,historyComplete:false});
      const material=materialFromBotSupplement(supplement,{agentId,scopeId,nativeSchema:"synthetic-checkpoint",contextRevision:"e".repeat(64),capturedAtMs:Date.now(),transcriptThrough:null});
      const result=await recovery.publish({requestId:snapshotId,...material});
      return {snapshotId,revision:result.reference.revision,quality:material.manifest.quality,gaps:material.manifest.gaps};
    };
    const lifecycle:BotLifecyclePort={
      authorize:async request=>{const p=await policy(),found=Object.entries(p.bots).some(([id,b])=>b.enabled&&protectionRevision(id,b)===request.policyRevision);
        return {allowed:p.enabled&&found&&!context.signal?.aborted,scopeId,policyRevision:request.policyRevision,observedAtMs:Date.now()};},
      capture:(request,id)=>capture(request.sourceId!,id),create:async()=>{state.created++;if(!state.bots.includes(P_TARGET))state.bots.push(P_TARGET);if(state.lostBirth)throw Error("synthetic_lost_birth");return {agentId:P_TARGET,created:true,started:false};},
      load:async(_r,id)=>({agentId:id,loaded:true}),model:async()=>({modelId:"official"}),compose:async(_r,id,_source,snapshotId)=>capture(id,snapshotId),
      initialize:async(_r,_id,_snapshot,id)=>({operationId:id,state:"prepared"}),activate:async()=>({state:"released",activated:true,started:false}),
      startup:async()=>{throw Error("unexpected-business-task");},handover:async()=>({state:"active_with_handover"}),
    };
    return {...actual,lifecycle,capture:async(_logical,agent,id)=>capture(agent,id),
      request:async(logical,agent,operationId,snapshotId,p)=>botWorkflowRequest({version:1,operationId,scopeId,kind:p.mode==="prepare"?"clone":"replace",sourceId:agent,profile:{name:"Synthetic successor"},modelRef:null,
        instructions:"",snapshotId,activate:p.mode==="auto-replace",start:false,maxRunMs:1000,policyRevision:protectionRevision(logical,p),handover:p.handover}),
      handover:async()=>({state:"not-observed"})};
  };
  const serverOptions={store,installationId:P_INSTALL,native,allowedOrigins:[origin],env:{},readGrants:async()=>structuredClone(state.grants),port:0};
  let server=await startManagementServer(serverOptions,{hostHealth:{enabled:false},protection:timings});serverOptions.port=Number(new URL(server.url).port);
  const config=structuredClone(document);config.client.currentProfile="default";config.client.profiles={default:{serverUrl:server.url,installationId:P_INSTALL,daemonTokenRef:"env:SYNTHETIC_PROTECTION_CREDENTIAL"}};
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state","installation.json"),{schemaVersion:1,installationId:P_INSTALL,role:"box",root,daemon:{tokenSha256:hash(P_OWNER)}});
  await publishLayoutAliases(root,root,P_INSTALL);
  return {root,store,state,native,config,serverOptions,timings,get server(){return server;},
    controls:()=>openContinuityControls({durableRoot:root,scopeId:P_SCOPE}),
    client:(token=P_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:P_INSTALL,credential:async()=>token}),
    restart:async()=>{await server.close();server=await startManagementServer(serverOptions,{hostHealth:{enabled:false},protection:timings});},
    close:async()=>{try{await server.close();}finally{nativeServer.closeAllConnections();await new Promise<void>(r=>nativeServer.close(()=>r()));await rm(root,{recursive:true,force:true});}}
  };
}
