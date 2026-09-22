import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import type { DesktopWorld } from "@grokbox/runtime-kernel/desktop";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases, type DesktopIo } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import type { DesktopTestPorts } from "../../../packages/server/src/desktop.ts";
export const DESKTOP_INSTALLATION="11111111-1111-4111-8111-111111111111", DESKTOP_AGENT="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DESKTOP_MAIN="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const DESKTOP_OWNER="synthetic-desktop-owner", DESKTOP_READER="synthetic-desktop-reader", DESKTOP_OTHER="synthetic-desktop-other";
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
export function desktopWorld():DesktopWorld { return { complete:true,displayIdentities:{1:"1".repeat(64),2:"2".repeat(64)},nowMs:Date.now(),assignments:{[DESKTOP_MAIN]:1,[DESKTOP_AGENT]:2},names:{[DESKTOP_MAIN]:"Main",[DESKTOP_AGENT]:"Synthetic idle Bot"},
  litDisplays:new Set([1,2]),displayStartedAtMs:{1:0,2:0},transcriptWrittenAtMs:{[DESKTOP_MAIN]:0,[DESKTOP_AGENT]:0},busyMarkers:new Set(),grokDisplays:new Set(),taskDisplays:new Set(),startWindowDisplays:new Set() }; }
export async function desktopFixture(origin="https://desktop.example.test",hooks:Omit<DesktopTestPorts,"io">={}){
  const directory=await mkdtemp(join(tmpdir(),"managed-desktop-")),root=join(directory,"control");await mkdir(root,{mode:0o700});
  const config=validateConfig({...defaultConfig(),desktop:{idleReclaim:{enabled:false,minIdleMs:600000},keepAgentIds:[]}});
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state/installation.json"),{schemaVersion:1,installationId:DESKTOP_INSTALLATION,role:"box",root,daemon:{tokenSha256:digest(DESKTOP_OWNER)},desktop:{floorAgentIds:[]}});
  await publishLayoutAliases(root,root,DESKTOP_INSTALLATION);
  const state={world:desktopWorld(),reads:0,nativeReads:0,stops:[] as number[],stop:undefined as undefined|DesktopIo["stopWindow"],read:undefined as undefined|(()=>Promise<void>),grants:[
    {principalId:"owner",tokenSha256:digest(DESKTOP_OWNER),capabilities:[...CAPABILITIES]},
    {principalId:"owner",tokenSha256:digest(DESKTOP_READER),capabilities:["desktop.read","operations.read","console.grants.create"]},
    {principalId:"other",tokenSha256:digest(DESKTOP_OTHER),capabilities:[...CAPABILITIES]},
  ] as AccessGrant[]};
  const io:DesktopIo={readWorld:async(now)=>{state.reads++;await state.read?.();return {...structuredClone(state.world),nowMs:now};},stopWindow:async(display,signal)=>{state.stops.push(display);if(state.stop)await state.stop(display,signal);else(state.world.litDisplays as Set<number>).delete(display);},reapLogs:async()=>{},unseatAgent:async()=>{throw Error("ordinary_prune_must_not_unseat");}};
  const native=async()=>{state.nativeReads++;throw Error("no_native_bot_access_for_desktop");};
  const options={store:openRuntimeStore(root,{}),installationId:DESKTOP_INSTALLATION,native:{listBots:native,ownershipRead:native},readGrants:async()=>structuredClone(state.grants),allowedOrigins:[origin],port:0,env:{}};
  const start=()=>startManagementServer(options,{hostHealth:{enabled:false},desktop:{io,intervalMs:hooks.intervalMs,afterClaim:async()=>{await hooks.afterClaim?.();},afterDispatchClaim:async()=>{await hooks.afterDispatchClaim?.();}}});let server=await start();
  config.client.profiles.default={serverUrl:server.url,installationId:DESKTOP_INSTALLATION,daemonTokenRef:"env:SYNTHETIC_DESKTOP_CREDENTIAL"};await publishConfigFile(join(root,"config.json"),config);
  return {directory,root,config,state,hooks,io,options,get server(){return server;},client:(token=DESKTOP_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:DESKTOP_INSTALLATION,credential:async()=>token,timeoutMs:30000}),
    save:()=>publishConfigFile(join(root,"config.json"),config),restart:async()=>{await server.close();server=await start();config.client.profiles.default!.serverUrl=server.url;await publishConfigFile(join(root,"config.json"),config);},
    close:async()=>{try{await server.close();}finally{await rm(directory,{recursive:true,force:true});}}};
}
