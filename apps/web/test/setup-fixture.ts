import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { OWNERSHIP_LOCAL_SOURCE } from "@grokbox/runtime-kernel/contract";
import { nativeAutomationIdentity } from "@grokbox/runtime-kernel/observation";
import { openRuntimeStore, openMonitorStore, publishConfigFile, publishLayoutAliases, reviewedProfilePath, createManagementGateway } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import type { NotificationRequest } from "../../../packages/box-runtime/src/internal/io/native-notification.node.ts";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";

export const SETUP_INSTALLATION = "11111111-1111-4111-8111-111111111111", SETUP_BOT = "22222222-2222-4222-8222-222222222222";
export const SETUP_OWNER = "synthetic-setup-owner", SETUP_READER = "synthetic-setup-reader", SETUP_KEY = "SYNTHETIC_SETUP_WEBHOOK_KEY", SETUP_MODEL = "d".repeat(64);
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
/** Initially unprepared receiver. Real Node Gateway/management/HTTP, SQLite and
 * private config/capsule; every Bot/Host/provider fact is synthetic. No fixture
 * native mutation is hidden from the per-method counter. */
export async function setupFixture(origin: string) {
  const root = await mkdtemp(join(tmpdir(),"setup-journey-")), discoveryPath = join(root,"gateway.json");
  const rows: Array<Record<string, unknown>> = [], calls: Array<{method:string;input:Record<string,unknown>}> = [];
  const state = { loseReply: "", changeGenerationAfterList: false, slowMethod: "", invalidMethod: "", serial: 0,
    grants: [{ principalId:"owner",tokenSha256:digest(SETUP_OWNER),capabilities:[...CAPABILITIES] },
      { principalId:"reader",tokenSha256:digest(SETUP_READER),capabilities:["notifications.read","routines.read","operations.read","console.grants.create"] }] as AccessGrant[] };
  const profile = { sourceSha256:"b".repeat(64),transformedSourceSha256:"c".repeat(64),slices:[] }, profileHash = sha256Text(JSON.stringify(profile)+"\n");
  await mkdir(dirname(reviewedProfilePath(root)),{recursive:true,mode:0o700});
  await publishConfigFile(reviewedProfilePath(root),profile);
  let discovery: {scheme:string;host:string;port:number;pid:number;startedAt:number;token:string};
  const gateway = createServer(async (request,response) => {
    try {
      if (request.headers.authorization !== "Bearer synthetic-setup-gateway") { response.writeHead(401); response.end(); return; }
      let body = ""; for await (const chunk of request) { body += chunk.toString(); if (body.length > 65536) throw Error("oversized_fixture_input"); }
      const input = JSON.parse(body), method = request.url!.slice("/api/".length); calls.push({method,input});
      if (state.slowMethod === method) return;
      if (state.invalidMethod === method) { response.end("PRIVATE_SETUP_BAD_NATIVE"); return; }
      let result: unknown;
      if (method === "listAgents") result = [{id:SETUP_BOT,name:"Setup Bot",harness:"box",isGroup:false}];
      else if (method === "getHostStatus") result = { grokboxOwnership: ownedOwnershipSnapshot([SETUP_BOT]),
        grokboxRuntimeCapabilities:{version:1,source:"Host.loaded-runtime-capabilities",ownershipLocal:{wrapperVersion:1,readerVersion:1,schemaVersion:1,source:OWNERSHIP_LOCAL_SOURCE},
          loaded:{pid:4242,start:1,profileSha256:profileHash,sourceSha256:profile.sourceSha256,transformedSha256:profile.transformedSourceSha256}},
        grokboxReceiverModel:{version:1,source:"grokbox.host.automation-model.v1",state:"observed",agentId:SETUP_BOT,observedAtMs:Date.now(),selection:"native",modelRevision:SETUP_MODEL,
          loadedProfileRevision:profileHash,loadedSourceRevision:profile.sourceSha256,loadedPreloadRevision:"e".repeat(64),loadedMode:"identity",reason:"selected",scope:"next_local_default_automation_session",executionObserved:false,toolsObserved:false,noModelRequest:true} };
      else {
        if (input.id !== SETUP_BOT) { response.writeHead(404); response.end(); return; }
        if (method === "createAgentAutomation") rows.push({...input.spec,id:`routine-${++state.serial}`,createdAt:state.serial});
        else if (method === "updateAgentAutomation") { const row = rows.find(r=>r.id === input.automationId); if (!row) throw Error("missing_fixture_routine"); Object.assign(row,input.spec); }
        else if (method === "setAgentAutomationEnabled") { const row = rows.find(r=>r.id === input.automationId); if (!row) throw Error("missing_fixture_routine"); row.isEnabled = input.isEnabled; }
        else if (method === "deleteAgentAutomation") { const index = rows.findIndex(r=>r.id===input.automationId); if (index>=0) rows.splice(index,1); }
        else if (!["getAgentAutomations","getAutomationWebhookCredential"].includes(method)) throw Error("unexpected_fixture_rpc");
        result = method === "getAutomationWebhookCredential" ? {url:`https://api2.cursor.sh/automations/webhook/${nativeAutomationIdentity(SETUP_BOT,String(input.automationId))}`,key:SETUP_KEY} : structuredClone(rows);
        if (state.changeGenerationAfterList && method === "getAgentAutomations") { state.changeGenerationAfterList = false; discovery.startedAt++; await publishConfigFile(discoveryPath,discovery); }
      }
      if (state.loseReply === method) { state.loseReply=""; response.destroy(); return; }
      response.setHeader("content-type","application/json"); response.end(JSON.stringify(result));
    } catch { if (!response.destroyed) { response.writeHead(500); response.end(); } }
  });
  gateway.listen(0,"127.0.0.1"); await once(gateway,"listening"); const address = gateway.address(); if (!address || typeof address === "string") throw Error("fixture_listen_failed");
  discovery={scheme:"http",host:"127.0.0.1",port:address.port,pid:4242,startedAt:1700000000000,token:"synthetic-setup-gateway"};
  await publishConfigFile(discoveryPath,discovery);
  let reply = (res:ServerResponse)=>{res.end("synthetic-accepted");}; const deliveries:string[]=[];
  const endpoint = createServer(async (req,res)=>{let text="";for await(const chunk of req) text+=chunk.toString();deliveries.push(text);reply(res);});
  endpoint.listen(0,"127.0.0.1");await once(endpoint,"listening");const receiverAddress=endpoint.address();if(!receiverAddress || typeof receiverAddress === "string") throw Error("fixture_listen_failed");
  const request:NotificationRequest=(url,options,callback)=>httpRequest({...options,protocol:"http:",hostname:"127.0.0.1",port:receiverAddress.port,path:url.pathname},callback);
  // First-setup tests isolate notification side effects; default protection
  // has its own managed-lifetime suite rather than adding unrelated native reads.
  const config=defaultConfig();config.runtime={...config.runtime,continuity:{enabled:false}};await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state","installation.json"),{schemaVersion:1,installationId:SETUP_INSTALLATION,role:"box",root,daemon:{tokenSha256:digest(SETUP_OWNER)}});
  const observations=openMonitorStore(root);await observations.initialize();
  const native=createManagementGateway({discoveryPath,configurationRoot:root});
  const options={store:openRuntimeStore(root,{}),installationId:SETUP_INSTALLATION,native,observations,allowedOrigins:[origin],readGrants:async()=>structuredClone(state.grants),env:{},port:0};
  const ports={hostHealth:{enabled:false},notification:{request,idleMs:10,blockedMs:10}};
  let server=await startManagementServer(options,ports);options.port=Number(new URL(server.url).port);
  config.client.currentProfile="default";config.client.profiles={default:{serverUrl:server.url,installationId:SETUP_INSTALLATION,daemonTokenRef:"env:SYNTHETIC_SETUP_CREDENTIAL"}};
  await publishConfigFile(join(root,"config.json"),config);await publishLayoutAliases(root,root,SETUP_INSTALLATION);
  const databaseId=(await observations.notificationScope()).databaseId;
  let epoch:string|undefined,sequence=0;
  return {root,rows,calls,state,deliveries,observations,databaseId,native,config,discoveryPath,
    get server(){return server;},reply:(handler:typeof reply)=>{reply=handler;},
    client:(token=SETUP_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:SETUP_INSTALLATION,credential:async()=>token}),
    restart:async()=>{await server.close();server=await startManagementServer(options,ports);},
    emit:async()=>{ if(!epoch){epoch=randomUUID();await observations.begin(epoch,Date.now(),[SETUP_BOT]);}
      await new Promise(r=>setTimeout(r,2));const n=++sequence;
      return observations.ingestEvidence({epoch,sourceKey:"f".repeat(64),expectedCursor:n===1?null:String(n-1),nextCursor:String(n),atMs:Date.now(),events:[{
        name:"host_stream_rejected",schemaVersion:2,at:new Date().toISOString(),hostGenerationId:profile.sourceSha256,mode:"route",agentId:SETUP_BOT,turnId:`test-turn-${n}`,stepId:`test-step-${n}`,stage:"normalize",errorCode:"invalid_stream",reason:"invalid-stream"}]}); },
    close:async()=>{await server.close();gateway.closeAllConnections();endpoint.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>endpoint.close(()=>r()))]);await rm(root,{recursive:true,force:true});},
  };
}
