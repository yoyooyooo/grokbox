import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { hostHealthFixture,H_OWNER,H_READER,H_INSTALL } from "./host-health-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function hostHealthBrowserJourney(t:TestContext,ports:Ports){
 async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof hostHealthFixture>>,origin:string)=>Promise<void>,token=H_OWNER,badRecipe=false){
  const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await hostHealthFixture(origin,{badRecipe});
  const web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url),context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.setDefaultTimeout(12000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{const grant=(await f.client(token).createConsoleGrant(origin)).data;
   await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
   await page.goto(`${origin}/host-health`);await page.getByRole("heading",{name:"Host patch health",exact:true}).waitFor();const nativeBefore=f.state.nativeCalls;await run(page,f,origin);assert.equal(f.state.nativeCalls,nativeBefore);assert.deepEqual(errors,[]);
   const html=await (await context.request.get(page.url())).text();for(const secret of [H_OWNER,grant.code,f.root,"createSession(onRequestId",'"csrfToken"'])assert.ok(!html.includes(secret));
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
 await t.test("reader cannot reveal health evidence and the console exposes no health mutation endpoint",()=>withPage(async(page,f,origin)=>{
  await page.getByRole("alert").filter({hasText:"permission_denied"}).waitFor();assert.equal(await page.locator('[data-testid="host-health-candidate"]').count(),0);
  const response=await page.context().request.post(`${origin}/v1/host-health`,{headers:{origin,"x-grokbox-installation-id":H_INSTALL},data:{refresh:true}});assert.equal(response.status(),404);
 },H_READER));
}
