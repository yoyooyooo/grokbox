import "./file-boundaries.node.ts";
import "./file-crash-recovery.node.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, rename, link, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ManagementClient, type FileChange, type FileUpload, type FileOperation } from "@grokbox/client";
import { openMaterialStore } from "@grokbox/box-runtime/runtime";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { fileFixture, FILE_INSTALLATION as I, FILE_OWNER, FILE_READER, FILE_OTHER } from "../../../apps/web/test/file-fixture.ts";
const digest=(b:Uint8Array|string)=>createHash("sha256").update(b).digest("hex");
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
const write=(ref:string,expectedRevision:string|null=null,content="current"):FileChange=>({ref,expectedRevision,content,action:"write",requestId:randomUUID(),confirmed:true});
async function upload(f:Awaited<ReturnType<typeof fileFixture>>,path:string,bytes:Buffer){
  const r:FileChange={ref:f.ref(path),action:"upload",requestId:randomUUID(),confirmed:true,expectedRevision:null,size:bytes.length,sha256:digest(bytes)};
  const u=(await f.client().changeFile(r)).data;assert.ok("chunks"in u);
  for(let n=0;n<u.chunks;n++)await f.client().uploadFileChunk({requestId:u.requestId,generation:u.generation,index:n,contentBase64:bytes.subarray(n*u.chunkBytes,(n+1)*u.chunkBytes).toString("base64")});
  const result=(await f.client().controlFileUpload({requestId:u.requestId,generation:u.generation,action:"commit"})).data;
  assert.equal(result.state,"succeeded");return {r,u,result};
}
test("named roots, directories and strict direct content use the management service without native reads",async()=>{
  const f=await fileFixture();try{
    await writeFile(join(f.files,"text.txt"),"hello 世界");await writeFile(join(f.files,"binary.bin"),Buffer.from([0,255,1]));
    const roots=(await f.client().fileRoots()).data;assert.equal(roots.roots[0]!.ref,f.ref());assert.ok(!JSON.stringify(roots).includes(f.files));
    const page=(await f.client().fileDirectory(f.ref())).data;assert.deepEqual(page.entries.map(e=>e.name),["binary.bin","text.txt"]);
    const text=(await f.client().readFile(f.ref("text.txt"))).data;assert.equal(Buffer.from(text.contentBase64,"base64").toString(),"hello 世界");
    assert.equal((await f.client().fileStat(f.ref("text.txt"))).data.revision,text.sha256);
    assert.deepEqual(Buffer.from((await f.client().readFile(f.ref("binary.bin"))).data.contentBase64,"base64"),Buffer.from([0,255,1]));
    assert.equal(f.state.nativeReads,0);assert.equal(await openMaterialStore(f.root).exists(),false);
  }finally{await f.close();}
});
test("source writes keep immutable original receipt across duplicates, config loss and service restart",async()=>{
  const f=await fileFixture();try{
    const r=write(f.ref("note.md")),result=(await f.client().changeFile(r)).data;assert.equal((result as FileOperation).state,"succeeded");
    assert.equal(await readFile(join(f.files,"note.md"),"utf8"),"current");assert.deepEqual((await f.client().changeFile(r)).data,result);
    await rejects(f.client().changeFile({...r,content:"different"} as FileChange),"idempotency_conflict");
    const revised=(await f.client().fileStat(r.ref)).data.revision!;
    await f.client().changeFile(write(r.ref,revised,"later user edit"));await f.restart();
    await writeFile(join(f.root,"config.json"),"{broken");
    assert.deepEqual((await f.client().fileOperation(r.requestId)).data,result);assert.deepEqual((await f.client().changeFile(r)).data,result);
    assert.equal(await readFile(join(f.files,"note.md"),"utf8"),"later user edit");await rejects(f.client(FILE_OTHER).fileOperation(r.requestId),"not_found");
  }finally{await f.close();}
});
test("zero and multi-chunk binary uploads and pinned downloads verify exact bytes with bounded transport",async()=>{
  const f=await fileFixture();try{
    for(const bytes of [Buffer.alloc(0),Buffer.from(Array.from({length:180000},(_,i)=>i%256))]){
      const path=`binary-${bytes.length}.bin`,{r}=await upload(f,path,bytes);assert.deepEqual(await readFile(join(f.files,path)),bytes);
      const d=(await f.client().openFileDownload({requestId:randomUUID(),ref:r.ref})).data;assert.equal(d.sha256,digest(bytes));assert.equal(d.chunkBytes,32768);
      const chunks:Buffer[]=[];for(let i=0;i<d.chunks;i++)chunks.push(Buffer.from((await f.client().downloadFileChunk(d,i)).data.contentBase64,"base64"));
      assert.deepEqual(Buffer.concat(chunks),bytes);await f.client().closeFileDownload(d);
    }
    assert.equal(f.state.nativeReads,0);
  }finally{await f.close();}
});
test("upload chunks accept only identical repeated content, cancellation remains original and publishes no destination",async()=>{
  const f=await fileFixture();try{
    const bytes=Buffer.alloc(50000,13),r:FileChange={action:"upload",ref:f.ref("cancel.bin"),requestId:randomUUID(),confirmed:true,expectedRevision:null,size:bytes.length,sha256:digest(bytes)};
    const u=(await f.client().changeFile(r)).data as FileUpload,c={requestId:u.requestId,generation:u.generation,index:0,contentBase64:bytes.subarray(0,u.chunkBytes).toString("base64")};
    await f.client().uploadFileChunk(c);await f.client().uploadFileChunk(c);
    await rejects(f.client().uploadFileChunk({...c,contentBase64:Buffer.alloc(u.chunkBytes,2).toString("base64")}),"invalid_input");
    await rejects(f.client().changeFile(write(r.ref)),"operation_unknown");
    const cancelled=(await f.client().controlFileUpload({requestId:u.requestId,generation:u.generation,action:"cancel"})).data;
    assert.equal(cancelled.state,"cancelled");assert.ok(!(await readdir(f.files)).includes("cancel.bin"));
    await rejects(f.client().changeFile(r),"file_change_refused");assert.deepEqual((await f.client().fileOperation(r.requestId)).data,cancelled);
  }finally{await f.close();}
});
test("delete and original restore preserve data, refuse clobber and do not accept a different principal's deletion",async()=>{
  const f=await fileFixture();try{
    for(const kind of ["file","directory"]){
      const path=kind==="file"?"restore.txt":"folder";
      if(kind==="file")await writeFile(join(f.files,path),"retained");else{await mkdir(join(f.files,path));await writeFile(join(f.files,path,"inside.txt"),"retained tree");}
      const before=(await f.client().fileStat(f.ref(path))).data;
      const r:FileChange={action:"delete",ref:f.ref(path),requestId:randomUUID(),confirmed:true,expectedRevision:before.revision!,recursive:kind==="directory"};
      const removed=(await f.client().changeFile(r)).data as FileOperation;assert.equal(removed.state,"succeeded");assert.equal(removed.result!.kind,kind);assert.ok(removed.result!.recoverable);
      const restore:FileChange={action:"restore",ref:r.ref,requestId:randomUUID(),confirmed:true,expectedRevision:null,deletionRequestId:r.requestId};
      await rejects(f.client(FILE_OTHER).changeFile(restore),"permission_denied");
      const restored=(await f.client().changeFile(restore)).data as FileOperation;assert.equal(restored.state,"succeeded");
      assert.equal(await readFile(join(f.files,path,...(kind==="directory"?["inside.txt"]:[])),"utf8"),kind==="file"?"retained":"retained tree");
      await rejects(f.client().changeFile({...restore,requestId:randomUUID()}),"revision_conflict");
      assert.deepEqual((await f.client().changeFile(r)).data,removed);
    }
  }finally{await f.close();}
});
test("root replacement, traversal, symlink and hardlink aliases never grant access through a stale reference",async()=>{
  const f=await fileFixture();try{
    await writeFile(join(f.files,"original.txt"),"safe");await symlink("original.txt",join(f.files,"alias.txt"));await link(join(f.files,"original.txt"),join(f.files,"hard.txt"));
    await rejects(f.client().readFile(f.ref("alias.txt")),"permission_denied");await rejects(f.client().readFile(f.ref("hard.txt")),"permission_denied");
    await rejects(f.client().readFile(f.ref(".ssh/key")),"permission_denied");
    await rename(f.files,`${f.files}-old`);await mkdir(f.files);await writeFile(join(f.files,"private.txt"),"replacement");
    await rejects(f.client().readFile(f.ref("private.txt")),"source_changed");await rejects(f.client().changeFile(write(f.ref("private.txt"))),"source_changed");
  }finally{await f.close();}
});
test("read, content, change, delete, restore and operation history have independent grants",async()=>{
  const f=await fileFixture();try{
    await writeFile(join(f.files,"x"),"x");assert.equal((await f.client(FILE_READER).fileDirectory(f.ref())).data.entries.length,1);
    await rejects(f.client(FILE_READER).readFile(f.ref("x")),"permission_denied");await rejects(f.client(FILE_READER).changeFile(write(f.ref("new"))),"permission_denied");
    f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="files.delete");
    await rejects(f.client().changeFile({action:"delete",ref:f.ref("x"),requestId:randomUUID(),confirmed:true,expectedRevision:digest("x"),recursive:false}),"permission_denied");
    assert.equal(await readFile(join(f.files,"x"),"utf8"),"x");
  }finally{await f.close();}
});
test("publication acknowledgement loss keeps unknown and protects the physical target even under a new request",async()=>{
  let fired=false;const f=await fileFixture(undefined,{afterPublish:async()=>{if(!fired){fired=true;throw Error("lost-publication-ack");}}});try{
    const r=write(f.ref("once.txt"));await rejects(f.client().changeFile(r),"operation_unknown");assert.equal(await readFile(join(f.files,"once.txt"),"utf8"),"current");
    assert.equal((await f.client().fileOperation(r.requestId)).data.state,"unknown");await rejects(f.client().changeFile(r),"operation_unknown");
    await rejects(f.client().changeFile(write(r.ref,digest("current"),"replacement")),"operation_unknown");await f.restart();
    assert.equal((await f.client().fileOperation(r.requestId)).data.state,"unknown");assert.equal(await readFile(join(f.files,"once.txt"),"utf8"),"current");
  }finally{await f.close();}
});
test("last-moment revoked authority prevents publication after its durable claim",async()=>{
  const hooks:{beforePublish?:()=>Promise<void>}={};const f=await fileFixture(undefined,hooks);try{
    const r=write(f.ref("revoked.txt"));hooks.beforePublish=async()=>{f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="files.write");};
    await rejects(f.client().changeFile(r),"permission_denied");assert.equal((await f.client().fileOperation(r.requestId)).data.state,"refused");assert.ok(!(await readdir(f.files)).includes("revoked.txt"));
  }finally{await f.close();}
});
test("named roots cannot bypass a configured native material source's read-only boundary",async()=>{
  const f=await fileFixture();try{
    f.config.materials={enabled:false,intervalMs:30000,sources:[{id:"native",kind:"native-memory",root:f.files,accountScope:"c".repeat(64),agentIds:[I],projects:[]}]};await f.save();await f.restart();
    assert.equal((await f.client().fileRoots()).data.state,"unavailable");await rejects(f.client().changeFile(write(f.ref("memory.txt"))),"source_unavailable");
    assert.ok(!(await readdir(f.files)).includes("memory.txt"));
  }finally{await f.close();}
});
test("old or missing shared material safety store is never rebuilt into fresh file-write authority",async()=>{
  const f=await fileFixture();try{
    await f.client().changeFile(write(f.ref("guard.txt")));const store=openMaterialStore(f.root),db=await openMonitorSqlite(store.path,"write");
    try{await db.run("PRAGMA user_version=1");}finally{await db.close();}
    const before=await readFile(store.path);await rejects(f.client().changeFile(write(f.ref("other.txt"))),"source_unavailable");assert.deepEqual(await readFile(store.path),before);
  }finally{await f.close();}
});
