import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, open, rm, access, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Effect, ManagedRuntime } from "effect";
import { HOST_CHECK_REQUIREMENTS } from "@grokbox/runtime-kernel/host-health";
import { HostVerifier } from "../src/internal/ops/host-health/verifier.port.ts";
import { hostVerifierLayer } from "../src/internal/io/host-verifier/client.node.ts";
import { encodeFrame, VerifierFrames } from "../src/internal/io/host-verifier/stdio.node.ts";
import { SCHEMA_DIGEST } from "../src/internal/io/host-verifier/generated/protocol.ts";
const directory=join(dirname(process.env.GROKBOX_TEST_CLI_ENTRY!),"native/x86_64-unknown-linux-gnu");
const sha=(v:Uint8Array|string)=>createHash("sha256").update(v).digest("hex");
const manifest=JSON.parse(await readFile(join(directory,"verifier-manifest.json"),"utf8"));
const good=await readFile(join(process.env.GROKBOX_TEST_FIXTURES!,"host-verifier/sources/lease-lifetime.cjs"));
const checks=HOST_CHECK_REQUIREMENTS.map(({id,revision})=>({id,revision}));
const job=()=>({jobId:randomUUID(),attemptId:randomUUID(),checks,artifacts:[{role:"source" as const,bytes:good},{role:"candidate" as const,bytes:good}]});
const analyze=(runtime:ManagedRuntime.ManagedRuntime<HostVerifier, never>,input=job(),signal?:AbortSignal)=>runtime.runPromise(Effect.gen(function*(){const port=yield* HostVerifier;return yield* port.analyze(input);}),signal?{signal}:undefined);
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function eventually(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(5);}throw Error("boundary-deadline");}

async function rawCase(change:(value:any)=>void=()=>{}, writable=false,truncate=false){
 const root=await mkdtemp(join(tmpdir(),"verifier-raw-")),file=join(root,"input"),out:Buffer[]=[];
 await writeFile(file,good,{mode:0o600});const fd=await open(file,writable?"r+":"r");
 const request={job_id:randomUUID(),attempt_id:randomUUID(),checks,artifacts:[{role:"source",fd:3,sha256:sha(good),bytes:good.length}]};change(request);
 const child=spawn(join(directory,"grokbox-host-verifier"),[],{env:{},stdio:["pipe","pipe","pipe",fd.fd]});
 let stderr="";child.stdout!.on("data",b=>out.push(b));child.stderr!.on("data",b=>stderr+=b.toString());
 const timer=setTimeout(()=>child.kill("SIGKILL"),5000);
 try{
  const frame=encodeFrame({jsonrpc:"2.0",id:"analyze",method:"analyze",params:request});
  child.stdin!.on("error",()=>{});
  child.stdin!.end(Buffer.concat([encodeFrame({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocol:1,schema_digest:SCHEMA_DIGEST,build_id:manifest.build_id}}),truncate?frame.subarray(0,frame.length-1):frame]));
  const result=await new Promise<{code:number|null;signal:string|null}>(resolve=>child.once("close",(code,signal)=>resolve({code,signal})));
  const decoder=new VerifierFrames(),frames=decoder.push(Buffer.concat(out));decoder.finish();return {...result,frames,stderr};
 }finally{clearTimeout(timer);await fd.close();await rm(root,{recursive:true,force:true});}
}

test("formal binary and manifest cover every required checker without cargo or a private Host",async()=>{
 for(const c of checks)assert.ok(manifest.checks.some((r:any)=>r.id===c.id&&r.revision===c.revision));
 const pids:number[]=[];const runtime=ManagedRuntime.make(hostVerifierLayer({directory,onSpawn:pid=>pids.push(pid)}));
 try{const r=await analyze(runtime);assert.ok(r.artifacts.every(a=>a.valid));assert.ok(r.checks.every(c=>c.state==="passed"));assert.equal(r.schemaDigest,SCHEMA_DIGEST);
  assert.equal(pids.length,1);assert.throws(()=>process.kill(pids[0]!,0));}finally{await runtime.dispose();}
});
for(const [name,change,writable,truncate] of [
 ["wrong byte hash",(j:any)=>{j.artifacts[0].sha256="0".repeat(64);},false,false],
 ["wrong byte count",(j:any)=>{j.artifacts[0].bytes++;},false,false],
 ["duplicate descriptor",(j:any)=>{j.artifacts.push({...j.artifacts[0],role:"candidate"});},false,false],
 ["duplicate role",(j:any)=>{j.artifacts.push({...j.artifacts[0],fd:4});},false,false],
 ["writable descriptor",()=>{},true,false],
 ["truncated final input frame",()=>{},false,true],
] as const)test(`actual Rust rejects ${name} without a final analysis`,async()=>{const r=await rawCase(change,writable,truncate);assert.notEqual(r.code,0);assert.equal(r.frames.length,1);assert.match(r.stderr,/^[a-z-]+\n$/);});

test("real invalid syntax is evidence, not a verifier crash or a successful parse-recovery AST",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory}));try{const j=job();j.artifacts=j.artifacts.map(a=>({...a,bytes:Buffer.from("let x = 1; let x = 2;")}));
 const r=await analyze(runtime,j);assert.ok(r.artifacts.every(a=>!a.valid));assert.ok(r.checks.every(c=>c.state!=="passed"));}finally{await runtime.dispose();}
});

test("a valid candidate cannot conceal invalid original-source syntax as either success or a protocol crash",async()=>{
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory}));try{const j=job();j.artifacts[0]={role:"source",bytes:Buffer.from("const broken = ;")};
 const result=await analyze(runtime,j);assert.equal(result.artifacts[0]!.valid,false);assert.equal(result.artifacts[1]!.valid,true);assert.ok(result.checks.every(c=>c.state==="passed"));
 // The complete analysis is invalid despite its independent candidate findings.
 assert.equal(result.artifacts.every(a=>a.valid),false);
 }finally{await runtime.dispose();}
});

test("source text is never evaluated and a pre-aborted request spawns no verifier",async()=>{
 const root=await mkdtemp(join(tmpdir(),"verifier-no-eval-")),sentinel=join(root,"must-not-exist"),pids:number[]=[];
 const runtime=ManagedRuntime.make(hostVerifierLayer({directory,onSpawn:pid=>pids.push(pid)}));try{
 const j=job();j.artifacts=[{role:"source",bytes:Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed');`)}];
 const r=await analyze(runtime,j);assert.ok(r.checks.every(c=>c.state==="unsupported"));await assert.rejects(access(sentinel));
 const n=pids.length,c=new AbortController();c.abort();await assert.rejects(analyze(runtime,job(),c.signal));assert.equal(pids.length,n);
 }finally{await runtime.dispose();await rm(root,{recursive:true,force:true});}
});

// Deliberately hostile test executables are confined to a test-only directory.
// They test transport failure, never substitute for the real analysis oracle.
async function hostile(mode:string){
 const root=await mkdtemp(join(tmpdir(),"hostile-verifier-"));
 const source=`#!${process.execPath}\nconst fs=require('node:fs');let input=Buffer.alloc(0),stage=0;const mode=${JSON.stringify(mode)};const hello=${JSON.stringify(Object.fromEntries(["protocol","schema_digest","build_id","parser","checks"].map(k=>[k,manifest[k]])))};
const send=v=>{const b=Buffer.from(JSON.stringify(v));process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b);};
if(mode==='ignore-term')process.on('SIGTERM',()=>{});
process.stdin.on('data',b=>{input=Buffer.concat([input,b]);while(true){const end=input.indexOf('\\r\\n\\r\\n');if(end<0)return;const n=Number(input.subarray(16,end));if(input.length<end+4+n)return;const m=JSON.parse(input.subarray(end+4,end+4+n));input=input.subarray(end+4+n);if(stage++===0){if(mode==='wrong-handshake')hello.schema_digest='0'.repeat(64);send({jsonrpc:'2.0',id:m.id,result:hello});continue;}
 if(mode==='crash')process.exit(3);if(mode==='stderr'){process.stderr.write('x'.repeat(9000));return;}if(mode==='hang'||mode==='ignore-term')return;
 const j=m.params;const result={job_id:j.job_id,attempt_id:mode==='wrong-attempt'?'foreign':j.attempt_id,build_id:hello.build_id,schema_digest:hello.schema_digest,syntax:j.artifacts.map(a=>({role:a.role,sha256:a.sha256,bytes:a.bytes,state:'valid',diagnostics:0,nodes:2})),findings:j.checks.map(c=>({...c,state:'unsupported',code:'fixture-only',start:0,end:0})),elapsed_ms:1};
 if(mode==='truncated'){process.stdout.write('Content-Length: 100\\r\\n\\r\\n{}');process.exit(0);}
 send({jsonrpc:'2.0',id:m.id,result});if(mode==='double-final')send({jsonrpc:'2.0',id:m.id,result});if(mode==='report-then-hang')return;setTimeout(()=>process.exit(0),20);
 }});setInterval(()=>{},1000);`;
 const path=join(root,"grokbox-host-verifier");await writeFile(path,source,{mode:0o755});await chmod(path,0o755);
 await writeFile(join(root,"verifier-manifest.json"),JSON.stringify({...manifest,binary_sha256:sha(source),binary_bytes:Buffer.byteLength(source)}),{mode:0o644});return root;
}
for(const [mode,expected] of [["wrong-handshake","handshake-mismatch"],["wrong-attempt","report-identity"],["double-final","duplicate-final"],["truncated","truncated-frame"],["crash","child-failed"],["stderr","stderr-limit"],["report-then-hang","deadline"],["ignore-term","deadline"]])test(`supervisor refuses ${mode} and joins child close before releasing its slot`,async()=>{
 const root=await hostile(mode!),pids:number[]=[],runtime=ManagedRuntime.make(hostVerifierLayer({directory:root,timeoutMs:250,onSpawn:pid=>pids.push(pid)}));try{
 await assert.rejects(analyze(runtime),(e:any)=>e.code===expected);assert.equal(pids.length,1);assert.throws(()=>process.kill(pids[0]!,0));
 }finally{await runtime.dispose();await rm(root,{recursive:true,force:true});}
});
test("actual Rust exits when its owning Node parent is killed, without a surviving analysis daemon",async()=>{
 const root=await mkdtemp(join(tmpdir(),"verifier-parent-death-")),entry=join(root,"parent.cjs");let childPid:number|undefined;
 const hello=encodeFrame({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocol:1,schema_digest:SCHEMA_DIGEST,build_id:manifest.build_id}}).toString("base64");
 await writeFile(entry,`const {spawn}=require('node:child_process');const child=spawn(${JSON.stringify(join(directory,"grokbox-host-verifier"))},[],{env:{},stdio:['pipe','pipe','pipe']});child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n'));child.stdin.write(Buffer.from(${JSON.stringify(hello)},'base64'));setInterval(()=>{},1000);`);
 const parent=spawn(process.execPath,[entry],{env:{},stdio:["ignore","pipe","pipe"]});let output="";parent.stdout!.on("data",b=>output+=b);
 try{await eventually(()=>/^\d+\n$/.test(output));childPid=Number(output.trim());assert.ok(childPid>1);assert.doesNotThrow(()=>process.kill(childPid!,0));
  const closed=new Promise<void>(resolve=>parent.once("close",()=>resolve()));parent.kill("SIGKILL");await closed;
  let stopped=false;for(let i=0;i<100;i++){const stat=await readFile(`/proc/${childPid}/stat`,"utf8").catch(()=>null);if(stat===null||stat.slice(stat.lastIndexOf(")")+2).startsWith("Z ")){stopped=true;break;}await delay(10);}assert.ok(stopped,"verifier survived its owner");
 }finally{parent.kill("SIGKILL");if(childPid)try{process.kill(childPid,"SIGKILL");}catch{}await rm(root,{recursive:true,force:true});}
});

test("cancellation keeps the analysis slot occupied until SIGTERM/SIGKILL and actual close",async()=>{
 const root=await hostile("ignore-term"),pids:number[]=[],runtime=ManagedRuntime.make(hostVerifierLayer({directory:root,timeoutMs:5000,onSpawn:pid=>pids.push(pid)})),cancel=new AbortController();
 try{const first=analyze(runtime,job(),cancel.signal);void first.catch(()=>{});await eventually(()=>pids.length===1);
 await assert.rejects(analyze(runtime),(e:any)=>e.code==="busy");cancel.abort();await assert.rejects(first);assert.throws(()=>process.kill(pids[0]!,0));
 }finally{await runtime.dispose();await rm(root,{recursive:true,force:true});}
});
