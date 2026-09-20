import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, rename, link, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { validateConfig } from "@grokbox/runtime-kernel/config";
import { startMaterialIndexer, scanMaterialSource } from "@grokbox/box-runtime/runtime";
import { openMonitorSqlite, MonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { materialsFixture, materialUntil, MATERIAL_OWNER } from "../../../apps/web/test/materials-fixture.ts";
const origin="https://material-boundaries.example.test";
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&e.code===code);
async function ready(f:Awaited<ReturnType<typeof materialsFixture>>){return (await materialUntil(()=>f.client().materials({kind:"file"}),r=>r.data.items.length===2)).data.items.find(d=>d.path==="notes.md")!;}
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test("competing material operations share one durable document fence, not two source writers",async()=>{
 let release!:()=>void,entered=false;const gate=new Promise<void>(r=>release=r);
 const f=await materialsFixture(origin,{writeHooks:{beforePublish:async()=>{entered=true;await gate;}}});try{
  const doc=await ready(f),input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"one",confirmed:true as const};
  const first=f.client().changeMaterial(input);await materialUntil(async()=>entered,Boolean);
  await rejects(f.client().changeMaterial({...input,requestId:randomUUID(),content:"two"}),"operation_unknown");
  assert.ok((await readFile(join(f.filesRoot,"notes.md"),"utf8")).startsWith("Original"));release();assert.equal((await first).data.state,"succeeded");
  assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"one");
 }finally{release();await f.close();}
});
test("external edits during preflight are retained, with a refused historical operation instead of overwriting",async()=>{
 let overwrite:()=>Promise<void>=async()=>undefined;const f=await materialsFixture(origin,{writeHooks:{beforePublish:()=>overwrite()}});try{
  const doc=await ready(f);overwrite=()=>f.put(f.filesRoot,"notes.md","An external writer won.");const input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"Must not replace external work.",confirmed:true as const};
  await rejects(f.client().changeMaterial(input),"revision_conflict");assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"An external writer won.");
  assert.equal((await f.client().materialOperation(input.requestId)).data.state,"refused");
 }finally{await f.close();}
});
test("permission withdrawal before publication prevents a late source write",async()=>{
 let revoke=()=>{};const f=await materialsFixture(origin,{writeHooks:{beforePublish:async()=>revoke()}});try{
  const doc=await ready(f),before=await readFile(join(f.filesRoot,"notes.md"));revoke=()=>{f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="materials.write");};
  const input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"Forbidden after revoke",confirmed:true as const};
  await assert.rejects(f.client().changeMaterial(input));assert.deepEqual(await readFile(join(f.filesRoot,"notes.md")),before);
  assert.equal((await f.client().materialOperation(input.requestId)).data.state,"refused");
 }finally{await f.close();}
});
test("removing an authorized source blocks cached access but preserves the original caller's receipt",async()=>{
 const f=await materialsFixture(origin);try{
  const doc=await ready(f),input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"Retained historical source effect",confirmed:true as const};
  const receipt=(await f.client().changeMaterial(input)).data;f.config.materials!.sources=f.config.materials!.sources.filter(s=>s.id!=="documents");await f.saveConfig();
  await rejects(f.client().readMaterial(doc.ref),"permission_denied");await rejects(f.client().materials({sourceId:"documents"}),"permission_denied");
  assert.deepEqual((await f.client().materialOperation(input.requestId)).data,receipt);
  assert.deepEqual((await f.client().changeMaterial(input)).data,receipt);
  await materialUntil(()=>f.index.views(),v=>!v.some(s=>s.id==="documents"));
 }finally{await f.close();}
});
for(const mode of ["missing","corrupt"] as const)test(`${mode} material database is not recreated and cannot erase source operation guards`,async()=>{
 const f=await materialsFixture(origin);try{
  const doc=await ready(f);await f.server.close();
  if(mode==="missing")await rm(f.index.path);else await f.put(f.root,"state/materials/materials.sqlite","BROKEN_SYNTHETIC_INDEX");
  await f.restart();await pause(150);await rejects(f.client().materials(),"source_unavailable");
  if(mode==="missing")assert.equal(await f.index.exists(),false);else assert.equal(await readFile(f.index.path,"utf8"),"BROKEN_SYNTHETIC_INDEX");
  assert.ok((await readFile(join(f.filesRoot,"notes.md"),"utf8")).startsWith("Original"));
  const direct=(await f.client().readMaterial(doc.ref)).data;assert.ok(direct.content.startsWith("Original"));assert.equal(direct.indexState,mode==="missing"?"not-indexed":"unavailable");
  await rejects(f.client().changeMaterial({ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"Guard must survive damage",confirmed:true}),"source_unavailable");
 }finally{await f.close();}
});
test("one missing source does not hide another source's updates or become a successful empty native index",async()=>{
 const f=await materialsFixture(origin);try{
  await ready(f);await rename(f.nativeRoot,`${f.nativeRoot}-offline`);await f.put(f.filesRoot,"notes.md","Independent source still indexing.");
  const page=(await materialUntil(()=>f.client().materials({query:"Independent source"}),r=>r.data.items.length===1)).data;
  assert.equal(page.sources.find(s=>s.id==="native")?.state,"unavailable");assert.equal(page.sources.find(s=>s.id==="native")?.binding,null);
  assert.equal((await f.client().materials({kind:"memory"})).data.items.length,0);
 }finally{await f.close();}
});
test("oversized, binary and hardlinked documents are disclosed as partial, while protected files stay outside scope",async()=>{
 const f=await materialsFixture(origin);try{
  await ready(f);await f.put(f.filesRoot,"large.md","a".repeat(65537));await f.put(f.filesRoot,"binary.txt",new Uint8Array([255,0]));await link(join(f.filesRoot,"notes.md"),join(f.filesRoot,"alias.md"));
  const status=(await materialUntil(()=>f.client().materialStatus(),r=>(r.data.sources.find(s=>s.id==="documents")?.skipped??0)>=4)).data;
  assert.equal(status.sources.find(s=>s.id==="documents")?.state,"partial");
  const items=(await f.client().materials({kind:"file"})).data.items;assert.deepEqual(items.map(d=>d.path),["nested/other.txt"]);
 }finally{await f.close();}
});
test("overlapping source roots cannot provide a writable alias around a native read-only source",async()=>{
 const f=await materialsFixture(origin);try{
  await ready(f);const file=f.config.materials!.sources.find(s=>s.id==="documents")!;file.root=f.nativeRoot;await f.saveConfig();
  const status=(await f.client().materialStatus()).data;assert.ok(status.sources.every(s=>s.state==="unavailable"&&s.reason==="overlapping-source-roots"));
  const invalid=structuredClone(f.config);Object.assign(invalid.materials!.sources[0]!,{writable:true});assert.throws(()=>validateConfig(invalid));
 }finally{await f.close();}
});
test("metadata and body queries themselves leave the material database byte-for-byte unchanged",async()=>{
 const f=await materialsFixture(origin,{intervalMs:1000});try{
  const doc=await ready(f),before=await readFile(f.index.path),info=await stat(f.index.path);
  await f.client().materials({query:"phrase"});await f.client().readMaterial(doc.ref);await f.client().materialStatus();
  assert.deepEqual(await readFile(f.index.path),before);assert.equal((await stat(f.index.path)).mtimeMs,info.mtimeMs);
 }finally{await f.close();}
});
test("closing the management host cancels a blocked scan and publishes no late index snapshot",async()=>{
 let entered=false;const f=await materialsFixture(origin,{scan:async(_source,signal)=>{entered=true;await new Promise<void>(resolve=>{signal.addEventListener("abort",()=>resolve(),{once:true});if(signal.aborted)resolve();});return {documents:[],skipped:0};}});try{
  await materialUntil(async()=>entered,Boolean);await f.server.close();const bytes=await readFile(f.index.path);await pause(50);assert.deepEqual(await readFile(f.index.path),bytes);assert.deepEqual(await f.index.views(),[]);
 }finally{await f.close();}
});
test("unchanged reconciliation refreshes freshness without invalidating stable traversal cursors",async()=>{
 const f=await materialsFixture(origin);try{
  await ready(f);const first=(await f.client().materials({limit:2})).data;
  const time=first.sources.find(s=>s.id==="documents")!.indexedAtMs!;
  await materialUntil(()=>f.client().materialStatus(),r=>(r.data.sources.find(s=>s.id==="documents")?.indexedAtMs??0)>time);
  const second=(await f.client().materials({limit:2,cursor:first.nextCursor!})).data;
  assert.equal(second.snapshot,first.snapshot);assert.equal(new Set([...first.items,...second.items].map(d=>d.ref)).size,4);
 }finally{await f.close();}
});
test("index source availability and stale index age are independent observations",async()=>{
 const f=await materialsFixture(origin,{intervalMs:50000});try{
  await ready(f);const db=await openMonitorSqlite(f.index.path,"write");
  try{const row=await db.first("SELECT view_json FROM sources WHERE id='documents'");const view=JSON.parse(String(row!.view_json));view.indexedAtMs=Date.now()-60000;await db.run("UPDATE sources SET view_json=? WHERE id='documents'",[JSON.stringify(view)]);}finally{await db.close();}
  const source=(await f.client().materialStatus()).data.sources.find(s=>s.id==="documents")!;
  assert.equal(source.state,"ready");assert.equal(source.freshness,"stale");assert.equal(source.upstreamSync,"not-observed");
 }finally{await f.close();}
});
test("competing management indexers serialize scans without holding a database transaction during source IO",async()=>{
 let entered=false,release!:()=>void,competingScans=0;const gate=new Promise<void>(r=>release=r);
 const f=await materialsFixture(origin,{scan:async(source,signal)=>{entered=true;await gate;return scanMaterialSource(source,signal);}});let other:ReturnType<typeof startMaterialIndexer>|undefined;
 try{
  await materialUntil(async()=>entered,Boolean);other=startMaterialIndexer({root:f.root,installationId:"11111111-1111-4111-8111-111111111111"},{intervalMs:10,scan:async(...args)=>{competingScans++;return scanMaterialSource(...args);}});
  await materialUntil(async()=>other!.status().cycles,n=>n>1);assert.equal(competingScans,0);
  const db=await openMonitorSqlite(f.index.path,"write");try{await db.run("BEGIN IMMEDIATE");await db.run("ROLLBACK");}finally{await db.close();}
  await other.close();other=undefined;release();await ready(f);
 }finally{release();await other?.close();await f.close();}
});
test("a lost reservation COMMIT callback preserves unknown and never starts a source publication",async()=>{
 const f=await materialsFixture(origin,{intervalMs:50000}),original=MonitorSqlite.prototype.run;let armed=false,injected=false;
 try{
  const doc=await ready(f),input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"Do not publish after uncertain reservation",confirmed:true as const};
  MonitorSqlite.prototype.run=async function(sql,params){await original.call(this,sql,params);if(sql.startsWith("INSERT INTO operations VALUES"))armed=true;if(sql==="COMMIT"&&armed&&!injected){injected=true;throw new Error("synthetic_lost_commit_callback");}};
  await rejects(f.client().changeMaterial(input),"operation_unknown");MonitorSqlite.prototype.run=original;
  assert.equal(injected,true);assert.ok((await readFile(join(f.filesRoot,"notes.md"),"utf8")).startsWith("Original"));
  assert.equal((await f.client().materialOperation(input.requestId)).data.state,"unknown");await rejects(f.client().changeMaterial(input),"operation_unknown");
 }finally{MonitorSqlite.prototype.run=original;await f.close();}
});
async function cli(root:string,args:string[]){
 const child=spawn("node",[process.env.GROKBOX_TEST_CLI_ENTRY!,...args],{cwd:root,env:{PATH:process.env.PATH,HOME:root,GROKBOX_CONFIG_DIR:root,GROKBOX_BOX_RUNTIME_ROOT:root,SYNTHETIC_MATERIAL_CREDENTIAL:MATERIAL_OWNER},stdio:["ignore","pipe","pipe"]});
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);const timer=setTimeout(()=>child.kill("SIGKILL"),10000);const [code,signal]=await once(child,"close");clearTimeout(timer);assert.equal(signal,null);assert.equal(code,0,stderr+stdout);return JSON.parse(stdout).data;
}
test("source onboarding uses the canonical config command; preview is inert and confirmation starts only local indexing",async()=>{
 const f=await materialsFixture(origin,{enabled:false});try{
  const value={enabled:true,intervalMs:10000,sources:[{id:"documents",kind:"files",root:f.filesRoot,accountScope:"c".repeat(64),writable:true}]};
  await f.put(f.directory,"material-sources.json",JSON.stringify(value));const path=join(f.directory,"material-sources.json");
  await cli(f.root,["config","set","materials","--value-file",path,"--scope","local","--replace","--preview"]);
  assert.equal(await f.index.exists(),false);const config=await cli(f.root,["config","get","materials","--scope","local"]);assert.equal(config.found,false);
  await cli(f.root,["config","set","materials","--value-file",path,"--scope","local","--replace","--expect-revision",config.configRevision,"--operation-id",randomUUID(),"--confirm"]);
  const doc=await ready(f);assert.equal(doc.writable,true);assert.equal(f.nativeReads(),0);
  const exported=await cli(f.root,["config","export","--portable"]);assert.equal(exported.document.materials,undefined);assert.ok(!JSON.stringify(exported).includes(f.filesRoot));
 }finally{await f.close();}
});
test("formal CLI reads all three material families and recovers a file operation through the same Server",async()=>{
 const f=await materialsFixture(origin);try{
  const doc=await ready(f);assert.equal((await cli(f.root,["memory","list"])).items.length,4);assert.equal((await cli(f.root,["project","list"])).items.length,1);
  assert.equal((await cli(f.root,["file","search","shared"])).items.length,1);
  const input={ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"CLI source update"};const path=join(f.directory,"input.json");await f.put(f.directory,"input.json",JSON.stringify(input));
  const result=await cli(f.root,["file","write","--input",`@${path}`,"--confirm"]);assert.equal(result.state,"succeeded");
  await f.restart();assert.deepEqual(await cli(f.root,["operation","get","--domain","material","--request-id",input.requestId]),result);
  assert.equal((await cli(f.root,["file","read",doc.ref])).content,"CLI source update");
 }finally{await f.close();}
});
