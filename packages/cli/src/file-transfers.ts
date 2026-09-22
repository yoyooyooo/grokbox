import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, link, lstat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FILE_POLICY, FILE_UUID, FILE_SHA, fileIdentity, ManagementClientError, type ManagementClient, type FileUpload, type FileDownload } from "@grokbox/client";
import type { CliDeps } from "./deps.ts";
const fail=(code:"invalid_input"|"source_changed"|"source_unavailable"|"revision_conflict"|"operation_unknown",message:string):never=>{throw new ManagementClientError(code,message);};
const same=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
/** Caller-local byte IO only. The management service owns all remote publication
 * and recovery. No daemon/Gateway fallback and no automatic request replay. */
export async function uploadManagedFile(client:ManagementClient,deps:CliDeps,installationId:string,ref:string,path:string,requestId:string,expectedRevision:string|null){
  fileIdentity(ref,installationId);if(!FILE_UUID.test(requestId)||expectedRevision!==null&&!FILE_SHA.test(expectedRevision))return fail("invalid_input","Use the original request UUID and reviewed revision, or explicit absent.");
  const source=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>fail("source_unavailable","The explicit local upload source could not be opened."));
  let upload:FileUpload|undefined,commitStarted=false;
  try{
    const before=await source.stat();if(!before.isFile()||before.nlink!==1||before.size>FILE_POLICY.maxBytes)return fail("invalid_input","Upload requires an unaliased regular source within the byte limit.");
    const buffer=Buffer.alloc(FILE_POLICY.chunkBytes),hash=createHash("sha256");let offset=0;
    while(offset<before.size){deps.signal?.throwIfAborted();const read=await source.read(buffer,0,Math.min(buffer.length,before.size-offset),offset);if(!read.bytesRead)return fail("source_changed","Upload source ended while hashing.");hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;}
    if(!same(before,await source.stat()))return fail("source_changed","The local source changed while hashing.");
    const request={action:"upload" as const,requestId,ref,confirmed:true as const,expectedRevision,size:before.size,sha256:hash.digest("hex")};
    const opened=await client.changeFile(request,deps.signal);
    if(!("chunks"in opened.data))return opened;
    upload=opened.data;
    for(let index=0;index<upload.chunks;index++){
      const length=Math.min(buffer.length,before.size-index*buffer.length);let got=0;
      while(got<length){deps.signal?.throwIfAborted();const read=await source.read(buffer,got,length-got,index*buffer.length+got);if(!read.bytesRead)return fail("source_changed","Upload source ended during transfer.");got+=read.bytesRead;}
      await client.uploadFileChunk({requestId,generation:upload.generation,index,contentBase64:buffer.subarray(0,length).toString("base64")},deps.signal);
    }
    if(!same(before,await source.stat()))return fail("source_changed","The local upload source changed; it will not be published.");
    deps.signal?.throwIfAborted();commitStarted=true;
    return await client.controlFileUpload({requestId,generation:upload.generation,action:"commit"},deps.signal);
  }catch(e){
    // Cleanup of this known staging transfer is not a retry of its publication.
    // Once commit is sent, even an unreadable reply can never authorize cancel.
    if(upload&&!commitStarted)await client.controlFileUpload({requestId,generation:upload.generation,action:"cancel"},AbortSignal.timeout(10000)).catch(()=>undefined);
    throw e;
  }finally{await source.close();}
}
export async function downloadManagedFile(client:ManagementClient,deps:CliDeps,installationId:string,ref:string,path:string){
  fileIdentity(ref,installationId);const destination=resolve(path);
  try{await lstat(destination);return fail("revision_conflict","Download never overwrites an existing local destination.");}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const parent=await open(dirname(destination),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),physical=process.platform==="linux"?`/proc/self/fd/${parent.fd}`:dirname(destination);
  const temporary=join(physical,`.${basename(destination)}.grokbox-${deps.randomUUID()}.tmp`),target=join(physical,basename(destination));
  let file:Awaited<ReturnType<typeof open>>|undefined,opened:FileDownload|undefined,linked=false;
  try{
    file=await open(temporary,"wx",0o600);
    const reply=await client.openFileDownload({requestId:deps.randomUUID(),ref},deps.signal);opened=reply.data;
    const hash=createHash("sha256");let received=0;
    for(let index=0;index<opened.chunks;index++){
      deps.signal?.throwIfAborted();const chunk=(await client.downloadFileChunk(opened,index,deps.signal)).data,bytes=Buffer.from(chunk.contentBase64,"base64");
      let written=0;while(written<bytes.length){const part=await file.write(bytes,written,bytes.length-written,received+written);if(!part.bytesWritten)return fail("source_unavailable","The local destination stopped accepting bytes.");written+=part.bytesWritten;}
      hash.update(bytes);received+=bytes.length;
    }
    if(received!==opened.size||hash.digest("hex")!==opened.sha256)return fail("source_changed","Downloaded size or digest differs from the pinned source.");
    await file.sync();deps.signal?.throwIfAborted();
    // The final link is atomic no-clobber. A concurrent destination wins intact.
    await link(temporary,target).catch((e:NodeJS.ErrnoException)=>fail(e.code==="EEXIST"?"revision_conflict":"source_unavailable","The verified download could not publish without overwriting another destination."));linked=true;
    await parent.sync();
    return {...reply,data:{ref,localPath:destination,size:received,sha256:opened.sha256,verified:true as const}};
  }catch(e){if(linked)throw new ManagementClientError("operation_unknown","The verified destination may have published, but local durability was not confirmed. Inspect it before another download.");throw e;}
  finally{await file?.close();await unlink(temporary).catch(()=>undefined);await parent.close();if(opened)await client.closeFileDownload(opened,AbortSignal.timeout(10000)).catch(()=>undefined);}
}
