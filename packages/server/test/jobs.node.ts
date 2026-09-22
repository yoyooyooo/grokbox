import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type JobStart, type JobView } from "@grokbox/client";
import { JobManager, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { jobFixture, JOB_OWNER, JOB_READER, JOB_OTHER, JOB_INSTALLATION as I } from "../../../apps/web/test/job-fixture.ts";
const rejects=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>!!e&&typeof e==="object"&&"code"in e&&e.code===code);
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function input(f:Awaited<ReturnType<typeof jobFixture>>,script="process.stdout.write('done')"):Promise<JobStart>{
  const policy=(await f.client().jobPolicy()).data;assert.equal(policy.state,"ready");
  return {requestId:randomUUID(),expectedRevision:policy.revision!,confirmed:true,argv:["node","-e",script],environment:{},cwd:"workspace:/",runTimeoutMs:5000,output:"capture",shell:false};
}
async function finish(api:ManagementClient,job:JobView){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){const row=(await api.job(job.jobRef,{waitMs:1000})).data;if(!["queued","running"].includes(row.state))return row;}
  throw Error("job_test_deadline");
}
async function cli(f:Awaited<ReturnType<typeof jobFixture>>,args:string[]){
  const entry=process.env.GROKBOX_TEST_CLI_ENTRY;assert.ok(entry);
  const child=spawn("node",[entry,...args],{cwd:f.root,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root,GROKBOX_CONFIG_DIR:f.root,GROKBOX_BOX_RUNTIME_ROOT:f.root,SYNTHETIC_JOB_CREDENTIAL:JOB_OWNER}});
  let out="",err="";child.stdout.on("data",b=>{out+=b;if(out.length>512*1024)child.kill("SIGKILL");});child.stderr.on("data",b=>{err+=b;});
  const timer=setTimeout(()=>child.kill("SIGKILL"),15000);const [code,signal]=await once(child,"close");clearTimeout(timer);
  assert.equal(signal,null);assert.equal(err,"");assert.ok(!out.includes(JOB_OWNER));return {code,value:JSON.parse(out)};
}

test("real managed Job uses literal argv and bounded binary output, no task body or environment is stored in the receipt",async()=>{
  const f=await jobFixture();try{
    const r=await input(f,"process.stdout.write(Buffer.from([0,255,10]));process.stderr.write(process.argv[1]);");r.argv.push("literal;$(no-expand)");r.environment={VISIBLE:"PRIVATE_VALUE_NOT_FOR_RECEIPT"};
    const submitted=(await f.client().startJob(r)).data,done=await finish(f.client(),submitted);assert.equal(done.state,"succeeded");assert.equal(done.exitCode,0);
    const logs=(await f.client().jobLogs(done.jobRef)).data;assert.ok(logs.complete);const bytes=Buffer.concat(logs.events.map(e=>Buffer.from(e.contentBase64,"base64")));
    assert.ok(bytes.includes(Buffer.from([0,255,10])));assert.ok(bytes.includes(Buffer.from("literal;$(no-expand)")));
    const raw=await readFile(join(f.root,"jobs",done.jobRef.split(":")[2]!,"state.json"),"utf8");assert.ok(!raw.includes(r.argv[2]!));assert.ok(!raw.includes(r.environment.VISIBLE!));
    assert.equal(f.state.nativeReads,0);assert.equal((await f.client().jobPolicy()).data.filesystemSandbox,false);
  }finally{await f.close();}
});
test("original request identity is single-dispatch across concurrency, restart, changed policy and missing configuration",async()=>{
  for(let iteration=0;iteration<10;iteration++) { const f=await jobFixture();try{
    const r=await input(f,"require('node:fs').appendFileSync('effects.txt','x')");
    const rows=await Promise.all([f.client().startJob(r),f.client().startJob(r)]);assert.equal(rows[0]!.data.jobRef,rows[1]!.data.jobRef);
    const done=await finish(f.client(),rows[0]!.data);await rejects(f.client().startJob({...r,argv:["node","-e","throw Error()"]}),"idempotency_conflict");
    await f.restart();
    let replay: JobView;
    try { replay = (await f.client().startJob(r)).data; }
    catch (error) {
      // A pooled connection can be reset by the deliberately restarted listener.
      // This is not permission to repeat the POST or claim a successful reply.
      // Accept only the observed reset, require the client's original unknown
      // locator, then independently read the existing durable operation.
      assert.equal(f.state.transportFailures.at(-1)?.cause, "ECONNRESET");
      assert.equal(f.state.transportFailures.at(-1)?.method, "POST");
      assert.equal((error as { code?: string }).code, "operation_unknown");
      assert.equal((error as { details?: { requestId?: string } }).details?.requestId, r.requestId);
      replay = (await f.client().jobOperation(r.requestId)).data;
    }
    assert.equal(replay.state,"succeeded");assert.equal(replay.observation,"retained-record");
    assert.equal(await readFile(join(f.workspace,"effects.txt"),"utf8"),"x");
    await rejects(f.client().startJob({...r,requestId:randomUUID()}),"revision_conflict");
    await writeFile(join(f.root,"config.json"),"{invalid",{mode:0o600});
    assert.equal((await f.client().jobOperation(r.requestId)).data.jobRef,done.jobRef);assert.equal((await f.client().startJob(r)).data.state,"succeeded");
    assert.equal((await f.client().jobLogs(done.jobRef)).data.complete,true);
  }finally{await f.close();} }
});
test("Jobs and cancellation history are principal-scoped; execution, shell, output and reads have separate permissions",async()=>{
  const f=await jobFixture();try{
    const r=await input(f);await rejects(f.client(JOB_READER).startJob(r),"permission_denied");
    const job=(await f.client().startJob(r)).data;await finish(f.client(),job);
    assert.equal((await f.client(JOB_READER).job(job.jobRef)).data.requestId,r.requestId);
    await rejects(f.client(JOB_READER).jobLogs(job.jobRef),"permission_denied");await rejects(f.client(JOB_OTHER).job(job.jobRef),"not_found");
    await rejects(f.client(JOB_OTHER).jobOperation(r.requestId),"not_found");assert.deepEqual((await f.client(JOB_OTHER).jobs()).data.jobs,[]);
    const other=(await f.client(JOB_OTHER).startJob(r)).data;assert.notEqual(other.jobRef,job.jobRef);await finish(f.client(JOB_OTHER),other);
    await rejects(f.client().startJob({...await input(f),shell:true,argv:["echo no-shell"]}),"permission_denied");
    await rejects(f.client().startJob({...await input(f),environment:{NODE_OPTIONS:"--require arbitrary"}}),"permission_denied");assert.equal(f.state.nativeReads,0);
  }finally{await f.close();}
});
test("list and exact reads cannot expose a successful terminal before its original publication settles", async () => {
  const f = await jobFixture();
  const owner = JobManager.prototype as unknown as { publish(job: { scope: { requestId: string }; state: string }): Promise<void> };
  const publish = owner.publish;
  let release!: () => void;
  try {
    const r = await input(f, "setTimeout(()=>process.exit(0),200)");
    let reached!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    owner.publish = async function(job) {
      if (job.scope.requestId === r.requestId && job.state === "succeeded") { reached(); await gate; }
      return publish.call(this, job);
    };
    const submitted = (await f.client().startJob(r)).data;
    await entered;
    let listSettled = false, exactSettled = false;
    const listed = f.client().jobs().finally(() => { listSettled = true; });
    const exact = f.client().job(submitted.jobRef).finally(() => { exactSettled = true; });
    // Ensure any failure releases the production writer and settles both readers.
    try {
      await delay(30);
      assert.equal(listSettled, false, "List exposed unpublished terminal state");
      assert.equal(exactSettled, false, "Exact read exposed unpublished terminal state");
    } finally { release(); await Promise.all([listed, exact]); }
    assert.equal((await listed).data.jobs[0]!.state, "succeeded");
    assert.equal((await exact).data.state, "succeeded");
  } finally { release?.(); owner.publish = publish; await f.close(); }
});

test("concurrent active history reads observe completed publications while the original log writer keeps renaming", async () => {
  const f = await jobFixture();
  try {
    const r = await input(f, "let n=0;const t=setInterval(()=>{process.stdout.write('entry-'+(++n)+'\\n');if(n===80)clearInterval(t)},2)");
    const submitted = (await f.client().startJob(r)).data;
    for (let iteration = 0; iteration < 40; iteration++) {
      const [listed, exact] = await Promise.all([f.client().jobs(), f.client().job(submitted.jobRef)]);
      assert.equal(listed.data.jobs.length, 1);
      assert.equal(listed.data.jobs[0]!.jobRef, submitted.jobRef);
      for (const row of [listed.data.jobs[0]!, exact.data]) {
        assert.equal(row.requestId, r.requestId);
        assert.equal(row.logs.bytes, row.logs.nextOffset);
        if (row.state === "succeeded") assert.equal(row.exitCode, 0);
      }
    }
    const done = await finish(f.client(), submitted); assert.equal(done.state, "succeeded");
    const logs = (await f.client().jobLogs(done.jobRef)).data;
    assert.ok(Buffer.concat(logs.events.map(event => Buffer.from(event.contentBase64, "base64"))).includes(Buffer.from("entry-80")));
    assert.equal((await f.client().jobs()).data.jobs.length, 1);
  } finally { await f.close(); }
});

test("queued Job rechecks current policy before dispatch and cannot retain revoked future authority",async()=>{
  const f=await jobFixture();try{
    const running=(await f.client().startJob(await input(f,"const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release-queue'))clearInterval(t)},5);setTimeout(()=>process.exit(0),4000).unref()"))).data;
    const waiting=(await f.client().startJob(await input(f,"require('node:fs').writeFileSync('not-allowed.txt','bad')"))).data;
    f.config.daemon!.process!.environment.push("NEW_POLICY");await publishConfigFile(join(f.root,"config.json"),f.config);
    assert.equal((await f.client().jobPolicy()).data.state,"restart-required");
    await writeFile(join(f.workspace,"release-queue"),"release");await finish(f.client(),running);const stopped=await finish(f.client(),waiting);assert.equal(stopped.state,"failed");
    assert.ok(!(await readdir(f.workspace)).includes("not-allowed.txt"));
  }finally{await f.close();}
});
test("permission revoked while queued prevents spawn, not merely HTTP access",async()=>{
  const f=await jobFixture();try{
    const first=(await f.client().startJob(await input(f,"const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release-queue'))clearInterval(t)},5);setTimeout(()=>process.exit(0),4000).unref()"))).data;
    const second=(await f.client().startJob(await input(f,"require('node:fs').writeFileSync('revoked.txt','bad')"))).data;
    f.state.grants[0]!.capabilities=f.state.grants[0]!.capabilities.filter(c=>c!=="jobs.start");
    await writeFile(join(f.workspace,"release-queue"),"release");await finish(f.client(),first);assert.equal((await finish(f.client(),second)).state,"failed");assert.ok(!(await readdir(f.workspace)).includes("revoked.txt"));
  }finally{await f.close();}
});
test("lost client response is recovered by request without restarting execution",async()=>{
  const f=await jobFixture();try{
    let posts=0;const r=await input(f,"require('node:fs').appendFileSync('once.txt','x')");
    const lost=new ManagementClient({baseUrl:f.server.url,installationId:I,credential:async()=>JOB_OWNER,fetch:Object.assign(async(u:string|URL|Request,init?:RequestInit)=>{
      const response=await fetch(u,init);if(init?.method==="POST"){posts++;await response.arrayBuffer();throw Error("lost");}return response;
    },{preconnect:()=>undefined}) as typeof fetch});
    await rejects(lost.startJob(r),"operation_unknown");const original=(await f.client().jobOperation(r.requestId)).data;await finish(f.client(),original);
    assert.equal(posts,1);assert.equal(await readFile(join(f.workspace,"once.txt"),"utf8"),"x");
  }finally{await f.close();}
});
test("queued cancellation owns the original UUID and cannot be replaced by another cancel request",async()=>{
  const f=await jobFixture();try{
    const first=(await f.client().startJob(await input(f,"const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release-queue'))clearInterval(t)},5);setTimeout(()=>process.exit(0),4000).unref()"))).data;
    const second=(await f.client().startJob(await input(f,"require('node:fs').writeFileSync('cancelled.txt','bad')"))).data;
    const requestId=randomUUID(),cancel={jobRef:second.jobRef,requestId,confirmed:true as const};const result=(await f.client().cancelJob(cancel)).data;
    assert.equal(result.job.state,"cancelled");assert.equal(result.state,"settled");assert.equal(result.effectsReverted,false);
    assert.deepEqual((await f.client().cancelJob(cancel)).data,result);await rejects(f.client().cancelJob({...cancel,requestId:randomUUID()}),"idempotency_conflict");
    await writeFile(join(f.workspace,"release-queue"),"release");await finish(f.client(),first);assert.ok(!(await readdir(f.workspace)).includes("cancelled.txt"));
    await f.restart();assert.equal((await f.client().jobCancellation(second.jobRef,requestId)).data.state,"settled");
  }finally{await f.close();}
});
test("running cancellation and graceful server shutdown await real child settlement without losing the original action",async()=>{
  const f=await jobFixture();try{
    const job=(await f.client().startJob(await input(f,"process.stdout.write('ready');setInterval(()=>{},1000)"))).data;
    for(let n=0;n<100&&(await f.client().job(job.jobRef)).data.state!=="running";n++)await delay(5);
    const requestId=randomUUID();await f.client().cancelJob({jobRef:job.jobRef,requestId,confirmed:true});
    const done=await finish(f.client(),job);assert.equal(done.state,"cancelled");assert.equal(done.cancelOperationId,requestId);
    const path=join(f.root,"jobs",job.jobRef.split(":")[2]!,"state.json");await f.server.close();const before=await readFile(path);await delay(30);assert.deepEqual(await readFile(path),before);
  }finally{await f.close();}
});
test("bounded output drains without blocking execution, and altered log evidence never resets the receipt",async()=>{
  const f=await jobFixture();try{
    const job=(await f.client().startJob(await input(f,"process.stdout.write('x'.repeat(1048576))"))).data;
    const done=await finish(f.client(),job);assert.equal(done.state,"succeeded");assert.equal(done.logs.truncated,true);assert.ok(done.logs.bytes<=131072);
    let offset=0,total=0;for(let n=0;n<8;n++){const page=(await f.client().jobLogs(job.jobRef,{offset})).data;total+=page.nextOffset-offset;offset=page.nextOffset;if(page.complete)break;}
    assert.equal(total,done.logs.bytes);
    await f.server.close();const path=join(f.root,"jobs",job.jobRef.split(":")[2]!,"state.json"),before=await readFile(path);
    await writeFile(join(f.root,"jobs",job.jobRef.split(":")[2]!,"logs.ndjson"),"bad",{mode:0o600});await f.restart();
    await rejects(f.client().jobLogs(job.jobRef),"source_unavailable");assert.deepEqual(await readFile(path),before);assert.equal((await f.client().job(job.jobRef)).data.state,"succeeded");
  }finally{await f.close();}
});
test("SIGKILL of the packed Server preserves both started and queued Job identities as unknown without re-dispatch",async()=>{
  const f=await jobFixture();let child:ReturnType<typeof spawn>|undefined,closed:Promise<unknown>|undefined,started=false;
  const marker=async(name:string)=>readFile(join(f.workspace,name),"utf8").catch(()=>"");
  const until=async(check:()=>Promise<boolean>)=>{const end=Date.now()+7000;while(!await check()){if(Date.now()>end)throw Error("crash_fixture_deadline");await delay(5);}};
  try{
    await f.server.close();const entry=process.env.GROKBOX_JOB_CRASH_ENTRY;assert.ok(entry);
    child=spawn("node",[entry,f.root,"owned-job-fixture"],{cwd:f.root,stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:f.root}});closed=once(child,"close");child.stderr!.resume();
    const url=await new Promise<string>((resolve,reject)=>{let out="";const timer=setTimeout(()=>reject(Error("server_not_ready")),5000);child!.once("error",reject);child!.stdout!.on("data",b=>{out+=b;if(out.includes("\n")){clearTimeout(timer);try{resolve(JSON.parse(out.split("\n")[0]!).url);}catch(e){reject(e);}}});});
    const api=new ManagementClient({baseUrl:url,installationId:I,credential:async()=>JOB_OWNER}),policy=(await api.jobPolicy()).data;
    const r:JobStart={requestId:randomUUID(),expectedRevision:policy.revision!,confirmed:true,argv:["node","-e","const fs=require('node:fs');fs.appendFileSync('crash-effects','x');const t=setInterval(()=>{if(fs.existsSync('release-crash')){fs.writeFileSync('crash-finished','done');clearInterval(t)}},5);setTimeout(()=>process.exit(0),6000).unref()"],environment:{},cwd:"workspace:/",output:"discard",shell:false,runTimeoutMs:10000};
    const first=(await api.startJob(r)).data;await until(async()=>await marker("crash-effects")==="x");started=true;
    const secondInput={...r,requestId:randomUUID(),argv:["node","-e","require('node:fs').writeFileSync('not-replayed','bad')"]},second=(await api.startJob(secondInput)).data;assert.equal(second.state,"queued");
    child.kill("SIGKILL");await closed;child=undefined;await f.restart();
    assert.equal((await f.client().jobOperation(r.requestId)).data.state,"unknown");assert.equal((await f.client().jobOperation(secondInput.requestId)).data.state,"unknown");
    await rejects(f.client().startJob(r),"operation_unknown");await rejects(f.client().startJob(secondInput),"operation_unknown");
    await writeFile(join(f.workspace,"release-crash"),"release");await until(async()=>await marker("crash-finished")==="done");
    assert.equal(await marker("crash-effects"),"x");assert.equal(await marker("not-replayed"),"");assert.equal((await f.client().job(first.jobRef)).data.state,"unknown");
    assert.equal((await f.client().jobLogs(first.jobRef)).data.complete,false);
  }finally{
    if(child){child.kill("SIGKILL");await closed;}
    if(started){await writeFile(join(f.workspace,"release-crash"),"release");await until(async()=>await marker("crash-finished")==="done");}
    await f.close();
  }
});

test("actual packed CLI starts, waits, reads logs and recovers the original request via management",async()=>{
  const f=await jobFixture();try{
    const policy=await cli(f,["job","policy"]);assert.equal(policy.code,0);
    const requestId=randomUUID(),file=join(f.root,"input.json");await writeFile(file,JSON.stringify({argv:["node","-e","process.stdout.write('CLI_JOB_OK')"],runTimeoutMs:3000}),{mode:0o600});
    const sent=await cli(f,["job","start","--input",`@${file}`,"--request-id",requestId,"--expect-revision",policy.value.data.revision,"--confirm"]);
    assert.equal(sent.code,0);const ref=sent.value.data.jobRef;
    const waited=await cli(f,["job","wait",ref,"--wait-ms","1000"]);assert.equal(waited.code,0);assert.equal(waited.value.data.state,"succeeded");
    const logs=await cli(f,["job","logs",ref]);assert.equal(logs.code,0);assert.ok(logs.value.data.complete);
    const original=await cli(f,["operation","get","--domain","job","--request-id",requestId]);assert.equal(original.value.data.jobRef,ref);
  }finally{await f.close();}
});
