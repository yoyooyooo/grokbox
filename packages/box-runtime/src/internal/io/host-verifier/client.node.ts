import { Effect,Layer } from "effect";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open,readFile,lstat,mkdtemp,rm,writeFile,unlink,type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { HostVerifier,type StaticJob } from "../../ops/host-health/verifier.port.ts";
import type { StaticAnalysis } from "@grokbox/runtime-kernel/host-health";
import { SCHEMA_DIGEST,type Job,type Hello,type Report } from "./generated/protocol.ts";
import { VerifierFailure,VerifierFrames,encodeFrame,wireShape } from "./stdio.node.ts";
declare const __GROKBOX_VERIFIER_BUILD_ID__:string;
declare const __GROKBOX_VERIFIER_BINARY_SHA256__:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const sha=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const TARGET="x86_64-unknown-linux-gnu";
const failure=(code:string)=>new VerifierFailure(code);
type Binary = {path:string;buildId:string;digest:string;bytes:number;parser:string;checks:Hello["checks"]};
/** npm can preserve group write bits inside a private installation prefix.
 * Accept those bits only behind an owned private ancestor; a public group/world
 * writable executable or manifest still refuses. Bytes are independently pinned. */
async function protectedMode(path:string,mode:number):Promise<boolean>{
  if((mode&0o022)===0)return true;
  let current=dirname(path);
  for(let n=0;n<64;n++){
    const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink())return false;
    if(s.uid===process.getuid?.()&&(s.mode&0o077)===0)return true;
    const parent=dirname(current);if(parent===current)return false;current=parent;
  }return false;
}
/** No runtime cargo, downloaded tool, environment executable or parser fallback. */
async function binary(directory?:string):Promise<Binary>{
  if(process.platform!=="linux"||process.arch!=="x64")throw failure("unsupported-target");
  const folder=directory??join(dirname(fileURLToPath(import.meta.url)),"native",TARGET);
  const manifestFile=join(folder,"verifier-manifest.json"),path=join(folder,"grokbox-host-verifier");
  const mf=await lstat(manifestFile);if(!mf.isFile()||mf.isSymbolicLink()||mf.nlink!==1||mf.size>65536||!await protectedMode(manifestFile,mf.mode))throw failure("manifest-invalid");
  const manifest=JSON.parse(await readFile(manifestFile,"utf8"));
  const hello=Object.fromEntries(["protocol","schema_digest","build_id","parser","checks"].map(k=>[k,manifest[k]]));
  if(!wireShape("Hello",hello)||manifest.schema_digest!==SCHEMA_DIGEST||!sha(manifest.build_id)||!sha(manifest.binary_sha256)||manifest.target!==TARGET||manifest.rustc!=="1.85.0")throw failure("manifest-invalid");
  const expected=typeof __GROKBOX_VERIFIER_BUILD_ID__==="string"?__GROKBOX_VERIFIER_BUILD_ID__:undefined;
  const expectedBinary=typeof __GROKBOX_VERIFIER_BINARY_SHA256__==="string"?__GROKBOX_VERIFIER_BINARY_SHA256__:undefined;
  if(!directory&&(!expected||expected!==manifest.build_id||!expectedBinary||expectedBinary!==manifest.binary_sha256))throw failure("build-mismatch");
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await file.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o111)===0||!await protectedMode(path,s.mode)||s.size!==manifest.binary_bytes||s.size>32*1024*1024||hash(await file.readFile())!==manifest.binary_sha256)throw failure("binary-mismatch");}
  finally{await file.close();}
  return {path,buildId:manifest.build_id,digest:manifest.binary_sha256,bytes:manifest.binary_bytes,parser:manifest.parser,checks:manifest.checks};
}
function matchingReport(value:unknown,job:Job,b:Binary):Report {
  if(!wireShape("Report",value))throw failure("invalid-report");const r=value as Report;
  if(r.job_id!==job.job_id||r.attempt_id!==job.attempt_id||r.build_id!==b.buildId||r.schema_digest!==SCHEMA_DIGEST||r.syntax.length!==job.artifacts.length||r.findings.length!==job.checks.length)throw failure("report-identity");
  for(let i=0;i<job.artifacts.length;i++){
    const a=job.artifacts[i]!,v=r.syntax[i]!;
    if(v.role!==a.role||v.sha256!==a.sha256||v.bytes!==a.bytes||v.state==="valid"&&v.diagnostics!==0)throw failure("report-artifacts");
  }
  const candidate=job.artifacts.find(a=>a.role==="candidate");
  for(let i=0;i<job.checks.length;i++){
    const c=job.checks[i]!,f=r.findings[i]!;
    if(f.id!==c.id||f.revision!==c.revision||f.start>f.end||f.end>(candidate?.bytes??0)||!/^[a-z][a-z0-9-]{0,79}$/.test(f.code)||f.state==="passed"&&(!candidate||r.syntax.find(a=>a.role==="candidate")?.state!=="valid"))throw failure("report-checks");
  }return r;
}
/** Source snapshots are private, unlinked, read-only file descriptions. The
 * child checks bytes itself; neither an fd nor a pathname claims immutability. */
async function run(jobInput:StaticJob,signal:AbortSignal,options:{directory?:string;timeoutMs?:number;onSpawn?:(pid:number)=>void}):Promise<StaticAnalysis>{
  const copied={...jobInput,artifacts:jobInput.artifacts.map(a=>({...a,bytes:Uint8Array.from(a.bytes)})),checks:jobInput.checks.map(c=>({...c}))};
  const handles:FileHandle[]=[];let folder:string|undefined,executable:FileHandle|undefined;
  const timeout=options.timeoutMs??35000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)throw failure("invalid-deadline");
  try{
    signal.throwIfAborted();const b=await binary(options.directory);signal.throwIfAborted();
    if(copied.artifacts.reduce((n,a)=>n+a.bytes.length,0)>128*1024*1024)throw failure("input-limit");
    const job:Job={job_id:copied.jobId,attempt_id:copied.attemptId,artifacts:copied.artifacts.map((a,i)=>({role:a.role,fd:i+3,sha256:hash(a.bytes),bytes:a.bytes.length})),checks:copied.checks};
    if(!wireShape("Job",job)||new Set(job.artifacts.map(a=>a.role)).size!==job.artifacts.length||new Set(job.checks.map(c=>c.id)).size!==job.checks.length||!job.artifacts.some(a=>a.role==="source")||![job.job_id,job.attempt_id].every(id=>/^[A-Za-z0-9_-]{1,64}$/.test(id)))throw failure("invalid-input");
    if(job.checks.some(c=>!b.checks.some(v=>c.id===v.id&&c.revision===v.revision)))throw failure("checker-mismatch");
    folder=await mkdtemp(join(tmpdir(),"grokbox-verifier-"));
    for(let i=0;i<copied.artifacts.length;i++){
      signal.throwIfAborted();const path=join(folder,String(i));await writeFile(path,copied.artifacts[i]!.bytes,{mode:0o600,flag:"wx"});
      const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);handles.push(fd);await unlink(path);
    }
    await rm(folder,{recursive:true});folder=undefined;signal.throwIfAborted();
    // Execute the verified inode, not a pathname that can be renamed between
    // hashing and spawn. Descriptor 6 is separate from artifact FDs 3–5.
    executable=await open(b.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    if(hash(await executable.readFile())!==b.digest)throw failure("binary-changed");
    const report=await new Promise<Report>((resolve,reject)=>{
      const child=spawn("/proc/self/fd/6",[],{stdio:["pipe","pipe","pipe",...Array.from({length:3},(_,i)=>handles[i]?.fd??"ignore" as const),executable!.fd],env:{},windowsHide:true});
      const frames=new VerifierFrames();let stage:"hello"|"result"|"done"="hello",result:Report|undefined,error:Error|undefined,stderr=0,closed=false,killTimer:ReturnType<typeof setTimeout>|undefined,cleanupTimer:ReturnType<typeof setTimeout>|undefined;
      const stop=(cause:Error)=>{error??=cause;if(closed)return;child.kill("SIGTERM");killTimer??=setTimeout(()=>{if(!closed)child.kill("SIGKILL");},100);
        cleanupTimer??=setTimeout(()=>{if(!closed){clearTimeout(deadline);signal.removeEventListener("abort",abort);reject(failure("cleanup-unconfirmed"));}},5000);
      };
      const abort=()=>stop(failure("cancelled"));signal.addEventListener("abort",abort,{once:true});
      const deadline=setTimeout(()=>stop(failure("deadline")),timeout);
      const send=(value:unknown)=>{try{const method=(value as {method?:string})?.method;if(!wireShape(method==="initialize"?"InitializeRequest":"AnalyzeRequest",value))throw failure("invalid-request-frame");child.stdin!.write(encodeFrame(value));}catch{stop(failure("stdin-failed"));}};
      child.on("spawn",()=>{if(child.pid)options.onSpawn?.(child.pid);if(signal.aborted){abort();return;}send({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocol:1,schema_digest:SCHEMA_DIGEST,build_id:b.buildId}});});
      child.stdin!.on("error",()=>{if(stage!=="done")stop(failure("stdin-failed"));});child.on("error",()=>stop(failure("spawn-failed")));
      child.stderr!.on("data",chunk=>{stderr+=chunk.length;if(stderr>8192)stop(failure("stderr-limit"));});
      child.stdout!.on("data",chunk=>{try{for(const raw of frames.push(chunk)){
        const v=raw as any;if(!wireShape(stage==="hello"?"HelloResponse":"AnalyzeResponse",v))throw failure("rpc-shape");
        if(stage==="hello"){
          if(v.id!=="initialize"||!wireShape("Hello",v.result)||v.result.schema_digest!==SCHEMA_DIGEST||v.result.build_id!==b.buildId||v.result.parser!==b.parser||JSON.stringify(v.result.checks)!==JSON.stringify(b.checks))throw failure("handshake-mismatch");
          stage="result";send({jsonrpc:"2.0",id:"analyze",method:"analyze",params:job});child.stdin!.end();
        }else if(stage==="result"){
          if(v.id!=="analyze")throw failure("rpc-identity");result=matchingReport(v.result,job,b);stage="done";
        }else throw failure("duplicate-final");
      }}catch(e){stop(e instanceof VerifierFailure?e:failure("protocol-failed"));}});
      child.once("close",(code,exitSignal)=>{
        closed=true;clearTimeout(deadline);if(killTimer)clearTimeout(killTimer);if(cleanupTimer)clearTimeout(cleanupTimer);signal.removeEventListener("abort",abort);
        try{frames.finish();}catch(e){error??=e as Error;}
        if(error)reject(error);else if(code!==0||exitSignal||!result||stage!=="done")reject(failure("child-failed"));else resolve(result);
      });
      if(signal.aborted)abort();
    });
    const after=await binary(options.directory);if(after.digest!==b.digest||after.buildId!==b.buildId)throw failure("binary-changed");
    return {jobId:report.job_id,attemptId:report.attempt_id,buildId:report.build_id,schemaDigest:report.schema_digest,parser:b.parser,elapsedMs:report.elapsed_ms,
      artifacts:report.syntax.map(a=>({role:a.role,sha256:a.sha256,bytes:a.bytes,valid:a.state==="valid",diagnostics:a.diagnostics,nodes:a.nodes})),checks:report.findings};
  }finally{await Promise.all([...handles,...(executable?[executable]:[])].map(h=>h.close()));if(folder)await rm(folder,{recursive:true,force:true});}
}
/** Effect owns the actual child and cleanup, including cancellation: the slot
 * remains occupied until close and FD cleanup, never merely until a report. */
export function hostVerifierLayer(options:{directory?:string;timeoutMs?:number;onSpawn?:(pid:number)=>void}={}){
  let busy=false,quarantined=false;
  return Layer.succeed(HostVerifier,{identity:()=>Effect.tryPromise({try:async()=>{const b=await binary(options.directory);return {buildId:b.buildId,schemaDigest:SCHEMA_DIGEST};},catch:()=>failure("binary-unavailable")}),analyze:job=>Effect.scoped(Effect.gen(function*(){
    if(quarantined)return yield* Effect.fail(failure("cleanup-unconfirmed"));
    if(busy)return yield* Effect.fail(failure("busy"));
    const task=yield* Effect.acquireRelease(Effect.try({try:()=>{if(busy)throw failure("busy");busy=true;const controller=new AbortController();const promise=run(job,controller.signal,options);void promise.catch(()=>undefined);return {controller,promise};},catch:e=>e instanceof Error?e:failure("unavailable")}),
      task=>Effect.promise(async()=>{task.controller.abort();await task.promise.catch(error=>{if(error instanceof VerifierFailure&&error.code==="cleanup-unconfirmed")quarantined=true;});busy=quarantined;}));
    return yield* Effect.tryPromise({try:()=>task.promise,catch:e=>e instanceof VerifierFailure?e:failure("unavailable")});
  }))});
}
