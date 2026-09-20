import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases, openMaterialStore, type MaterialWriteHooks, scanMaterialSource } from "@grokbox/box-runtime/runtime";
import { defaultConfig, type UnifiedConfig } from "@grokbox/runtime-kernel/config";
import { startManagementServer, type AccessGrant, type ManagementNative } from "@grokbox/server";
export const MATERIAL_INSTALLATION = "11111111-1111-4111-8111-111111111111", MATERIAL_BOT = "22222222-2222-4222-8222-222222222222";
export const MATERIAL_OWNER = "synthetic-material-owner", MATERIAL_READER = "synthetic-material-reader", MATERIAL_SEARCHER = "synthetic-material-searcher";
export const BODY_SENTINEL = "SYNTHETIC_PRIVATE_MATERIAL_CONTENT";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
export async function materialsFixture(origin: string, input: { enabled?: boolean; intervalMs?: number; writeHooks?: MaterialWriteHooks; scan?: typeof scanMaterialSource } = {}) {
  const directory = await mkdtemp(join(tmpdir(),"materials-fixture-")), root = join(directory,"managed"), nativeRoot = join(directory,"native"), filesRoot = join(directory,"documents");
  await Promise.all([root,nativeRoot,filesRoot].map(p => mkdir(p,{mode:0o700})));
  const put = async (base: string, path: string, content: string | Uint8Array) => { const p = join(base,path); await mkdir(dirname(p),{recursive:true,mode:0o700}); await writeFile(p,content,{mode:0o600}); };
  await put(nativeRoot,`agents/${MATERIAL_BOT}/memory/profile.md`,`${BODY_SENTINEL}\nA shared phrase and café.\n`);
  await put(nativeRoot,`agents/${MATERIAL_BOT}/memory/log/2026-09.md`,"# Recent log\nA dated decision.\n");
  await put(nativeRoot,`agents/${MATERIAL_BOT}/projects.json`,JSON.stringify({projects:["alpha","not-authorized"]}));
  await put(nativeRoot,`user-memory/by-agent/${MATERIAL_BOT}/profile.md`,"A shared phrase and café.\n");
  await put(nativeRoot,`projects/alpha/project.md`,"---\nname: Alpha\n---\nProject description.\n");
  await put(nativeRoot,`projects/alpha/memory/by-agent/${MATERIAL_BOT}/profile.md`,"A shared phrase and café.\n");
  await put(nativeRoot,`agents/99999999-9999-4999-8999-999999999999/memory/profile.md`,"UNAUTHORIZED_SHARD");
  await put(filesRoot,"notes.md","Original file. A shared phrase.\n");
  await put(filesRoot,"nested/other.txt","Searchable second file.\n");
  await put(filesRoot,".env","SYNTHETIC_SECRET_NOT_A_DOCUMENT");
  let nativeReads = 0;
  const native: ManagementNative = { listBots: async () => { nativeReads++; return {bots:[],source:{kind:"native-gateway",generation:"a".repeat(64),pid:1,startedAt:1,observedAt:Date.now()},coverage:"current-snapshot"}; }, ownershipRead: async () => {nativeReads++;throw Error("synthetic_native_not_used");} };
  const state = { grants: [
    { principalId:"owner",tokenSha256:hash(MATERIAL_OWNER),capabilities:[...CAPABILITIES] },
    { principalId:"reader",tokenSha256:hash(MATERIAL_READER),capabilities:["materials.read","operations.read","console.grants.create"] },
    { principalId:"searcher",tokenSha256:hash(MATERIAL_SEARCHER),capabilities:["materials.read","materials.search","console.grants.create"] },
  ] as AccessGrant[] };
  const config: UnifiedConfig = defaultConfig();
  if (input.enabled !== false) config.materials = {enabled:true,intervalMs:10000,sources:[
    {id:"native",kind:"native-memory",root:nativeRoot,accountScope:"b".repeat(64),agentIds:[MATERIAL_BOT],projects:["alpha"]},
    {id:"documents",kind:"files",root:filesRoot,accountScope:"c".repeat(64),writable:true},
  ]};
  await publishConfigFile(join(root,"config.json"),config);
  const options = { store:openRuntimeStore(root,{}),installationId:MATERIAL_INSTALLATION,native,readGrants:async()=>structuredClone(state.grants),env:{},allowedOrigins:[origin],port:0 };
  const ports = {materials:{intervalMs:input.intervalMs ?? 50,writeHooks:input.writeHooks,scan:input.scan}};
  let server = await startManagementServer(options,ports); options.port = Number(new URL(server.url).port);
  config.client.profiles = {default:{serverUrl:server.url,installationId:MATERIAL_INSTALLATION,daemonTokenRef:"env:SYNTHETIC_MATERIAL_CREDENTIAL"}};
  await publishConfigFile(join(root,"config.json"),config);
  await publishConfigFile(join(root,"state/installation.json"),{schemaVersion:1,installationId:MATERIAL_INSTALLATION,role:"box",root,daemon:{tokenSha256:hash(MATERIAL_OWNER)}});
  await publishLayoutAliases(root,root,MATERIAL_INSTALLATION);
  return {directory,root,nativeRoot,filesRoot,config,state,put,index:openMaterialStore(root),nativeReads:()=>nativeReads,get server(){return server;},
    client:(credential=MATERIAL_OWNER)=>new ManagementClient({baseUrl:server.url,installationId:MATERIAL_INSTALLATION,credential:async()=>credential,
      // Test callers reopen a connection across intentional same-port restarts;
      // production transport retains its single-attempt/no-retry behavior.
      fetch: Object.assign(async (url: string | URL | Request,init?: RequestInit) => { const headers=new Headers(init?.headers);headers.set("connection","close");return fetch(url,{...init,headers}); }, {preconnect:fetch.preconnect}) }),
    saveConfig:()=>publishConfigFile(join(root,"config.json"),config),restart:async()=>{await server.close();server=await startManagementServer(options,ports);},
    close:async()=>{await server.close();await rm(directory,{recursive:true,force:true});},
  };
}
export async function materialUntil<A>(read:()=>Promise<A>,ready:(value:A)=>boolean,ms=8000):Promise<A>{
  const end=Date.now()+ms;let last:unknown;
  while(Date.now()<end){try{const value=await read();if(ready(value))return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,25));}
  throw new Error(`material_fixture_deadline:${last instanceof Error ? last.message : "not_ready"}`);
}
