import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type FileChange, type FileUpload, type FileOperation } from "@grokbox/client";
import { acquireAdvisoryGate, openMaterialStore, openRuntimeStore } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { fileFixture, FILE_OWNER, FILE_INSTALLATION as I } from "../../../apps/web/test/file-fixture.ts";
const digest=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<A>(run:()=>Promise<A>,ready:(value:A)=>boolean){const end=Date.now()+5000;while(Date.now()<end){const v=await run();if(ready(v))return v;await delay(5);}throw Error("file_boundary_deadline");}
const write=(ref:string,content="current",expectedRevision:string|null=null):FileChange=>({action:"write",requestId:randomUUID(),ref,confirmed:true,expectedRevision,content});
async function cli(f:Awaited<ReturnType<typeof fileFixture>>,args:string[]){
  const entry=process.env.GROKBOX_TEST_CLI_ENTRY;assert.ok(entry);
  const child=spawn("node",[entry,...args],{cwd:f.directory,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_FILE_CREDENTIAL:FILE_OWNER}});
  let out="",err="";child.stdout.on("data",b=>{out+=b;if(out.length>512*1024)child.kill("SIGKILL");});child.stderr.on("data",b=>{err+=b;});
  const timer=setTimeout(()=>child.kill("SIGKILL"),15000);const [code,signal]=await once(child,"close");clearTimeout(timer);assert.equal(signal,null);assert.equal(err,"");assert.ok(!out.includes(FILE_OWNER));
  return {code,value:JSON.parse(out)};
}
test("packed CLI reads/writes, streams binary and restores its own deletion through management only",async()=>{
  const f=await fileFixture();try{
    const input=join(f.directory,"write.json"),r=write(f.ref("text.txt"),"CLI exact text");
    await writeFile(input,JSON.stringify({ref:r.ref,requestId:r.requestId,expectedRevision:null,content:"CLI exact text"}));
    assert.equal((await cli(f,["file","write","--input",`@${input}`,"--confirm"])).code,0);
    assert.equal((await cli(f,["file","stat",r.ref])).value.data.revision,digest("CLI exact text"));
    assert.equal((await cli(f,["operation","get","--domain","file","--request-id",r.requestId])).value.data.state,"succeeded");
    const binary=Buffer.from(Array.from({length:150000},(_,i)=>i%256)),source=join(f.directory,"source.bin"),destination=join(f.directory,"download.bin"),binaryRef=f.ref("binary.bin");
    await writeFile(source,binary);
    assert.equal((await cli(f,["file","upload",binaryRef,"--from",source,"--request-id",randomUUID(),"--expect-revision","absent","--confirm"])).code,0);
    assert.equal((await cli(f,["file","download",binaryRef,"--to",destination])).value.data.verified,true);assert.deepEqual(await readFile(destination),binary);
    const deletion=randomUUID();assert.equal((await cli(f,["file","delete",binaryRef,"--request-id",deletion,"--expect-revision",digest(binary),"--confirm"])).code,0);
    assert.equal((await cli(f,["file","restore",binaryRef,"--request-id",randomUUID(),"--deletion-request-id",deletion,"--confirm"])).code,0);
    assert.deepEqual(await readFile(join(f.files,"binary.bin")),binary);assert.equal(f.state.nativeReads,0);
  }finally{await f.close();}
});
for(const stop of ["client","server"])test(`${stop} disconnection after publication cannot detach settlement or release the owner early`,async()=>{
  let mark!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>mark=r),barrier=new Promise<void>(r=>release=r),abort=new AbortController();
  const f=await fileFixture(undefined,{afterPublish:async()=>{mark();await barrier;}});let closing:Promise<void>|undefined;
  try{
    const r=write(f.ref("settling.txt")),sent=f.client().changeFile(r,abort.signal).catch(e=>e);await entered;
    assert.equal(await readFile(join(f.files,"settling.txt"),"utf8"),"current");
    if(stop==="client"){abort.abort();assert.equal((await sent).code,"operation_unknown");}
    else{let ended=false;closing=f.server.close().then(()=>{ended=true;});await delay(20);assert.equal(ended,false);const competing=await acquireAdvisoryGate(join(f.root,"run/files.owner.gate"));assert.equal(competing,null);}
    release();await sent;await closing;if(stop==="server")await f.restart();
    const operation=(await until(()=>f.client().fileOperation(r.requestId),v=>v.data.state==="succeeded")).data;
    assert.equal(operation.result!.revision,digest("current"));assert.equal(await readFile(join(f.files,"settling.txt"),"utf8"),"current");
    await f.server.close();const database=await readFile(openMaterialStore(f.root).path);await delay(20);assert.deepEqual(await readFile(openMaterialStore(f.root).path),database);
  }finally{release();await closing;await f.close();}
});

test("idle staging is settled by the original descriptor owner, frees capacity and never publishes",async()=>{
  const f=await fileFixture(undefined,{uploadIdleMs:100});try{
    const r:FileChange={action:"upload",requestId:randomUUID(),ref:f.ref("idle.bin"),confirmed:true,expectedRevision:null,size:3,sha256:digest("abc")};
    const u=(await f.client().changeFile(r)).data as FileUpload;assert.equal(u.operation.state,"unknown");
    const ended=(await until(()=>f.client().fileOperation(r.requestId),v=>v.data.state==="cancelled")).data;
    assert.equal(ended.result,null);assert.deepEqual(await readdir(f.files),[]);
    await rejects(f.client().controlFileUpload({requestId:r.requestId,generation:u.generation,action:"commit"}),"file_change_refused");
    assert.equal(((await f.client().changeFile(write(r.ref))).data as FileOperation).state,"succeeded");
    assert.deepEqual((await f.client().fileOperation(r.requestId)).data,ended);
  }finally{await f.close();}
});
test("concurrent read acquisition counts in-flight descriptors and identical requests share one pinned download",async()=>{
  const f=await fileFixture();try{
    await writeFile(join(f.files,"bytes.bin"),Buffer.alloc(100000,17));const ref=f.ref("bytes.bin"),requestId=randomUUID();
    const same=await Promise.all([f.client().openFileDownload({requestId,ref}),f.client().openFileDownload({requestId,ref})]);assert.deepEqual(same[0]!.data,same[1]!.data);await f.client().closeFileDownload(same[0]!.data);
    const results=await Promise.allSettled(Array.from({length:40},()=>f.client().openFileDownload({requestId:randomUUID(),ref})));
    const ok=results.filter(r=>r.status==="fulfilled");assert.equal(ok.length,32);
    for(const result of results)if(result.status==="rejected")assert.equal(result.reason.code,"store_full");
    await Promise.all(ok.map(r=>f.client().closeFileDownload(r.value.data)));assert.equal(await openMaterialStore(f.root).exists(),false);
  }finally{await f.close();}
});
test("a second service cannot become a second file publisher for the same installation",async()=>{
  const f=await fileFixture();let other:Awaited<ReturnType<typeof startManagementServer>>|undefined;try{
    const forbidden=async()=>{throw Error("no-native");};
    other=await startManagementServer({store:openRuntimeStore(f.root,{}),installationId:I,native:{listBots:forbidden,ownershipRead:forbidden},readGrants:async()=>f.state.grants},{hostHealth:{enabled:false}});
    const client=new ManagementClient({baseUrl:other.url,installationId:I,credential:async()=>FILE_OWNER});
    await rejects(client.changeFile(write(f.ref("competitor.txt"))),"source_unavailable");assert.deepEqual(await readdir(f.files),[]);
    assert.equal(((await f.client().changeFile(write(f.ref("owned.txt")))).data as FileOperation).state,"succeeded");
  }finally{await other?.close();await f.close();}
});
test("changing a named root into an indexed text source cannot bypass an unresolved physical write",async()=>{
  let fired=false;const f=await fileFixture(undefined,{afterClaim:async()=>{if(!fired){fired=true;throw Error("lost-claim");}}});try{
    await writeFile(join(f.files,"shared.txt"),"before");const r=write(f.ref("shared.txt"),"not-dispatched",digest("before"));
    await rejects(f.client().changeFile(r),"operation_unknown");
    f.config.daemon!.filesystem!.roots=[];
    f.config.materials={enabled:true,intervalMs:30000,sources:[{id:"indexed",kind:"files",root:f.files,accountScope:"c".repeat(64),writable:true}]};await f.save();await f.restart();
    const found=await until(()=>f.client().materials({kind:"file"}),v=>v.data.items.some(d=>d.path==="shared.txt"));const document=found.data.items.find(d=>d.path==="shared.txt")!;
    await rejects(f.client().changeMaterial({ref:document.ref,requestId:randomUUID(),expectedRevision:document.revision,content:"bypass",confirmed:true}),"operation_unknown");
    assert.equal(await readFile(join(f.files,"shared.txt"),"utf8"),"before");assert.equal((await f.client().fileOperation(r.requestId)).data.state,"unknown");
  }finally{await f.close();}
});
test("deleting the shared safety database cannot turn retained publication history into new permission",async()=>{
  const f=await fileFixture();try{
    const r=write(f.ref("retained.txt"));await f.client().changeFile(r);const store=openMaterialStore(f.root),backup=join(f.directory,"retained-safety.sqlite");
    await rename(store.path,backup);
    await rejects(f.client().changeFile(write(f.ref("new.txt"))),"source_unavailable");
    await assert.rejects(readFile(store.path));assert.equal(await readFile(join(f.files,"retained.txt"),"utf8"),"current");assert.ok((await readFile(backup)).length>0);
  }finally{await f.close();}
});
test("publication that is already in progress cannot be cancelled or transferred to another request",async()=>{
  let mark!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>mark=r),barrier=new Promise<void>(r=>release=r);
  const f=await fileFixture(undefined,{beforePublish:async()=>{mark();await barrier;}});try{
    const r:FileChange={action:"upload",requestId:randomUUID(),ref:f.ref("commit.bin"),confirmed:true,expectedRevision:null,size:0,sha256:digest("")};const u=(await f.client().changeFile(r)).data as FileUpload;
    const committing=f.client().controlFileUpload({requestId:r.requestId,generation:u.generation,action:"commit"});await entered;
    await rejects(f.client().controlFileUpload({requestId:r.requestId,generation:u.generation,action:"cancel"}),"operation_unknown");
    release();assert.equal((await committing).data.state,"succeeded");
    await rejects(f.client().controlFileUpload({requestId:r.requestId,generation:u.generation,action:"cancel"}),"revision_conflict");assert.equal((await readFile(join(f.files,"commit.bin"))).length,0);
  }finally{release();await f.close();}
});
