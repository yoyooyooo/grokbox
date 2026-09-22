import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { launchPublicHost, preparePublicHost, stopPublicHost } from "./host-compilation-fixture.ts";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { hostHealthFixture,H_OWNER,H_READER,H_INSTALL } from "./host-health-fixture.ts";
import { hostWitnessFixture } from "./host-witness-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function hostHealthBrowserJourney(t:TestContext,ports:Ports){
 async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof hostHealthFixture>>,origin:string)=>Promise<void>,token=H_OWNER,badRecipe=false){
  const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await hostHealthFixture(origin,{badRecipe});
  const web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url),context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.setDefaultTimeout(12000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{const grant=(await f.client(token).createConsoleGrant(origin)).data;
   await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
   await page.goto(`${origin}/host-health`);await page.getByRole("heading",{name:"Host patch health",exact:true}).waitFor();
   const navPaths=await page.locator('[data-testid="console-nav"] a').evaluateAll(links=>links.map(link=>new URL(link.getAttribute("href")??"",location.origin).pathname));
   assert.deepEqual(navPaths,["/","/bots","/models","/observation","/events","/incidents","/operations","/host-health","/materials","/files","/notifications","/notification-setup","/protection","/contexts","/lifecycles","/desktop","/jobs"]);
   const nativeBefore=f.state.nativeCalls;await run(page,f,origin);assert.equal(f.state.nativeCalls,nativeBefore);assert.deepEqual(errors,[]);
   const html=await (await context.request.get(page.url())).text();for(const secret of [H_OWNER,grant.code,f.root,"createSession(onRequestId","PRIVATE_RUNTIME_HOST_FAULT",'"csrfToken"'])assert.ok(!html.includes(secret));
  }finally{await context.close();await ports.stop(web.child);await f.close();}
 }
 await t.test("production health page separates candidate checks, missing runtime witnesses and local-only delivery",()=>withPage(async(page,f)=>{
  for(let i=0;i<40;i++){if((await f.client().hostHealth()).data.latest?.analysis==="passed")break;await new Promise(r=>setTimeout(r,50));}
  await page.getByRole("button",{name:"Refresh health observations",exact:true}).click();await page.locator('[data-testid="host-health-candidate"]').waitFor();
  assert.ok((await page.locator('[data-testid="host-health-candidate"]').innerText()).includes("degraded"));assert.ok((await page.locator('[data-testid="host-health-runtime"]').innerText()).includes("not-observed"));
  assert.ok((await page.locator('[data-testid="host-health-observer"]').innerText()).includes("Local-only"));
  const attempts=f.state.pids.length;await page.reload();await page.locator('[data-testid="host-health-candidate"]').waitFor();assert.equal(f.state.pids.length,attempts);
  // Lose focus before screenshots so the keyboard skip link does not obscure metadata.
  await page.locator("h1").click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await page.screenshot({path:join(ports.evidence,"host-health-mobile.png"),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(ports.evidence,"host-health-desktop.png"),fullPage:true});}
 }));
 await t.test("candidate mismatch is queryable as an installation incident rather than a green empty Bot roster",()=>withPage(async(page,f)=>{
  for(let i=0;i<40;i++){if((await f.client().hostHealth()).data.intake==="committed")break;await new Promise(r=>setTimeout(r,50));}
  await page.getByRole("button",{name:"Refresh health observations",exact:true}).click();await page.locator('[data-testid="host-health-candidate"]').waitFor();
  assert.ok((await page.locator('[data-testid="host-health-candidate"]').innerText()).includes("mismatch"));
  await page.getByRole("link",{name:"Inspect persistent incidents",exact:true}).click();await page.getByText("host_patch_health",{exact:true}).first().waitFor();
 },H_OWNER,true));
 await t.test("runtime card follows the exact sampled process while disk generations and later exit stay separate",()=>withPage(async(page,f)=>{
  const source=await preparePublicHost(f),host=await launchPublicHost(f);
  try{
   for(let i=0;i<100;i++){const v=(await f.client().hostHealth()).data;if(v.runtime?.state==="current"&&v.latest?.analysis==="passed")break;await new Promise(r=>setTimeout(r,30));}
   await page.reload();await page.locator('[data-testid="host-health-runtime"]').waitFor();
   const card=page.locator('[data-testid="host-health-runtime"]');assert.ok((await card.innerText()).includes("same-generation"));assert.ok((await card.innerText()).includes("applied"));
   await writeFile(f.paths.source,source+"// another on-disk generation\n");
   for(let i=0;i<100;i++){if((await f.client().hostHealth()).data.latest?.applicability==="mismatch")break;await new Promise(r=>setTimeout(r,30));}
   await page.getByRole("button",{name:"Refresh health observations",exact:true}).click();await page.getByText("Different generations; existing execution is not stopped",{exact:true}).waitFor();
   assert.equal(host.child.exitCode,null);assert.ok((await card.innerText()).includes("Not established"));
   await page.locator("h1").click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(ports.evidence){await page.screenshot({path:join(ports.evidence,"host-runtime-mobile.png"),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(ports.evidence,"host-runtime-desktop.png"),fullPage:true});}
   await stopPublicHost(host.child);for(let i=0;i<100;i++){if((await f.client().hostHealth()).data.runtime?.state==="historical")break;await new Promise(r=>setTimeout(r,30));}
   await page.reload();await page.locator('[data-testid="host-health-runtime"]').waitFor();assert.ok((await card.innerText()).includes("historical"));
  }finally{await stopPublicHost(host.child);}
 }));
 await t.test("a real failed public Host module stays visible after refresh and links to the persistent incident",()=>withPage(async(page,f)=>{
  await preparePublicHost(f,'throw new Error("PRIVATE_RUNTIME_HOST_FAULT");');const host=await launchPublicHost(f);
  try{
   for(let i=0;i<100;i++){const v=(await f.client().hostHealth()).data;if(v.runtime?.receipt?.nativeCompilation==="threw"&&v.runtimeIntake==="committed")break;await new Promise(r=>setTimeout(r,30));}
   await page.reload();await page.locator('[data-testid="host-health-runtime"]').waitFor();assert.ok((await page.locator('[data-testid="host-health-runtime"]').innerText()).includes("native-compile-failed"));
   assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE_RUNTIME_HOST_FAULT"));
   await page.getByRole("link",{name:"Inspect persistent incidents",exact:true}).click();await page.getByText("host_patch_health",{exact:true}).first().waitFor();
  }finally{await stopPublicHost(host.child);}
 }));
 await t.test("real native challenges and recorded hook boundaries render without a whole-path success claim",async()=>{
  const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await hostWitnessFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
  const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const wait=async(ok:(v:Awaited<ReturnType<ReturnType<typeof f.client>["hostHealth"]>>["data"])=>boolean)=>{for(let i=0;i<150;i++){if(ok((await f.client().hostHealth()).data))return;await new Promise(r=>setTimeout(r,30));}throw Error("browser-witness-deadline");};
  try{
   const grant=(await f.client().createConsoleGrant(origin)).data;await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
   const nativeBefore=f.state.nativeCalls; // The preceding overview may try its own Bot list.
   await wait(v=>v.witness?.state==="current");await page.goto(`${origin}/host-health`);await page.locator('[data-testid="host-health-witness"]').waitFor();
   assert.ok((await page.locator('[data-testid="host-health-witness"]').innerText()).includes("present"));assert.ok((await page.locator('[data-testid="host-health-witness-events"]').innerText()).includes("No execution boundary"));
   await f.control("exercise");await wait(v=>!!v.witness?.snapshot?.events.length);await page.getByRole("button",{name:"Refresh health observations",exact:true}).click();await page.getByText("session · native-selected",{exact:true}).waitFor();
   await f.control("replace");await wait(v=>v.witness?.snapshot?.capabilities[0]?.handles==="changed");await page.reload();await page.locator('[data-testid="host-health-witness"]').waitFor();assert.ok((await page.locator('[data-testid="host-health-witness"]').innerText()).includes("changed"));
   assert.ok((await page.locator('[data-testid="host-health-runtime"]').innerText()).includes("Not established"));
   await page.locator("h1").click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(ports.evidence){await page.screenshot({path:join(ports.evidence,"host-witness-mobile.png"),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(ports.evidence,"host-witness-desktop.png"),fullPage:true});}
   f.probeState.decorate=r=>({...r,value:null});await wait(v=>v.witness?.state==="invalid");await page.reload();await page.locator('[data-testid="host-health-witness"]').waitFor();assert.ok((await page.locator('[data-testid="host-health-witness"]').innerText()).includes("invalid-reply"));assert.equal(await page.getByText("session · native-selected",{exact:true}).count(),0);
   const html=await (await context.request.get(page.url())).text();for(const secret of [H_OWNER,grant.code,f.root,"synthetic-witness-native","PRIVATE",'"csrfToken"'])assert.ok(!html.includes(secret));
   assert.equal(f.state.nativeCalls,nativeBefore,"health page must not query the Bot roster");assert.deepEqual(errors,[]);
  }finally{await context.close();await ports.stop(web.child);await f.close();}
 });
 await t.test("managed lease opportunities are shown as a bounded direct window and remain distinct from persistent failure history",async()=>{
  const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await hostWitnessFixture(origin,{},"route"),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
  const context=await ports.browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(12000);
  const wait=async(ok:()=>Promise<boolean>)=>{for(let i=0;i<150;i++){if(await ok())return;await new Promise(r=>setTimeout(r,30));}throw Error("browser-opportunity-deadline");};
  try{
   const grant=(await f.client().createConsoleGrant(origin)).data;await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
   await wait(async()=> (await f.client().hostHealth()).data.witness?.state==="current");
   await f.control("managed-stream",{lease:false});await wait(async()=>!!(await f.client().hostHealth()).data.witness?.snapshot?.events.some(e=>e.stage==="managed-stream-lease-missing"));
   await page.goto(`${origin}/host-health`);const card=page.locator('[data-testid="host-health-opportunities"]');await card.waitFor();
   assert.ok((await card.innerText()).includes("violated"));assert.ok((await card.innerText()).includes("0 present · 1 missing"));assert.ok((await card.innerText()).includes("managed-main-stream-entry"));
   const pid=f.process.child.pid;await page.reload();await card.waitFor();assert.equal(f.process.child.pid,pid);assert.ok((await card.innerText()).includes("1 missing"));
   // Ring eviction can happen in an intermediate sample of this burst. The
   // page is read-on-refresh, not a subscription: wait for the actual final
   // cumulative fact before expecting that exact count in its one read.
   await f.control("managed-stream",{lease:true,count:12});await wait(async()=>{const s=(await f.client().hostHealth()).data.witness?.snapshot;return !!s&&s.leaseOpportunity.observed===13&&s.leaseOpportunity.missing===1&&s.eventsDropped>0&&!s.events.some(e=>e.stage==="managed-stream-lease-missing");});
   await page.getByRole("button",{name:"Refresh health observations",exact:true}).click();await card.getByText("13 direct checks · 1 missing leases",{exact:true}).waitFor();
   assert.equal(await card.getByText("violated",{exact:true}).count(),1);assert.ok((await card.innerText()).includes("First retained missing lease"));
   assert.ok((await page.locator('[data-testid="host-health-witness-events"]').innerText()).includes("do not repair a known violation"));
   await page.locator("h1").click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(ports.evidence)await page.screenshot({path:join(ports.evidence,"host-opportunities-mobile.png"),fullPage:true});
   assert.equal(f.process.child.exitCode,null);assert.equal((await f.control("stats")).nativeReads,0);
  }finally{await context.close();await ports.stop(web.child);await f.close();}
 });
 await t.test("reader cannot reveal health evidence and the console exposes no health mutation endpoint",()=>withPage(async(page,f,origin)=>{
  await page.getByRole("alert").filter({hasText:"permission_denied"}).waitFor();assert.equal(await page.locator('[data-testid="host-health-candidate"]').count(),0);
  const response=await page.context().request.post(`${origin}/v1/host-health`,{headers:{origin,"x-grokbox-installation-id":H_INSTALL},data:{refresh:true}});assert.equal(response.status(),404);
 },H_READER));
}
