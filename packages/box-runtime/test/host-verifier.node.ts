import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, ManagedRuntime } from "effect";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, open, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { hostVerifierLayer } from "../src/internal/io/host-verifier/client.node.ts";
import { HostVerifier, type StaticJob } from "../src/internal/ops/host-health/verifier.port.ts";
import { encodeFrame, VerifierFrames, wireShape } from "../src/internal/io/host-verifier/stdio.node.ts";
import { SCHEMA_DIGEST } from "../src/internal/io/host-verifier/generated/protocol.ts";
import { HOST_CHECK_REQUIREMENTS } from "@grokbox/runtime-kernel/host-health";
const dir=join(dirname(process.env.GROKBOX_TEST_CLI_ENTRY!),"native/x86_64-unknown-linux-gnu"), checks=HOST_CHECK_REQUIREMENTS.map(c=>({id:c.id,revision:c.revision}));
const hash=(b:string|Uint8Array)=>createHash("sha256").update(b).digest("hex"), delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const source=()=>readFile(join(process.env.GROKBOX_TEST_FIXTURES!,"host-verifier/sources/lease-lifetime.cjs"));
async function job():Promise<StaticJob>{const bytes=await source();return {jobId:randomUUID(),attemptId:randomUUID(),artifacts:[{role:"source",bytes},{role:"candidate",bytes}],checks};}
function execute(runtime:ManagedRuntime.ManagedRuntime<HostVerifier,never>,input:StaticJob,signal?:AbortSignal){return runtime.runPromise(Effect.gen(function*(){const v=yield* HostVerifier;return yield* v.analyze(input);}),signal?{signal}:undefined);}
const rejected=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:any)=>e.code===code);

test("real packaged Rust verifies read-only source and candidate FDs and detaches caller buffers before async work",async()=>{
 let pid=0;const runtime=ManagedRuntime.make(hostVerifierLayer({directory:dir,onSpawn:id=>pid=id}));
 try{const input=await job(),expected=hash(input.artifacts[0]!.bytes),task=execute(runtime,input);input.artifacts[0]!.bytes.fill(0);
  const report=await task;assert.ok(report.checks.every(c=>c.state==="passed"));assert.equal(report.artifacts[0]!.sha256,expected);assert.equal(report.schemaDigest,SCHEMA_DIGEST);
  assert.ok(report.elapsedMs<35000);assert.throws(()=>process.kill(pid,0));assert.ok(!JSON.stringify(report).includes("globalThis"));
 }finally{await runtime.dispose();}
});

test("packaged revision-two checker consumes native role fixtures rather than a SHA-only or CJS-export oracle",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory:dir}));
 try {
  const bytes=await readFile(join(process.env.GROKBOX_TEST_FIXTURES!,"host-verifier/sources/native-roles.cjs"));
  const input:StaticJob={jobId:randomUUID(),attemptId:randomUUID(),checks:checks.filter(c=>c.id!=="context.lease-finally"),artifacts:[{role:"source",bytes},{role:"candidate",bytes}]};
  const report=await execute(runtime,input);assert.ok(report.checks.every(c=>c.state==="passed"&&c.revision===2));
  for(const [before,after,index] of [["clientNonce: options.clientNonce","clientNonce: foreign.clientNonce",0],["return false;","return true;",1],["await onStateUpdate(ctx,","onStateUpdate(ctx,",2]] as const){
   const candidate=Buffer.from(bytes.toString().replace(before,after));
   const broken=await execute(runtime,{...input,attemptId:randomUUID(),artifacts:[{role:"source",bytes},{role:"candidate",bytes:candidate}]});
   assert.equal(broken.artifacts[1]!.valid,true);assert.equal(broken.artifacts[1]!.sha256,hash(candidate));assert.notEqual(broken.checks[index]!.state,"passed");
  }
  await rejected(execute(runtime,{...input,checks:checks.map(c=>({...c,revision:1}))}),"checker-mismatch");
 }finally{await runtime.dispose();}
});

test("packaged lease checker catches semantic damage with recomputed candidate hashes, not source-SHA mismatch",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory:dir}));try{
  const input=await job(),original=input.artifacts[1]!.bytes;
  for(const [from,to,code] of [["disposeResources(env);","void 0;","lease-finally-not-exact"],
    ["await lease.preflight()","lease.preflight()","lease-preflight-not-awaited"],
    ["active = false;","active = true;","lease-not-closed-before-dispose"]]){
   const candidate=Buffer.from(Buffer.from(original).toString().replace(from!,to!));assert.notEqual(hash(candidate),hash(original));
   const r=await execute(runtime,{...input,attemptId:randomUUID(),artifacts:[input.artifacts[0]!,{role:"candidate",bytes:candidate}]});
   assert.equal(r.artifacts[1]!.valid,true);assert.equal(r.artifacts[1]!.sha256,hash(candidate));
   assert.equal(r.checks.find(c=>c.id==="context.lease-finally")!.code,code);assert.equal(r.checks.find(c=>c.id==="context.lease-finally")!.state,"violated");
  }
 }finally{await runtime.dispose();}
});

test("candidate predicates remain separate from an invalid companion's syntax verdict",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory:dir}));try{
  const input=await job();input.artifacts.push({role:"companion",bytes:Buffer.from('const = ;')});const report=await execute(runtime,input);
  assert.equal(report.artifacts[2]!.valid,false);assert.ok(report.checks.every(c=>c.state==='passed'));
 }finally{await runtime.dispose();}
});

test("real Rust reports strict syntax and semantic failure rather than recovered AST success",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory:dir}));try{
  for(const text of ["const = ;","let x; let x;","return 1;"]){const input=await job();input.artifacts[1]!.bytes=Buffer.from(text);const report=await execute(runtime,input);assert.equal(report.artifacts[1]!.valid,false);assert.ok(report.checks.every(c=>c.state!=="passed"));}
 }finally{await runtime.dispose();}
});

test("Node and Rust consume the same independent finite wire cases",async()=>{
 const rows=JSON.parse(await readFile(join(process.env.GROKBOX_TEST_FIXTURES!,"../../protocols/host-verifier/v1/cases/shapes.json"),"utf8"));
 for(const row of rows)assert.equal(wireShape(row.definition,row.value),row.valid,row.name);
});

test("protocol frames reject truncated UTF-8, duplicate fields, headers and oversized output before a report",()=>{
 const value={unicode:"猫",number:1},frames=new VerifierFrames(),bytes=encodeFrame(value),found:unknown[]=[];
 for(const b of bytes)found.push(...frames.push(Buffer.from([b])));frames.finish();assert.deepEqual(found,[value]);
 for(const payload of [Buffer.from('Content-Length: 02\r\n\r\n{}'),Buffer.from('Content-Length: 2\r\nX: x\r\n\r\n{}'),Buffer.from('Content-Length: 13\r\n\r\n{"x":1,"x":2}'),Buffer.from([ ...Buffer.from('Content-Length: 1\r\n\r\n'),255])])assert.throws(()=>new VerifierFrames().push(payload));
 const partial=new VerifierFrames();partial.push(Buffer.from('Content-Length: 10\r\n\r\n{}'));assert.throws(()=>partial.finish());assert.throws(()=>new VerifierFrames().push(Buffer.alloc(131329)));
 assert.equal(wireShape("Job",{job_id:"x",attempt_id:"a",artifacts:[],checks:[]}),false);
});

/** An intentionally faulty, owned executable exercises the Node protocol/exit
 * boundary. It is never a fallback parser or exported runtime configuration. */
async function hostile(mode:string){
 const folder=await mkdtemp(join(tmpdir(),"verifier-fault-")), manifest=JSON.parse(await readFile(join(dir,"verifier-manifest.json"),"utf8"));
 const code=`#!${process.execPath}\nconst mode=${JSON.stringify(mode)}; const identity=${JSON.stringify(Object.fromEntries(["protocol","schema_digest","build_id","parser","checks"].map(k=>[k,manifest[k]])))};let buf=Buffer.alloc(0);let alive;
 const frame=v=>{const b=Buffer.from(JSON.stringify(v));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));};
 if(mode==='hang') {setInterval(()=>{},1000);process.on('SIGTERM',()=>{});} else process.stdin.on('data',b=>{buf=Buffer.concat([buf,b]);for(;;){let n=buf.indexOf('\\r\\n\\r\\n');if(n<0)return;const len=Number(buf.subarray(0,n).toString().split(': ')[1]);if(buf.length<n+4+len)return;const v=JSON.parse(buf.subarray(n+4,n+4+len));buf=buf.subarray(n+4+len);
 if(v.method==='initialize'){if(mode==='wrong-schema')identity.schema_digest='f'.repeat(64);frame({jsonrpc:'2.0',id:v.id,result:identity});continue;}
 const j=v.params,r={job_id:j.job_id,attempt_id:j.attempt_id,schema_digest:identity.schema_digest,build_id:identity.build_id,syntax:j.artifacts.map(a=>({role:a.role,sha256:a.sha256,bytes:a.bytes,state:'valid',diagnostics:0,nodes:1})),findings:j.checks.map(c=>({...c,state:'passed',code:'owned-test-report',start:0,end:1})),elapsed_ms:1};
 if(mode==='wrong-attempt')r.attempt_id='foreign';if(mode==='wrong-digest')r.syntax[0].sha256='e'.repeat(64);if(mode==='stderr')process.stderr.write('x'.repeat(9000));
 if(mode==='partial'){process.stdout.write('Content-Length: 100\\r\\n\\r\\n{}');return;}frame({jsonrpc:'2.0',id:v.id,result:r});if(mode==='duplicate')frame({jsonrpc:'2.0',id:v.id,result:r});if(mode==='after-report-crash')process.exitCode=2;
 if(mode==='delayed-close'){alive=setTimeout(()=>{},160);}if(mode==='report-hang'){setInterval(()=>{},1000);process.on('SIGTERM',()=>{});}
 }});`;
 const path=join(folder,"grokbox-host-verifier");await writeFile(path,code,{mode:0o700});
 await writeFile(join(folder,"verifier-manifest.json"),JSON.stringify({...manifest,binary_bytes:Buffer.byteLength(code),binary_sha256:hash(code)}),{mode:0o600});
 return {folder,close:()=>rm(folder,{recursive:true,force:true})};
}
for(const [mode,reason] of [["wrong-schema","handshake-mismatch"],["wrong-attempt","report-identity"],["wrong-digest","report-artifacts"],["duplicate","duplicate-final"],["partial","truncated-frame"],["after-report-crash","child-failed"],["stderr","stderr-limit"],["hang","deadline"],["report-hang","deadline"]])test(`Node rejects ${mode} and waits for actual child close`,async()=>{
 const f=await hostile(mode!),pids:number[]=[];const runtime=ManagedRuntime.make(hostVerifierLayer({directory:f.folder,timeoutMs:500,onSpawn:pid=>pids.push(pid)}));
 try{await rejected(execute(runtime,await job()),reason!);for(const pid of pids)assert.throws(()=>process.kill(pid,0));}finally{await runtime.dispose();await f.close();}
});

test("public group-writable manifests refuse even when their declared binary hash is internally consistent",async()=>{
 const base=await mkdtemp('/tmp/grokbox-untrusted-verifier-');await chmod(base,0o755);
 const mf=await readFile(join(dir,'verifier-manifest.json'));await writeFile(join(base,'verifier-manifest.json'),mf,{mode:0o664});await chmod(join(base,'verifier-manifest.json'),0o664);
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory:base}));try{await rejected(execute(runtime,await job()),'manifest-invalid');}finally{await runtime.dispose();await rm(base,{recursive:true,force:true});}
});

test("receiving final report does not free the single-flight slot before process close",async()=>{
 const f=await hostile("delayed-close");let started!:()=>void;const onSpawn=new Promise<void>(r=>started=r),runtime=ManagedRuntime.make(hostVerifierLayer({directory:f.folder,onSpawn:()=>started()}));
 try{const first=execute(runtime,await job()),at=Date.now();await onSpawn;await rejected(execute(runtime,await job()),"busy");await first;assert.ok(Date.now()-at>=140);await execute(runtime,await job());}finally{await runtime.dispose();await f.close();}
});

test("interruption joins the child before the next attempt and a later ordinary attempt still works",async()=>{
 const f=await hostile("hang");let started!:()=>void,pid=0;const gate=new Promise<void>(r=>started=r),runtime=ManagedRuntime.make(hostVerifierLayer({directory:f.folder,onSpawn:id=>{pid=id;started();}}));
 try{const controller=new AbortController(),first=execute(runtime,await job(),controller.signal);await gate;controller.abort();await assert.rejects(first);assert.throws(()=>process.kill(pid,0));
  const second=execute(runtime,await job(),AbortSignal.timeout(100));await assert.rejects(second);
 }finally{await runtime.dispose();await f.close();}
});

for(const mode of ["writable","digest","duplicate-fd"] as const)test(`actual Rust rejects ${mode} descriptor contract`,async()=>{
 const folder=await mkdtemp(join(tmpdir(),"verifier-fd-")),file=join(folder,"input");await writeFile(file,"const x=1;",{mode:0o600});const fd=await open(file,mode==="writable"?"r+":"r");
 const manifest=JSON.parse(await readFile(join(dir,"verifier-manifest.json"),"utf8"));
 try{const child=spawn(join(dir,"grokbox-host-verifier"),[],{env:{},stdio:["pipe","pipe","pipe",fd.fd]});
  let err="";const parser=new VerifierFrames(),results:any[]=[];child.stderr!.on("data",b=>err+=b);child.stdout!.on("data",b=>results.push(...parser.push(b)));
  child.stdin!.end(Buffer.concat([encodeFrame({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocol:1,schema_digest:SCHEMA_DIGEST,build_id:manifest.build_id}}),encodeFrame({jsonrpc:"2.0",id:"analyze",method:"analyze",params:{job_id:"fd-job",attempt_id:"fd-attempt",checks,artifacts:[{role:"source",fd:3,bytes:10,sha256:mode==="digest"?"0".repeat(64):hash("const x=1;")},...(mode==="duplicate-fd"?[{role:"candidate",fd:3,bytes:10,sha256:hash("const x=1;")}]:[])]}})]));
  const [status]=await once(child,"close");assert.equal(status,2);assert.equal(results.length,1);assert.match(err,mode==="writable"?/fd-not-read-only/:mode==="digest"?/fd-digest-mismatch/:/duplicate-identity/);
 }finally{await fd.close();await rm(folder,{recursive:true,force:true});}
});

test("actual Rust receives parent-death termination after initialization without a daemon or child keeper",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"verifier-parent-"));const manifest=JSON.parse(await readFile(join(dir,"verifier-manifest.json"),"utf8"));
 const script=join(folder,"parent.mjs");await writeFile(script,`import {spawn} from 'node:child_process';const c=spawn(${JSON.stringify(join(dir,"grokbox-host-verifier"))},[],{env:{},stdio:['pipe','pipe','ignore']});const b=Buffer.from(${JSON.stringify(JSON.stringify({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocol:1,schema_digest:SCHEMA_DIGEST,build_id:manifest.build_id}}))});c.stdin.write(Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]));c.stdout.once('data',()=>console.log(c.pid));setInterval(()=>{},1000);`,{mode:0o600});
 const parent=spawn(process.execPath,[script],{env:{},stdio:["ignore","pipe","pipe"]});let text="";parent.stdout!.on("data",b=>text+=b);let pid=0;
 try{const until=Date.now()+4000;while(!text.includes("\n")&&Date.now()<until)await delay(10);pid=Number(text.trim());assert.ok(pid>0);const closed=once(parent,"close");parent.kill("SIGKILL");await closed;
  let terminated=false;for(let i=0;i<100;i++){const status=await readFile(`/proc/${pid}/status`,"utf8").catch(()=>null);if(status===null||/^State:\s+Z/m.test(status)){terminated=true;break;}await delay(10);}assert.ok(terminated);
 }finally{parent.kill("SIGKILL");if(pid){try{process.kill(pid,"SIGKILL");}catch{}}await rm(folder,{recursive:true,force:true});}
});
