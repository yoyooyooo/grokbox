import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient, fileReference } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import type { FileTestHooks } from "../../../packages/server/src/files.ts";
export const FILE_INSTALLATION="11111111-1111-4111-8111-111111111111",FILE_OWNER="synthetic-file-owner",FILE_READER="synthetic-file-reader",FILE_OTHER="synthetic-file-other";
const digest=(v:string)=>createHash("sha256").update(v).digest("hex");
export async function fileFixture(origin="https://files.example.test",hooks:FileTestHooks={}){
  const directory=await mkdtemp(join(tmpdir(),"managed-files-")),root=join(directory,"control"),files=join(directory,"files");
  await mkdir(root,{mode:0o700});await mkdir(files,{mode:0o700});
  const config=validateConfig({...defaultConfig(),daemon:{filesystem:{roots:[{name:"workspace",path:files,operations:["stat","list","read","download","write","mkdir","upload","remove","remove-recursive","restore"]}]}}});
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state/installation.json"),{schemaVersion:1,installationId:FILE_INSTALLATION,role:"box",root,daemon:{tokenSha256:digest(FILE_OWNER)}});
  await publishLayoutAliases(root,root,FILE_INSTALLATION);
  const state={nativeReads:0,grants:[{principalId:"owner",tokenSha256:digest(FILE_OWNER),capabilities:[...CAPABILITIES]},
    {principalId:"owner",tokenSha256:digest(FILE_READER),capabilities:["files.read","operations.read","console.grants.create"]},
    {principalId:"other",tokenSha256:digest(FILE_OTHER),capabilities:[...CAPABILITIES]}] as AccessGrant[]};
  const nativeRead=async()=>{state.nativeReads++;throw Error("no_native_file_access");};
  const options={store:openRuntimeStore(root,{}),installationId:FILE_INSTALLATION,native:{listBots:nativeRead,ownershipRead:nativeRead},readGrants:async()=>structuredClone(state.grants),allowedOrigins:[origin],maxConcurrentRequests:64,port:0,env:{}};
  const start=()=>startManagementServer(options,{hostHealth:{enabled:false},files:hooks});let server=await start();options.port=Number(new URL(server.url).port);
  config.client.profiles.default={serverUrl:server.url,installationId:FILE_INSTALLATION,daemonTokenRef:"env:SYNTHETIC_FILE_CREDENTIAL"};await publishConfigFile(join(root,"config.json"),config);
  const client=(token=FILE_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:FILE_INSTALLATION,credential:async()=>token,timeoutMs:30000});
  const roots=(await client().fileRoots()).data;if(roots.state!=="ready")throw Error("file_fixture_not_ready");const binding=roots.roots[0]!.binding;
  return {directory,root,files,config,state,hooks,get server(){return server;},client,ref:(path="")=>fileReference(FILE_INSTALLATION,binding,"workspace",path),
    save:()=>publishConfigFile(join(root,"config.json"),config),restart:async()=>{await server.close();options.port=0;server=await start();config.client.profiles.default!.serverUrl=server.url;await publishConfigFile(join(root,"config.json"),config);},close:async()=>{try{await server.close();}finally{await rm(directory,{recursive:true,force:true});}}};
}
