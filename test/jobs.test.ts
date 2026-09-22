import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager, GovernedFilesystem, ProcessAuthority, type JobSubmit } from "@grokbox/box-runtime/runtime";
import { validateDaemonIntent } from "@grokbox/runtime-kernel/config";
import { captureCli, startMockGateway } from "./helpers.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { createProductionDeps } from "../packages/cli/src/deps.ts";
import { LocalDaemonClient } from "../packages/cli/src/daemon/client.ts";

const I="11111111-1111-4111-8111-111111111111";
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"grokbox-job-owner-")),workspace=join(root,"workspace");await mkdir(workspace,{mode:0o700});
  const policy={cwdRoots:["workspace"],defaultCwdRoot:"workspace",executables:[{name:"node",path:await realpath(Bun.which("node")!)}],environment:["VISIBLE"],maxConcurrent:1,maxQueued:2,maxRuntimeMs:10000,maxOutputBytes:1024};
  const filesystem=await GovernedFilesystem.create([{name:"workspace",path:workspace,operations:["exec"]}],Date.now),authority=await ProcessAuthority.create(policy);
  const manager=await JobManager.create(root,authority,filesystem,Date.now);
  const request=(script="process.exit(0)",jobId=randomUUID()):JobSubmit=>({jobId,scope:{installationId:I,principalId:"owner",requestId:jobId,policyRevision:"f".repeat(64)},cwd:"workspace:/",argv:["node","-e",script],environment:{},runTimeoutMs:5000,output:"capture",shell:false});
  return {root,workspace,policy,manager,request,filesystem,authority,close:async()=>{try{await manager.close();}finally{await filesystem.close();await rm(root,{recursive:true,force:true});}}};
}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test("execution policy is the canonical config and requires exec-admitted cwd and safe environment",()=>{
  const base={filesystem:{roots:[{name:"workspace",path:"/tmp/workspace",operations:["exec"]}]},process:{cwdRoots:["workspace"],defaultCwdRoot:"workspace",executables:[{name:"node",path:process.execPath}],environment:["CI"],maxConcurrent:1,maxQueued:2,maxRuntimeMs:1000,maxOutputBytes:1024}};
  expect(()=>validateDaemonIntent(base)).not.toThrow();
  for(const process of [{...base.process,surprise:true},{...base.process,environment:["NODE_OPTIONS"]},{...base.process,executables:[...base.process.executables,...base.process.executables]}])expect(()=>validateDaemonIntent({...base,process})).toThrow();
  expect(()=>validateDaemonIntent({...base,filesystem:{roots:[{...base.filesystem.roots[0],operations:["read"]}]}})).toThrow();
});
for(const afterCommit of [false,true])test(`queued cancellation publication uncertainty never requeues work, commit=${afterCommit}`,async()=>{
  const f=await fixture();let release!:()=>void;
  try{
    const first=f.request("setTimeout(()=>{},150)"),second=f.request("require('node:fs').writeFileSync('forbidden.txt','bad')");
    await f.manager.submit(first);await f.manager.submit(second);
    const internal=f.manager as unknown as {persist(job:{jobId:string;state:string}):Promise<void>},original=internal.persist.bind(f.manager);
    let entered!:()=>void;const reached=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
    internal.persist=async job=>{if(job.jobId===second.jobId&&job.state==="cancelled"){if(afterCommit)await original(job);entered();await barrier;throw Error("lost-publication-receipt");}await original(job);};
    const id=randomUUID(),cancel=f.manager.cancel(second.jobId,id).catch(e=>e);await reached;
    const competing=f.manager.cancel(second.jobId,randomUUID()).catch(e=>e);
    await f.manager.waitTerminal(first.jobId,3000);release();
    expect((await cancel).code).toBe("operation_outcome_unknown");expect((await competing).code).toBe("job_conflict");
    expect(f.manager.show(second.jobId)).toMatchObject({state:"unknown",cancelOperationId:id});await wait(25);
    await expect(readFile(join(f.workspace,"forbidden.txt"))).rejects.toMatchObject({code:"ENOENT"});
    internal.persist=original;
  }finally{release?.();await f.close();}
});
test("shutdown publication failure keeps the physical owner until pending launch and writes settle",async()=>{
  const f=await fixture();let release!:()=>void,next:JobManager|undefined;
  try{
    let reached!:()=>void,count=0;const entered=new Promise<void>(r=>reached=r),barrier=new Promise<void>(r=>release=r);
    const r=f.request();await f.manager.submit(r,async()=>{if(++count===2){reached();await barrier;}});await entered;
    const internal=f.manager as unknown as {persist(job:unknown):Promise<void>},original=internal.persist.bind(f.manager);let failed=false;
    internal.persist=async job=>{if(!failed){failed=true;throw Error("shutdown-publication-failure");}await original(job);};
    let settled=false;const closed=f.manager.close().then(()=>undefined,e=>e).finally(()=>settled=true);
    await wait(20);expect(settled).toBe(false);await expect(JobManager.create(f.root,f.authority,f.filesystem,Date.now)).rejects.toMatchObject({code:"job_conflict"});
    release();expect((await closed).code).toBe("job_interrupted");internal.persist=original;
    next=await JobManager.create(f.root,f.authority,f.filesystem,Date.now);expect(next.show(r.jobId).state).toBe("interrupted");
  }finally{release?.();await next?.close();await f.close().catch(()=>undefined);}
});

test("queued inputs are detached and reordered JSON fields do not create a second identity",async()=>{
  const f=await fixture();try{
    const first=f.request("setTimeout(()=>{},100)"),second=f.request("require('node:fs').writeFileSync('chosen.txt',process.env.VISIBLE)");second.environment.VISIBLE="original";
    await f.manager.submit(first);const pending=f.manager.submit(second);second.argv[2]="process.exit(1)";second.environment.VISIBLE="changed";await pending;
    expect((await f.manager.waitTerminal(second.jobId,3000)).state).toBe("succeeded");expect(await readFile(join(f.workspace,"chosen.txt"),"utf8")).toBe("original");
  }finally{await f.close();}
});
for(const lost of [false,true])test(`a parallel retained read waits for the original publication instead of signing an in-memory claim, lost=${lost}`,async()=>{
  const f=await fixture();let release!:()=>void;
  try{
    let entered!:()=>void,first=true;const reached=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
    const internal=f.manager as unknown as {publish(job:unknown):Promise<void>},original=internal.publish.bind(f.manager);
    internal.publish=async job=>{if(first){first=false;entered();await barrier;if(lost)throw Error("first-publication-lost");}await original(job);};
    const r=f.request(),submission=f.manager.submit(r).catch(e=>e);await reached;let observed=false;
    const read=f.manager.stableRecord(r.jobId).then(row=>{observed=true;return row;});await wait(10);expect(observed).toBe(false);
    release();await submission;const row=await read;expect(row?.state).toBe(lost?"unknown":"queued");
    if(!lost)await f.manager.waitTerminal(r.jobId,3000);internal.publish=original;
  }finally{release?.();if(lost)await expect(f.close()).rejects.toMatchObject({code:"job_interrupted"});else await f.close();}
});

test("terminal publication and cold logs remain readable without resetting identity or bytes",async()=>{
  const f=await fixture();let next:JobManager|undefined;
  try{
    const r=f.request("process.stdout.write('stable')");await f.manager.submit(r);await f.manager.waitTerminal(r.jobId,3000);await f.manager.close();
    const path=join(f.root,"jobs",r.jobId,"state.json"),before=await readFile(path);next=await JobManager.create(f.root,f.authority,f.filesystem,Date.now);
    expect((await next.submit(r)).state).toBe("succeeded");expect((await next.logsRead(r.jobId,0,65536,0)).complete).toBe(true);expect(await readFile(path)).toEqual(before);
  }finally{await next?.close();await f.close();}
});
test("uncertain admission publication retains the identity and never spawns or deletes retained evidence",async()=>{
  const f=await fixture();try{
    const internal=f.manager as unknown as {persist(job:unknown):Promise<void>},original=internal.persist.bind(f.manager);
    internal.persist=async job=>{await original(job);throw Error("acknowledgement-lost");};
    const r=f.request("require('node:fs').writeFileSync('not-dispatched.txt','bad')");
    await expect(f.manager.submit(r)).rejects.toMatchObject({code:"operation_outcome_unknown"});internal.persist=original;
    expect((await f.manager.submit(r)).state).toBe("unknown");await wait(25);await expect(readFile(join(f.workspace,"not-dispatched.txt"))).rejects.toMatchObject({code:"ENOENT"});
    expect((await readFile(join(f.root,"jobs",r.jobId,"state.json"),"utf8")).length).toBeGreaterThan(0);
  }finally{await f.close();}
});
test("timeouts and concurrent cancellation retain the actual child lifecycle and original cancellation UUID",async()=>{
  const f=await fixture();try{
    const running=f.request("setInterval(()=>{},1000)");running.runTimeoutMs=100;
    await f.manager.submit(running);const done=await f.manager.waitTerminal(running.jobId,7000);expect(done.state).toBe("failed");expect(done.reason).toBe("timeout");
    const first=f.request("setTimeout(()=>{},100)"),second=f.request();await f.manager.submit(first);await f.manager.submit(second);
    const id=randomUUID(),cancelled=await Promise.all([f.manager.cancel(second.jobId,id),f.manager.cancel(second.jobId,id),f.manager.cancel(second.jobId,id)]);
    for(const row of cancelled)expect(row).toMatchObject({state:"cancelled",cancelOperationId:id});
    await f.manager.waitTerminal(first.jobId,3000);
  }finally{await f.close();}
},10000);
test("retired CLI and daemon Job RPC cannot start another executor",async()=>{
  const f=await fixture(),gateway=await startMockGateway();let host;
  try{
    const discovery=join(f.root,"gateway.json");await writeFile(discovery,JSON.stringify({scheme:"http",host:"127.0.0.1",port:gateway.port,pid:gateway.pid,startedAt:gateway.startedAt,token:gateway.token}));
    host=await startDaemonHost({...createProductionDeps(),configDir:f.root,boxRuntimeRoot:f.root,discoveryPath:discovery,env:{}},join(f.root,"daemon.sock"));
    const api=new LocalDaemonClient(host.socketPath,2000),handshake=await api.handshake();expect(handshake.capabilities.some(c=>c.startsWith("host.process"))).toBe(false);
    for(const method of ["jobSubmit","jobCancel","jobShow","jobList","jobLogsRead"])await expect(api.call(method as never,{})).rejects.toBeDefined();
    await expect(api.call("eventRead", { channels: ["agents"], cursor: null, includeMemoryContent: false, limit: 1, sources: ["job"], waitMs: 0 })).rejects.toMatchObject({ code: "gateway_bad_request" });
    for(const args of [["exec","run","--","node"],["jobs","list"],["jobs","cancel",randomUUID()]])expect((await captureCli(args,{configDir:f.root,boxRuntimeRoot:f.root,env:{},fetch:Object.assign(async()=>{throw Error("no fallback");},{preconnect:()=>undefined})})).code).not.toBe(0);
  }finally{await host?.close();gateway.stop();await f.close();}
});
