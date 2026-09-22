import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GovernedFilesystem, FS_TRANSFER_CHUNK_BYTES, FS_READ_MAX_BYTES } from "@grokbox/box-runtime/runtime";
import { ManagementClient, fileReference, FILE_POLICY, type FileDownload } from "@grokbox/client";
import { downloadManagedFile, uploadManagedFile } from "../packages/cli/src/file-transfers.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";
import { DAEMON_METHODS } from "../packages/cli/src/daemon/protocol.ts";

const I = "11111111-1111-4111-8111-111111111111", binding = "a".repeat(64), ref = fileReference(I, binding, "files", "data.bin");
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const barrier = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "file-read-adapter-")), root = join(base, "root"), outside = join(base, "outside");
  await mkdir(root); await mkdir(outside);
  const fs = await GovernedFilesystem.create([{ name: "files", path: root, operations: ["stat", "list", "read", "download"] }], Date.now);
  return { root, outside, base, fs, close: async () => { await fs.close(); await rm(base, { recursive: true, force: true }); } };
}
test("file commands replace fs and no remaining daemon method exposes the retired file writer", () => {
  expect(LEAF_COMMANDS.some(c => c.path[0] === "fs")).toBe(false);
  for (const action of ["stat", "list", "read", "write", "mkdir", "upload", "download", "delete", "restore"]) expect(LEAF_COMMANDS.some(c => c.path.join(" ") === `file ${action}`)).toBe(true);
  expect(DAEMON_METHODS.some(m => m.startsWith("fs"))).toBe(false);
});
test("named-root reads reject traversal, hidden credential paths, invalid types and byte overflow", async () => {
  const f = await fixture(); try {
    await mkdir(join(f.root, "docs")); await writeFile(join(f.root, "text.txt"), "hello 世界"); await writeFile(join(f.root, "binary.bin"), Buffer.from([0,255,1]));
    expect((await f.fs.stat("files:/text.txt")).sha256).toBe(digest("hello 世界"));
    expect((await f.fs.read("files:/text.txt")).content).toBe("hello 世界");
    expect((await f.fs.read("files:/binary.bin")).encoding).toBe("base64");
    for (const path of ["files:/../outside", "files:/.ssh/key", "files:/.env", "files:/agent-data/private", "missing:/x", `files:/${"a".repeat(256)}`]) await expect(f.fs.read(path)).rejects.toBeDefined();
    await expect(f.fs.read("files:/docs")).rejects.toMatchObject({ code: "fs_not_file" });
    await expect(f.fs.list("files:/text.txt")).rejects.toMatchObject({ code: "fs_not_directory" });
    await writeFile(join(f.root, "large.bin"), Buffer.alloc(FS_READ_MAX_BYTES + 1));
    await expect(f.fs.read("files:/large.bin")).rejects.toMatchObject({ code: "fs_too_large" });
  } finally { await f.close(); }
});
test("download retains the authorized descriptor when its pathname is replaced with an outside symlink", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root,"race.txt"),"authorized bytes"); await writeFile(join(f.outside,"private.txt"),"outside bytes");
    const d = await f.fs.openDownload("files:/race.txt",randomUUID());
    await rename(join(f.root,"race.txt"),join(f.root,"original.txt")); await symlink(join(f.outside,"private.txt"),join(f.root,"race.txt"));
    expect(Buffer.from((await f.fs.downloadChunk(d.transferId,0)).contentBase64,"base64").toString()).toBe("authorized bytes");
    expect((await f.fs.cancelDownload(d.transferId)).cancelled).toBe(true);
  } finally { await f.close(); }
});
test("pending and reordered cancellation never publishes a cancelled download", async () => {
  const f = await fixture(); try {
    await writeFile(join(f.root,"pending.bin"),Buffer.alloc(FS_TRANSFER_CHUNK_BYTES,7));
    const id=randomUUID(),pending=f.fs.openDownload("files:/pending.bin",id).catch(e=>e);
    expect((await f.fs.cancelDownload(id)).cancelled).toBe(true); expect((await pending).code).toBe("fs_transfer_invalid");
    const early=randomUUID(); await f.fs.cancelDownload(early);
    await expect(f.fs.openDownload("files:/pending.bin",early)).rejects.toMatchObject({code:"fs_transfer_invalid"});
    const absent=randomUUID(); await expect(f.fs.openDownload("files:/missing",absent)).rejects.toMatchObject({code:"fs_not_found"});
    await writeFile(join(f.root,"missing"),"now present"); await f.fs.openDownload("files:/missing",absent); await f.fs.cancelDownload(absent);
  } finally { await f.close(); }
});
for(const closing of [false,true]) test(`pending hash ${closing?"service close":"cancellation"} rejects without leaving a usable transfer`,async()=>{
  const f=await fixture(),entered=barrier(),release=barrier();await writeFile(join(f.root,"hash.bin"),"hash me");
  const probe=await open(join(f.root,"hash.bin"),"r"),prototype=Object.getPrototypeOf(probe),original=prototype.read;await probe.close();
  prototype.read=async function(...args:unknown[]){entered.release();await release.promise;return original.apply(this,args);};
  try{
    const id=randomUUID(),pending=f.fs.openDownload("files:/hash.bin",id); await entered.promise;
    const stopped=closing?f.fs.close():f.fs.cancelDownload(id); release.release();
    await expect(pending).rejects.toMatchObject({code:"fs_transfer_invalid"}); await stopped;
    await expect(f.fs.downloadChunk(id,0)).rejects.toMatchObject({code:"fs_transfer_invalid"});
  }finally{release.release();prototype.read=original;await f.close();}
});

function transport(bytes:Buffer,change?: (path:string,index:number)=>Promise<void>|void,wrongDigest=false) {
  const generation=randomUUID();let d:FileDownload|undefined;const calls:string[]=[];
  const fetcher=Object.assign(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);calls.push(url.pathname);
    let data:unknown;
    if(url.pathname==="/v1/file-downloads"){
      const r=JSON.parse(String(init?.body));d={...r,generation,size:bytes.length,sha256:wrongDigest?"0".repeat(64):digest(bytes),chunkBytes:32768,chunks:Math.ceil(bytes.length/32768)};data=d;
    }else if(url.pathname.startsWith("/v1/file-download-chunks/")){
      const index=Number(url.searchParams.get("index")),content=bytes.subarray(index*32768,(index+1)*32768);await change?.(url.pathname,index);
      data={requestId:d!.requestId,index,bytes:content.length,contentBase64:content.toString("base64"),done:index===d!.chunks-1};
    }else if(url.pathname==="/v1/file-download-controls")data={requestId:d!.requestId,closed:true};else throw Error("unexpected-file-route");
    return Response.json({schemaVersion:1,installationId:I,invocationId:randomUUID(),ok:true,data});
  },{preconnect:()=>undefined}) as typeof fetch;
  return {client:new ManagementClient({baseUrl:"http://127.0.0.1:3333",installationId:I,fetch:fetcher}),calls};
}
for(const mode of ["verified","hash-mismatch","destination-race","cancel"] as const) test(`caller-local download ${mode}: bounded bytes, no clobber and cleanup`,async()=>{
  const f=await fixture(),destination=join(f.outside,"result.bin"),abort=new AbortController(),bytes=Buffer.alloc(70000,39);
  const t=transport(bytes,async(_p,index)=>{if(index===0&&mode==="destination-race")await writeFile(destination,"competing");if(mode==="cancel")abort.abort();},mode==="hash-mismatch");
  try{
    const deps={...createProductionDeps(),signal:abort.signal};
    const task=downloadManagedFile(t.client,deps,I,ref,destination);
    if(mode==="verified"){expect((await task).data.verified).toBe(true);expect(await readFile(destination)).toEqual(bytes);}
    else {await expect(task).rejects.toBeDefined();if(mode==="destination-race")expect(await readFile(destination,"utf8")).toBe("competing");else expect(await readdir(f.outside)).toEqual([]);}
    expect(t.calls.at(-1)).toBe("/v1/file-download-controls");expect((await readdir(f.outside)).filter(s=>s.endsWith(".tmp"))).toEqual([]);
  }finally{await f.close();}
});
test("local upload supports short positional reads and validates its source before committing",async()=>{
  const f=await fixture(),source=join(f.outside,"source.bin"),bytes=Buffer.alloc(80000,6);await writeFile(source,bytes);
  const probe=await open(source,"r"),prototype=Object.getPrototypeOf(probe),original=prototype.read;await probe.close();
  prototype.read=async function(buffer:Buffer,offset:number,length:number,position:number){return original.call(this,buffer,offset,Math.min(length,701),position);};
  const chunks:Buffer[]=[];let request:any;const generation=randomUUID(),id=randomUUID();
  const client={changeFile:async(r:any)=>{request=r;return {data:{requestId:id,ref,generation,chunkBytes:FILE_POLICY.chunkBytes,size:r.size,sha256:r.sha256,chunks:Math.ceil(r.size/FILE_POLICY.chunkBytes)}};},
    uploadFileChunk:async(r:any)=>{chunks.push(Buffer.from(r.contentBase64,"base64"));},controlFileUpload:async(r:any)=>{expect(r.action).toBe("commit");return {data:{state:"succeeded"}};}} as unknown as ManagementClient;
  try{await uploadManagedFile(client,createProductionDeps(),I,ref,source,id,null);expect(request.sha256).toBe(digest(bytes));expect(Buffer.concat(chunks)).toEqual(bytes);}
  finally{prototype.read=original;await f.close();}
});
