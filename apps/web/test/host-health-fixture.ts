import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { openRuntimeStore, openMonitorStore, publishConfigFile, publishLayoutAliases, type HostHealthTestPorts } from "@grokbox/box-runtime/runtime";
import { LIVE_SLICE_PATCHES } from "../../../packages/box-runtime/src/internal/host/live-slices.ts";
import { profileFromSource, type SlicePatch } from "../../../packages/box-runtime/src/internal/host/profile.ts";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
export const H_INSTALL="11111111-1111-4111-8111-111111111111", H_OWNER="synthetic-health-owner", H_READER="synthetic-health-reader";
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
/** Public, independently authored JavaScript, never imported/evaluated. The
 * production TS transformation supplies the actual candidate to the real Rust
 * binary. Native RPCs deliberately fail: sensing must not need any Bot. */
export async function hostHealthFixture(origin:string, settings:{disabled?:boolean;noMonitor?:boolean;badRecipe?:boolean;ports?:HostHealthTestPorts}={}) {
  const root=await mkdtemp(join(tmpdir(),"host-health-management-")), inputs=join(root,"inputs");await mkdir(inputs,{mode:0o700});
  const source=await readFile(join(process.env.GROKBOX_TEST_FIXTURES!,"host-verifier/sources/contracts.cjs"),"utf8");
  const paths={source:join(inputs,"host-main.cjs"),worker:join(inputs,"worker.cjs"),profile:join(inputs,"profile.json")};
  const slices=LIVE_SLICE_PATCHES.filter(s=>["create-session","agent-id","managed-turn-retry-gate","compact-register"].includes(s.id));
  const writeProfile=async(text=source, selected:readonly SlicePatch[]=slices)=>publishConfigFile(paths.profile,profileFromSource(text,selected,"public-health-fixture"));
  await writeFile(paths.source,source,{mode:0o600});await writeFile(paths.worker,"// Independent companion.\nmodule.exports = {};\n",{mode:0o600});await writeProfile();
  if(settings.badRecipe)await writeFile(paths.source,source+"\n// source drift\n",{mode:0o600});
  const config=validateConfig({...defaultConfig(),runtime:{desiredMode:settings.disabled?"disabled":"identity",continuity:{enabled:false}}});
  await publishConfigFile(join(root,"config.json"),config);
  const state={nativeCalls:0,pids:[] as number[],grants:[{principalId:"owner",tokenSha256:digest(H_OWNER),capabilities:[...CAPABILITIES]},
    {principalId:"reader",tokenSha256:digest(H_READER),capabilities:["bots.read","console.grants.create"]}] as AccessGrant[]};
  const observations=openMonitorStore(root);
  if(!settings.noMonitor){await observations.initialize();await observations.begin(randomUUID(),Date.now(),[]);}
  const ports:HostHealthTestPorts={paths,runtime:{runRoot:join(root,"run")},binaryDirectory:join(dirname(process.env.GROKBOX_TEST_CLI_ENTRY!),"native/x86_64-unknown-linux-gnu"),pollMs:25,backstopMs:500,onSpawn:pid=>{state.pids.push(pid);},...settings.ports};
  const options={store:openRuntimeStore(root,{}),observations,installationId:H_INSTALL,native:{listBots:async()=>{state.nativeCalls++;throw Error("no-native-roster");},ownershipRead:async()=>{state.nativeCalls++;throw Error("no-native-ownership");}},
    env:{},allowedOrigins:[origin],port:0,readGrants:async()=>structuredClone(state.grants)};
  let server=await startManagementServer(options,{hostHealth:ports});options.port=Number(new URL(server.url).port);
  config.client.profiles={default:{serverUrl:server.url,installationId:H_INSTALL,daemonTokenRef:"env:SYNTHETIC_HEALTH_CREDENTIAL"}};config.client.currentProfile="default";
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state/installation.json"),{schemaVersion:1,installationId:H_INSTALL,role:"box",root,daemon:{tokenSha256:digest(H_OWNER)}});
  await publishLayoutAliases(root,root,H_INSTALL);
  return {root,paths,source,slices,writeProfile,observations,state,ports,options,get server(){return server;},
    client:(credential=H_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:H_INSTALL,credential:async()=>credential,fetch:(async(input,init)=>{const headers=new Headers(init?.headers);headers.set("connection","close");return fetch(input,{...init,headers});}) as typeof fetch}),
    restart:async()=>{await server.close();server=await startManagementServer(options,{hostHealth:ports});},
    close:async()=>{await server.close();await rm(root,{recursive:true,force:true});}};
}
