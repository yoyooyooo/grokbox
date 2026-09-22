import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { publishConfigFile } from "@grokbox/box-runtime/runtime";
import { jobFixture, JOB_OWNER, JOB_READER, JOB_INSTALLATION as I } from "./job-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function jobBrowserJourney(t:TestContext,ports:Ports){
  async function withPage(run:(p:Page,f:Awaited<ReturnType<typeof jobFixture>>,origin:string)=>Promise<void>,token=JOB_OWNER){
    const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await jobFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url),context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),p=await context.newPage();
    const errors:string[]=[];p.setDefaultTimeout(12000);p.on("pageerror",e=>errors.push(e.message));
    try{
      const grant=(await f.client(token).createConsoleGrant(origin)).data;
      await p.goto(`${origin}/login`);await p.locator("#login-code").fill(grant.code);await p.getByRole("button",{name:"安全登录",exact:true}).click();await p.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
      const nativeReadsBeforeJobs=f.state.nativeReads; // The landing overview has its own Bot-list read.
      await p.goto(`${origin}/jobs`);await p.locator('[data-testid="job-composer"]').waitFor();await run(p,f,origin);assert.deepEqual(errors,[]);
      const html=await (await context.request.get(`${origin}/jobs`)).text();for(const secret of [JOB_OWNER,JOB_READER,grant.code])assert.ok(!html.includes(secret));assert.ok(!html.includes('"csrfToken"'));assert.equal(f.state.nativeReads,nativeReadsBeforeJobs);
    }finally{await context.close();await ports.stop(web.child);await f.close();}
  }
  const fill=async(p:Page,script:string)=>{await p.locator("#job-input").fill(JSON.stringify({argv:["node","-e",script],runTimeoutMs:10000}));await p.getByRole("checkbox",{name:"I authorize this OS Job and its external effects.",exact:true}).check();};
  await t.test("browser creates a real Job, reads explicit output and follows its original request receipt",async()=>withPage(async(p,f)=>{
    JSON.parse(await p.locator("#job-input").inputValue());
    await fill(p,"process.stdout.write('WEB_JOB_OK')");await p.getByRole("button",{name:"Start Job",exact:true}).click();await p.locator('[data-testid="job-submission"]').waitFor();
    const jobs=(await f.client().jobs()).data.jobs;assert.equal(jobs.length,1);await f.client().job(jobs[0]!.jobRef,{waitMs:1000});
    await p.getByRole("link",{name:"Inspect Job",exact:true}).click();await p.locator('[data-testid="job-detail"]').waitFor();
    await p.getByRole("button",{name:"Read Job output",exact:true}).click();await p.getByText("WEB_JOB_OK",{exact:true}).waitFor();
    await p.goto(`${new URL(p.url()).origin}/operations?domain=job&requestId=${jobs[0]!.requestId}`);await p.locator('[data-testid="operation-receipt"]').waitFor();assert.ok((await p.locator('[data-testid="operation-receipt"]').innerText()).includes("succeeded"));
    const storage=await p.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));assert.ok(!storage.includes("WEB_JOB_OK"));assert.ok(!storage.includes("expectedRevision"));assert.ok(!storage.includes("argv"));
    if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await p.screenshot({path:join(ports.evidence,"jobs-request-receipt.png"),fullPage:true});}
  }));
  await t.test("lost browser submission is recovered after reload with exactly one Job and one command effect",async()=>withPage(async(p,f)=>{
    let posts=0;await p.route("**/v1/job-starts",async route=>{posts++;const result=await route.fetch();assert.equal(result.status(),200);await route.abort("failed");});
    await fill(p,"require('node:fs').appendFileSync('browser-once.txt','x')");await p.getByRole("button",{name:"Start Job",exact:true}).click();await p.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();
    await p.reload();await p.getByRole("button",{name:"Recover original Job",exact:true}).waitFor();assert.equal(await p.getByRole("button",{name:"Start Job",exact:true}).isDisabled(),true);
    await p.getByRole("button",{name:"Recover original Job",exact:true}).click();await p.locator('[data-testid="job-submission"]').waitFor();assert.equal(posts,1);assert.equal((await f.client().jobs()).data.jobs.length,1);assert.equal(await readFile(join(f.workspace,"browser-once.txt"),"utf8"),"x");
    await p.unroute("**/v1/job-starts");
  }));
  await t.test("stale policy refuses without erasing the draft or silently adopting a new approval",async()=>withPage(async(p,f)=>{
    const source="process.stdout.write('KEEP_THIS_DRAFT')";await fill(p,source);const draft=await p.locator("#job-input").inputValue();
    f.config.daemon!.process!.environment.push("NEW_POLICY");await publishConfigFile(join(f.root,"config.json"),f.config);
    await p.getByRole("button",{name:"Start Job",exact:true}).click();await p.getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();assert.equal(await p.locator("#job-input").inputValue(),draft);assert.equal((await f.client().jobs()).data.jobs.length,0);
    await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(ports.evidence)await p.screenshot({path:join(ports.evidence,"jobs-policy-conflict-mobile.png"),fullPage:true});
  }));
  await t.test("browser cancellation retains its original request and never reports reverted external effects",async()=>withPage(async(p,f,origin)=>{
    const policy=(await f.client().jobPolicy()).data,common={expectedRevision:policy.revision!,confirmed:true as const,environment:{},cwd:"workspace:/",runTimeoutMs:10000,output:"discard" as const,shell:false};
    const first=(await f.client().startJob({...common,requestId:randomUUID(),argv:["node","-e","const t=setInterval(()=>{if(require('node:fs').existsSync('release-first'))clearInterval(t)},5);setTimeout(()=>process.exit(0),8000).unref()"]})).data;
    const queued=(await f.client().startJob({...common,requestId:randomUUID(),argv:["node","-e","require('node:fs').writeFileSync('browser-cancelled.txt','bad')"]})).data;
    await p.goto(`${origin}/jobs?selected=${encodeURIComponent(queued.jobRef)}`);await p.locator('[data-testid="job-detail"]').waitFor();await p.getByRole("checkbox",{name:"I authorize cancellation of this Job.",exact:true}).check();
    await p.getByRole("button",{name:"Cancel Job",exact:true}).click();await p.locator('[data-testid="job-cancellation"]').waitFor();assert.ok((await p.locator('[data-testid="job-cancellation"]').innerText()).includes("not reverted"));
    await p.reload();await p.getByRole("button",{name:"Recover original cancellation",exact:true}).click();await p.locator('[data-testid="job-cancellation"]').waitFor();
    await p.getByRole("link",{name:"View cancellation receipt",exact:true}).click();await p.locator('[data-testid="operation-receipt"]').waitFor();assert.ok(p.url().includes("domain=job-cancel"));
    assert.equal((await f.client().job(queued.jobRef)).data.state,"cancelled");await writeFile(join(f.workspace,"release-first"),"release");await f.client().job(first.jobRef,{waitMs:2000});
    await assert.rejects(readFile(join(f.workspace,"browser-cancelled.txt")),{code:"ENOENT"});
  }));
  await t.test("read-only browsers cannot start, cancel or fetch output; an owner still needs CSRF",async()=>{
    await withPage(async(p,f)=>{assert.equal(await p.getByRole("button",{name:"Start Job",exact:true}).isDisabled(),true);assert.equal((await f.client().jobs()).data.jobs.length,0);},JOB_READER);
    await withPage(async(p,f,origin)=>{
      const policy=(await f.client().jobPolicy()).data;
      const response=await p.context().request.post(`${origin}/v1/job-starts`,{headers:{origin,"x-grokbox-installation-id":I},data:{requestId:randomUUID(),expectedRevision:policy.revision,confirmed:true,argv:["node","-e","process.exit(0)"],runTimeoutMs:1000}});
      assert.equal(response.status(),403);assert.equal((await f.client().jobs()).data.jobs.length,0);
    });
  });
}
