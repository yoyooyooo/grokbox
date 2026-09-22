import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
export const JOB_INSTALLATION="11111111-1111-4111-8111-111111111111", JOB_OWNER="synthetic-job-owner", JOB_READER="synthetic-job-reader", JOB_OTHER="synthetic-job-other";
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
/** Real disposable OS processes and files. No native Bot, model or external network. */
export async function jobFixture(origin="https://jobs.example.test") {
  const root=await mkdtemp(join(tmpdir(),"managed-jobs-")), workspace=join(root,"workspace");
  await mkdir(workspace,{mode:0o700});
  const config=validateConfig({...defaultConfig(),daemon:{filesystem:{roots:[{name:"workspace",path:workspace,operations:["exec"]}]},process:{
    cwdRoots:["workspace"],defaultCwdRoot:"workspace",executables:[{name:"node",path:await realpath(process.execPath)}],
    environment:["VISIBLE"],maxConcurrent:1,maxQueued:4,maxRuntimeMs:30000,maxOutputBytes:131072}}});
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state/installation.json"),{schemaVersion:1,installationId:JOB_INSTALLATION,role:"box",root,daemon:{tokenSha256:digest(JOB_OWNER)}});
  await publishLayoutAliases(root,root,JOB_INSTALLATION);
  const state={nativeReads:0,transportFailures:[] as Array<{method:string;code:string|null;cause:string|null}>,grants:[
    {principalId:"owner",tokenSha256:digest(JOB_OWNER),capabilities:[...CAPABILITIES]},
    {principalId:"owner",tokenSha256:digest(JOB_READER),capabilities:["jobs.read","operations.read","console.grants.create"]},
    {principalId:"other",tokenSha256:digest(JOB_OTHER),capabilities:[...CAPABILITIES]},
  ] as AccessGrant[],onGrants:undefined as undefined|(()=>void|Promise<void>)};
  const noNative=async()=>{state.nativeReads++;throw Error("native_not_authorized");};
  const options={root,store:openRuntimeStore(root,{}),installationId:JOB_INSTALLATION,native:{listBots:noNative,ownershipRead:noNative},
    readGrants:async()=>{await state.onGrants?.();return structuredClone(state.grants);},allowedOrigins:[origin],env:{},port:0};
  const start=()=>startManagementServer(options,{hostHealth:{enabled:false}});
  let server=await start();options.port=Number(new URL(server.url).port);
  config.client.profiles.default={serverUrl:server.url,installationId:JOB_INSTALLATION,daemonTokenRef:"env:SYNTHETIC_JOB_CREDENTIAL"};
  await publishConfigFile(join(root,"config.json"),config);
  return {root,workspace,config,state,get server(){return server;},
    client:(token=JOB_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:JOB_INSTALLATION,credential:async()=>token,timeoutMs:30000,
      fetch:Object.assign((u:string|URL|Request,init?:RequestInit)=>fetch(u,init).catch(e=>{const err=e as {code?:string;cause?:{code?:string}};state.transportFailures.push({method:init?.method??"GET",code:err.code??null,cause:err.cause?.code??null});throw e;}),{preconnect:()=>undefined}) as typeof fetch}),
    restart:async()=>{await server.close();server=await start();},
    close:async()=>{try{await server.close();}finally{await rm(root,{recursive:true,force:true});}}};
}
