import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { type Capability } from "@grokbox/client/contract";
import { FILE_POLICY as P, FileError, FILE_UUID, fileData, fileIdentity, fileReference, normalizeFileChange, normalizeFileUploadChunk, normalizeFileUploadControl,
  type FileChange, type FileRootView, type FileRootsView, type FileOperation, type FileEntry, type FileRead, type FileDirectory, type FileUpload, type FileUploadChunk,
  type FileUploadControl, type FileDownload, type FileDownloadChunk } from "@grokbox/runtime-kernel/files";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { MaterialError } from "@grokbox/runtime-kernel/materials";
import { GovernedFilesystem, HostResourceError, openConfigStore, rootConfigLayout, openMaterialStore, acquireAdvisoryGate,
  type HostFilesystemRoot, type FilesystemStat, type FilesystemEntry } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

type Authority = (signal: AbortSignal, capability: Capability) => Promise<void>;
type Root = { config: HostFilesystemRoot; binding: string; key: string; path: string };
type Active = { request: FileChange; initial: FileOperation; principal: Principal; authorize: Authority; root: Root; id: string; phase: "writing" | "staging" | "committing" };
export type FileTestHooks = { beforePublish?: () => Promise<void>; afterPublish?: () => Promise<void>; afterClaim?: () => Promise<void>; uploadIdleMs?: number };
const contains = (root: string, path: string) => { const r = relative(root, path); return r === "" || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const overlaps = (a: string, b: string) => contains(a,b) || contains(b,a);
const fail = (code: ConstructorParameters<typeof FileError>[0], message: string): never => { throw new FileError(code,message); };
const capability = (action: FileChange["action"]): Capability => action === "delete" ? "files.delete" : action === "restore" ? "files.restore" : "files.write";
export const fileOperationKey = (installation: string, principal: string, request: string) => sha256Text(canonicalJson(["file-operation-v1",installation,principal,request]));
function adapterId(key: string) {
  const b = Buffer.from(key,"hex"); b[6]=(b[6]!&15)|64; b[8]=(b[8]!&63)|128;
  const h=b.subarray(0,16).toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
function failure(e: unknown): HttpFailure {
  if(e instanceof HttpFailure)return e;
  if(e instanceof FileError || e instanceof MaterialError)return new HttpFailure(e.code === "invalid_input" ? 400 : e.code === "permission_denied" ? 403 : e.code === "not_found" ? 404 : e.code === "store_full" ? 507 : ["source_unavailable","source_incomplete"].includes(e.code) ? 503 : 409,e.code,e.message);
  if(e instanceof HostResourceError){
    if(e.code === "operation_outcome_unknown")return new HttpFailure(409,"operation_unknown","The original file publication has no verified settlement. Read its retained operation.");
    if(["fs_forbidden","process_forbidden"].includes(e.code))return new HttpFailure(403,"permission_denied","The configured root does not authorize this path or operation.");
    if(e.code === "fs_not_found")return new HttpFailure(404,"not_found","The exact file was not found.");
    if(e.code === "fs_too_large")return new HttpFailure(503,"source_incomplete","This read exceeds its byte or entry bound; use a narrower source or the pinned download.");
    if(["fs_conflict","fs_destination_exists","fs_not_empty"].includes(e.code))return new HttpFailure(409,"revision_conflict","The destination or original file revision changed.");
    if(["fs_path_invalid","fs_upload_invalid","fs_hash_mismatch","fs_transfer_invalid"].includes(e.code))return new HttpFailure(400,"invalid_input","The file reference, transfer or content verification failed.");
  }
  return new HttpFailure(503,"source_unavailable","The file source is unavailable; no alternate root or writer was selected.");
}
async function rootsFor(root: string, installation: string): Promise<Root[]> {
  const document=(await openConfigStore(rootConfigLayout(root)).read()).document;
  const declarations=(document.daemon?.filesystem?.roots ?? []).filter(r=>r.operations.some(op=>op!=="exec")) as HostFilesystemRoot[];
  const protectedRoots=await Promise.all((document.materials?.sources ?? []).map(s=>realpath(s.root)));
  const result:Root[]=[];
  for(const config of declarations){
    const path=await realpath(config.path), info=await lstat(path);
    if(!info.isDirectory() || ["/","/home","/workspace","/tmp"].includes(path) || overlaps(path,resolve(root))
      || protectedRoots.some(p=>overlaps(p,path)) || result.some(p=>overlaps(p.path,path)))return fail("permission_denied","Named roots cannot overlap management storage, each other or native/material sources. Use the original material reference for those documents.");
    const binding=sha256Text(canonicalJson(["file-root-v1",installation,config,path,info.dev,info.ino,protectedRoots]));
    result.push({config:structuredClone(config),path,binding,key:sha256Text(canonicalJson(["file-root-object-v1",installation,info.dev,info.ino]))});
  }
  return result;
}
function revision(row: FilesystemStat): string {
  if(row.kind==="file")return row.sha256 ?? fail("source_incomplete","This file is beyond the complete content verification limit.");
  return sha256Text(canonicalJson([row.kind,row.size,row.mode,row.modifiedAt]));
}
/** Service-owned original filesystem adapter + original material safety store.
 * Transfer descriptors are temporary; their durable publication guards are not. */
export class FileService {
  readonly generation=randomUUID(); private readonly lifetime=new AbortController();
  private readonly active=new Map<string,Active>(); private readonly pending=new Set<Promise<unknown>>();
  private readonly downloads=new Map<string,{value:FileDownload;id:string;expires:number}>();
  private readonly openingDownloads=new Map<string,{ref:string;promise:Promise<FileDownload>}>();
  private filesystem?:GovernedFilesystem; private gate?:Awaited<ReturnType<typeof acquireAdvisoryGate>>;
  private captured:Root[]=[]; private available=false; private closing=false; private closed?:Promise<void>;
  private constructor(readonly root:string,readonly installationId:string,private readonly hooks:FileTestHooks){}
  static async acquire(root:string,installation:string,hooks:FileTestHooks={}){
    const s=new FileService(root,installation,hooks);
    try{
      s.captured=await rootsFor(root,installation);
      if(s.captured.length){
        s.filesystem=await GovernedFilesystem.create(s.captured.map(r=>r.config),Date.now,{
          uploadIdleMs: hooks.uploadIdleMs,
          afterUploadExpiry: async (id,status) => {
            const a=s.active.get(id);
            if (!a || a.phase!=="staging" || status.state!=="not_committed") return;
            a.phase="committing";
            await s.settle(a,"cancelled"); s.active.delete(id);
          },
          beforeMutation:async id=>{
            const a=s.active.get(id); if(!a) return fail("operation_unknown","The original file invocation is no longer owned.");
            await hooks.beforePublish?.();
            try { await s.check(a.request.ref,a.authorize,capability(a.request.action)); await s.expect(a.request); s.lifetime.signal.throwIfAborted(); }
            catch(e) { throw new HostResourceError(e instanceof FileError && e.code === "revision_conflict" ? "fs_conflict" : "fs_forbidden", "The original pre-publication authority or source version is no longer valid."); }
          }, afterMutation:async()=>{await hooks.afterPublish?.();},
        });
        s.gate=await acquireAdvisoryGate(join(root,"run","files.owner.gate"));
      }
      s.available=true;
    }catch{await s.filesystem?.close();s.filesystem=undefined;await s.gate?.release();s.gate=undefined;}
    return s;
  }
  track<A>(run:()=>Promise<A>):Promise<A>{
    if(this.closing)return Promise.reject(new HttpFailure(503,"unavailable","File service is stopping."));
    const task=Promise.resolve().then(run);this.pending.add(task);void task.finally(()=>this.pending.delete(task)).catch(()=>undefined);return task;
  }
  private async current(){
    if(!this.available||this.closing)return fail("source_unavailable","The file service could not acquire its declared roots.");
    const current=await rootsFor(this.root,this.installationId);
    if(canonicalJson(current)!==canonicalJson(this.captured))return fail("source_changed","File roots or their policy changed; a service restart and new references are required.");
    return current;
  }
  async roots():Promise<FileRootsView>{
    try{const roots=await this.current();return {state:roots.length?"ready":"unconfigured",roots:roots.map(r=>({name:r.config.name,ref:fileReference(this.installationId,r.binding,r.config.name),binding:r.binding,operations:r.config.operations.filter(o=>o!=="exec"),externalCompareAndSwap:false} satisfies FileRootView)),coverage:"configured-named-roots"};}
    catch{return {state:"unavailable",roots:[],coverage:"configured-named-roots"};}
  }
  private async check(ref:string,authorize:Authority,cap:Capability){
    const signal=AbortSignal.any([this.lifetime.signal,AbortSignal.timeout(15000)]);signal.throwIfAborted();await authorize(signal,cap);
    const target=fileIdentity(ref,this.installationId),root=(await this.current()).find(r=>r.config.name===target.root);
    if(!root||root.binding!==target.binding)return fail("source_changed","The exact root reference no longer matches its physical source or authorization.");
    if(!this.filesystem)return fail("source_unavailable","No named-root adapter was acquired.");
    return {root,target,fs:this.filesystem,signal};
  }
  private entry(row:FilesystemEntry,root:Root,rev:string|null=null):FileEntry{
    const path=row.path.slice(row.path.indexOf(":/")+2);
    return {ref:fileReference(this.installationId,root.binding,root.config.name,path),name:row.name,kind:row.kind,size:row.size,mode:row.mode,modifiedAt:row.modifiedAt,revision:rev};
  }
  async stat(ref:string,authorize:Authority):Promise<FileEntry>{const {root,target,fs,signal}=await this.check(ref,authorize,"files.read");const row=await fs.stat(target.remotePath,signal);await this.check(ref,authorize,"files.read");return this.entry(row,root,revision(row));}
  async list(ref:string,authorize:Authority,limit=100,cursor?:string):Promise<FileDirectory>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)return fail("invalid_input","Invalid directory page bound.");
    const {root,target,fs}=await this.check(ref,authorize,"files.read"),page=await fs.list(target.remotePath);await this.check(ref,authorize,"files.read");
    const snapshot=sha256Text(canonicalJson([ref,limit,page.entries]));let offset=0;
    if(cursor){const p=cursor.split(":");if(p.length!==2||p[0]!==snapshot||!/^(0|[1-9][0-9]*)$/.test(p[1]!)||!Number.isSafeInteger(Number(p[1])))return fail("source_changed","The directory snapshot changed; start a fresh listing.");offset=Number(p[1]);if(offset>page.entries.length)return fail("invalid_input","The directory cursor is beyond its snapshot.");}
    const entries=page.entries.slice(offset,offset+limit).map(e=>this.entry(e,root)),complete=offset+entries.length>=page.entries.length;
    return {ref:target.ref,entries,complete,snapshot,nextCursor:complete?null:`${snapshot}:${offset+entries.length}`,contentIncluded:false};
  }
  async read(ref:string,authorize:Authority):Promise<FileRead>{
    const {target,fs,signal}=await this.check(ref,authorize,"files.content.read");const data=await fs.read(target.remotePath,signal);
    if(data.size>P.readBytes)return fail("source_incomplete","Use the pinned chunked download for content above the direct-read bound.");
    await this.check(ref,authorize,"files.content.read");return {ref:target.ref,size:data.size,sha256:data.sha256,contentBase64:data.encoding==="base64"?data.content:Buffer.from(data.content,"utf8").toString("base64"),encoding:"base64"};
  }
  private async expect(r:FileChange){
    let row:FilesystemStat|undefined;
    try{row=await this.filesystem!.stat(fileIdentity(r.ref,this.installationId).remotePath,this.lifetime.signal);}catch(e){if(!(e instanceof HostResourceError)||e.code!=="fs_not_found")throw e;}
    if((row?revision(row):null)!==r.expectedRevision)return fail("revision_conflict","The exact source revision or expected absence changed. Preserve the draft.");
    return row;
  }
  async operation(requestId:string,principal:Principal):Promise<FileOperation>{
    if(!FILE_UUID.test(requestId))return fail("invalid_input","Use the original request UUID.");
    const store=openMaterialStore(this.root),key=fileOperationKey(this.installationId,principal.id,requestId);
    const row=await store.exists()?await store.fileOperation(key):null;
    if(!row)return fail("not_found","No original file operation was found for this principal; absence does not prove no external effect.");return row.receipt;
  }
  private async settle(a:Active,state:FileOperation["state"],result:FileOperation["result"]=null){
    return openMaterialStore(this.root).settleFile(fileOperationKey(this.installationId,a.principal.id,a.request.requestId),{...a.initial,state,result,settledAtMs:Date.now()});
  }
  private async result(a:Active):Promise<FileOperation>{
    if(a.request.action==="delete")return this.settle(a,"succeeded",{revision:null,size:null,kind:a.initial.result?.kind ?? "file",recoverable:true});
    const target=fileIdentity(a.request.ref,this.installationId),row=await this.filesystem!.stat(target.remotePath);
    const expected=a.request.action==="write"?{sha256:sha256Text(a.request.content),size:Buffer.byteLength(a.request.content,"utf8")}:a.request.action==="upload"?a.request:null;
    if(expected&&(row.kind!=="file"||row.sha256!==expected.sha256||row.size!==expected.size))return fail("operation_unknown","Readback no longer matches this original file publication.");
    return this.settle(a,"succeeded",{revision:revision(row),size:row.size,kind:row.kind,recoverable:false});
  }
  async change(r:FileChange,principal:Principal,authorize:Authority):Promise<FileOperation|FileUpload>{
    const store=openMaterialStore(this.root),key=fileOperationKey(this.installationId,principal.id,r.requestId),id=adapterId(key),digest=sha256Text(canonicalJson(r));
    const previous=await store.exists()?await store.fileOperation(key):null;
    if(previous){if(previous.digest!==digest)return fail("idempotency_conflict","The file request ID belongs to different input.");return previous.receipt;}
    const {root,target,fs}=await this.check(r.ref,authorize,capability(r.action));
    if(!this.gate)return fail("source_unavailable","This service does not own file publications.");
    const before=await this.expect(r);
    let deletionId:string|undefined;
    if(r.action==="restore"){
      const oldKey=fileOperationKey(this.installationId,principal.id,r.deletionRequestId),old=await store.exists()?await store.fileOperation(oldKey):null;
      if(!old||old.receipt.action!=="delete"||old.receipt.state!=="succeeded"||old.rootKey!==root.key||old.path!==target.path)return fail("permission_denied","Restore requires this principal's settled original deletion for this exact physical root and path.");
      deletionId=adapterId(oldKey);
    }
    await store.initialize();
    const initial:FileOperation={version:1,serviceGeneration:this.generation,requestId:r.requestId,operationRef:`file-operation:${this.installationId}:${key}`,ref:r.ref,action:r.action,expectedRevision:r.expectedRevision,state:"unknown",acceptedAtMs:Date.now(),settledAtMs:null,result:null,externalCompareAndSwap:false,indexAdoption:"not-observed"};
    const claim=await store.reserveFile(key,digest,root.key,initial,join(root.path,target.path));if(!claim.created)return claim.receipt;
    try { await this.hooks.afterClaim?.(); } catch { return fail("operation_unknown", "The original file claim was retained without a verified dispatch."); }
    const a:Active={request:r,initial,principal,authorize,root,id,phase:r.action==="upload"?"staging":"writing"};this.active.set(id,a);
    let published=false;
    try{
      await this.check(r.ref,authorize,capability(r.action));
      if(r.action==="upload"){
        if([...this.active.values()].filter(v=>v.phase==="staging").length>P.maxTransfers)return fail("store_full","The upload descriptor capacity is full.");
        await fs.openUpload(id,target.remotePath,r.size,r.sha256,r.expectedRevision??undefined);
        return {requestId:r.requestId,ref:r.ref,generation:this.generation,chunkBytes:P.chunkBytes,size:r.size,sha256:r.sha256,chunks:Math.ceil(r.size/P.chunkBytes),operation:initial};
      }
      if(r.action==="write")await fs.write(id,target.remotePath,Buffer.from(r.content,"utf8"),r.expectedRevision??undefined);
      else if(r.action==="mkdir")await fs.makeDirectory(id,target.remotePath);
      else if(r.action==="delete")await fs.remove(id,target.remotePath,r.recursive);
      else await fs.restore(id,target.remotePath,deletionId!);
      published=true;
      if(r.action==="delete")return await this.settle(a,"succeeded",{revision:null,size:null,kind:before!.kind,recoverable:true});
      return await this.result(a);
    }catch(e){
      const unknown=published||e instanceof HostResourceError&&e.code==="operation_outcome_unknown"||e instanceof MaterialError&&e.code==="operation_unknown";
      if(unknown)return fail("operation_unknown","The original file effect or its durable settlement is unknown; it cannot be replayed.");
      await this.settle(a,"refused");throw e;
    }finally{if(r.action!=="upload"||this.filesystem!.mutationStatus(id).state!=="pending")this.active.delete(id);}
  }
  private upload(requestId:string,generation:string,principal:Principal){
    if(generation!==this.generation)return fail("operation_unknown","The original transfer owner changed. Query the original operation, not a replacement upload.");
    const id=adapterId(fileOperationKey(this.installationId,principal.id,requestId)),a=this.active.get(id);
    if(!a||a.request.action!=="upload")return fail("operation_unknown","The original upload is not live in this service.");return a;
  }
  async chunk(r:FileUploadChunk,principal:Principal,authorize:Authority){
    const a=this.upload(r.requestId,r.generation,principal);if(a.phase!=="staging")return fail("operation_unknown","The original publication has already started.");
    await this.check(a.request.ref,authorize,"files.write");
    const result=await this.filesystem!.uploadChunk(a.id,r.index,Buffer.from(r.contentBase64,"base64"));
    return {requestId:r.requestId,index:r.index,bytes:result.bytes as number,accepted:true as const};
  }
  async control(r:FileUploadControl,principal:Principal,authorize:Authority):Promise<FileOperation>{
    const previous=await this.operation(r.requestId,principal);if(previous.action!=="upload")return fail("invalid_input","This operation is not an upload.");
    if(r.action==="cancel"&&previous.state==="succeeded")return fail("revision_conflict","The original upload already published. Cancellation cannot undo it.");
    if(previous.state!=="unknown")return previous;
    const a=this.upload(r.requestId,r.generation,principal);if(a.phase!=="staging")return fail("operation_unknown","The original upload publication is in progress or uncertain.");
    await this.check(a.request.ref,authorize,"files.write");
    if(a.phase!=="staging")return fail("operation_unknown","Another control already owns this original upload settlement.");
    a.phase="committing"; a.authorize=authorize;
    try{
      if(r.action==="cancel"){
        await this.filesystem!.cancelUpload(a.id);
        if(this.filesystem!.mutationStatus(a.id).state!=="not_committed")return fail("operation_unknown","No definite uncommitted upload outcome was observed.");
        return await this.settle(a,"cancelled");
      }
      await this.filesystem!.commitUpload(a.id);return await this.result(a);
    }catch(e){
      if(this.filesystem!.mutationStatus(a.id).state==="not_committed"||this.filesystem!.mutationStatus(a.id).state==="conflict"){await this.settle(a,"refused");throw e;}
      return fail("operation_unknown","The original upload completion is unknown. Inspect its retained request without repeating publication.");
    }finally{this.active.delete(a.id);}
  }
  async openDownload(requestId:string,ref:string,principal:Principal,authorize:Authority):Promise<FileDownload>{
    const key=fileOperationKey(this.installationId,principal.id,requestId);
    for(const [id,d] of this.downloads)if(d.expires<Date.now()){await this.filesystem?.cancelDownload(d.id);this.downloads.delete(id);}
    const prior=this.downloads.get(key),pending=this.openingDownloads.get(key);
    if(prior||pending){
      if((prior?.value.ref??pending!.ref)!==ref)return fail("idempotency_conflict","The transfer ID was used for a different file.");
      const value=prior?.value??await pending!.promise;await this.check(ref,authorize,"files.content.read");return value;
    }
    // Reserve before awaiting filesystem/authority: simultaneous read requests
    // cannot exceed the descriptor budget or open two handles for one identity.
    if(this.downloads.size+this.openingDownloads.size>=P.maxTransfers)return fail("store_full","The bounded download capacity is full.");
    const promise=Promise.resolve().then(async()=>{
      const {target,fs,signal}=await this.check(ref,authorize,"files.content.read"),id=adapterId(key),opened=await fs.openDownload(target.remotePath,id,signal);
      try{await this.check(ref,authorize,"files.content.read");const value:FileDownload={requestId,ref,generation:this.generation,size:opened.size,sha256:opened.sha256,chunkBytes:P.chunkBytes,chunks:opened.chunks};this.downloads.set(key,{value,id,expires:Date.now()+P.transferIdleMs});return value;}
      catch(e){await fs.cancelDownload(id);throw e;}
    }).finally(()=>this.openingDownloads.delete(key));
    this.openingDownloads.set(key,{ref,promise});return promise;
  }
  async downloadChunk(requestId:string,generation:string,index:number,principal:Principal,authorize:Authority):Promise<FileDownloadChunk>{
    const d=this.downloads.get(fileOperationKey(this.installationId,principal.id,requestId));
    if(!d||generation!==this.generation)return fail("not_found","No pinned transfer is owned by this principal and service.");
    await this.check(d.value.ref,authorize,"files.content.read");const chunk=await this.filesystem!.downloadChunk(d.id,index);await this.check(d.value.ref,authorize,"files.content.read");d.expires=Date.now()+P.transferIdleMs;
    return {requestId,index:chunk.index,bytes:chunk.bytes,contentBase64:chunk.contentBase64,done:chunk.done};
  }
  async closeDownload(requestId:string,generation:string,principal:Principal){
    const key=fileOperationKey(this.installationId,principal.id,requestId),d=this.downloads.get(key);
    if(generation!==this.generation)return fail("source_changed","The original download service generation changed.");
    await this.filesystem?.cancelDownload(d?.id??adapterId(key));
    const pending=this.openingDownloads.get(key);if(pending)await pending.promise.catch(()=>undefined);
    const current=this.downloads.get(key);if(current)await this.filesystem!.cancelDownload(current.id);
    this.downloads.delete(key);return {requestId,closed:true as const};
  }
  close(){return this.closed??=(async()=>{
    this.closing=true;this.lifetime.abort();await Promise.allSettled([...this.pending]);
    try{for(const a of this.active.values())if(a.phase==="staging"){
      a.phase="committing";
      await this.filesystem!.cancelUpload(a.id);if(this.filesystem!.mutationStatus(a.id).state==="not_committed")await this.settle(a,"cancelled");
    }}finally{await this.filesystem?.close();this.active.clear();this.downloads.clear();await this.gate?.release();}
  })();}
}
export type FileDomain={service:FileService;authorize:Authority};
const io=<A>(run:()=>Promise<A>)=>Effect.tryPromise({try:run,catch:failure});
/** Service Scope owns byte transfers and publications; HTTP connections do not. */
export function fileApplication(d:FileDomain,p:Principal,method:string,url:URL,input?:unknown){
  return Effect.gen(function*(){
    const path=url.pathname,cap:Capability=path.startsWith("/v1/file-operations/")?"operations.read":path.includes("download")||path.includes("content")?"files.content.read":method==="POST"?"files.write":"files.read";
    // Delete/restore require their own rights, not an implicit general write grant.
    const change=method==="POST"&&path==="/v1/file-changes"?yield* Effect.try({try:()=>normalizeFileChange(input,d.service.installationId),catch:failure}):undefined;
    yield* Effect.try({try:()=>{
      requireCapability(p,change?capability(change.action):cap);
      const keys=path.startsWith("/v1/file-download-chunks/")?["generation","index"]:path.startsWith("/v1/file-directories/")?["limit","cursor"]:[];
      for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new HttpFailure(400,"invalid_input","Unsupported file query.");
      if(url.searchParams.has("limit")&&!/^[1-9][0-9]{0,2}$/.test(url.searchParams.get("limit")!))throw new HttpFailure(400,"invalid_input","Invalid directory limit.");
    },catch:failure});
    const run=<A>(f:()=>Promise<A>)=>io(()=>d.service.track(f));
    if(method==="GET"&&path==="/v1/file-roots")return yield* run(()=>d.service.roots());
    const exact=/^\/v1\/file-(stat|directories|content|operations)\/([^/]+)$/.exec(path);
    if(method==="GET"&&exact)return yield* run<FileEntry|FileDirectory|FileRead|FileOperation>(()=>{
      const ref=decodeURIComponent(exact[2]!);return exact[1]==="operations"?d.service.operation(ref,p):exact[1]==="stat"?d.service.stat(ref,d.authorize):exact[1]==="directories"?d.service.list(ref,d.authorize,url.searchParams.has("limit")?Number(url.searchParams.get("limit")):100,url.searchParams.get("cursor")??undefined):d.service.read(ref,d.authorize);
    });
    if(change)return yield* Effect.uninterruptible(run(()=>d.service.change(change,p,d.authorize)));
    if(method==="POST"&&path==="/v1/file-upload-chunks")return yield* run(()=>d.service.chunk(normalizeFileUploadChunk(input),p,d.authorize));
    if(method==="POST"&&path==="/v1/file-upload-controls")return yield* Effect.uninterruptible(run(()=>d.service.control(normalizeFileUploadControl(input),p,d.authorize)));
    if(method==="POST"&&path==="/v1/file-downloads")return yield* run(()=>{
      const r=fileData(input,["requestId","ref"]);if(typeof r.requestId!=="string"||!FILE_UUID.test(r.requestId))return fail("invalid_input","Invalid transfer identity.");
      return d.service.openDownload(r.requestId.toLowerCase(),fileIdentity(r.ref,d.service.installationId).ref,p,d.authorize);
    });
    if(method==="POST"&&path==="/v1/file-download-controls")return yield* run(()=>{
      const r=fileData(input,["requestId","generation"]);if(typeof r.requestId!=="string"||!FILE_UUID.test(r.requestId)||typeof r.generation!=="string"||!FILE_UUID.test(r.generation))return fail("invalid_input","Invalid transfer identity.");
      return d.service.closeDownload(r.requestId.toLowerCase(),r.generation,p);
    });
    const chunk=/^\/v1\/file-download-chunks\/([a-f0-9-]{36})$/.exec(path);
    if(method==="GET"&&chunk)return yield* run(()=>{
      const generation=url.searchParams.get("generation")??"",index=url.searchParams.get("index")??"";
      if(!FILE_UUID.test(chunk[1]!)||!FILE_UUID.test(generation)||!/^(0|[1-9][0-9]{0,4})$/.test(index)||[...url.searchParams.keys()].some(k=>!["generation","index"].includes(k)||url.searchParams.getAll(k).length!==1))return fail("invalid_input","Invalid pinned download cursor.");
      return d.service.downloadChunk(chunk[1]!,generation,Number(index),p,d.authorize);
    });
    return yield* Effect.fail(new HttpFailure(404,"not_found","Unsupported file endpoint."));
  });
}
