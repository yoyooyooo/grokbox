import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { handoverFixture, H_OWNER, H_READER, H_INSTALL, H_SCOPE, H_SOURCE } from "./handover-fixture.ts";
type Fixture=Awaited<ReturnType<typeof handoverFixture>>;
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
const editor=(page:Page)=>page.locator('[data-testid="handover-editor"]');
const result=(page:Page)=>page.locator('[data-testid="handover-result"]');
const writes=(f:Fixture)=>f.state.calls.filter(c=>/\/(updateAgent|sendPrompt|setGroupMembers|createAgentAutomation|setAgentAutomationEnabled|setHostSettings|assignAgentToSidebarSection)$/.test(c.path)).length;
const confirm=(page:Page)=>editor(page).getByRole("checkbox",{name:"I confirm this handover action and its disclosed native effects.",exact:true}).check();
const consent=(page:Page)=>editor(page).getByRole("checkbox",{name:"I confirm continuing only the original handover request.",exact:true}).check();
const submit=(page:Page)=>editor(page).getByRole("button",{name:"Submit handover action",exact:true}).click();
async function refresh(page:Page,f:Fixture){const revision=(await f.client().protectionHandover(f.ref)).data.revision;await editor(page).getByRole("button",{name:"Read latest handover revision",exact:true}).click();await page.waitForFunction(r=>document.querySelector('[data-testid="handover-draft-revision"]')?.textContent===r,revision);}
export async function handoverBrowserJourney(t:TestContext,ports:Ports){
 async function withPage(run:(page:Page,f:Fixture,origin:string)=>Promise<void>,token=H_OWNER){
  const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await handoverFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
  const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(15000);page.on("pageerror",e=>errors.push(e.message));
  try{
   const grant=(await f.client(token).createConsoleGrant(origin)).data;
   await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
   await page.goto(`${origin}/protection?handover=${encodeURIComponent(f.ref)}`);await editor(page).waitFor();await run(page,f,origin);assert.deepEqual(errors,[]);
   const html=await(await context.request.get(page.url())).text(),local=await page.evaluate(()=>Object.keys(localStorage).map(k=>localStorage.getItem(k)).join("\n"));
   for(const value of [H_OWNER,grant.code,"PRIVATE_ROUTINE","PRIVATE_SOURCE_PERSONA","PRIVATE_LIFECYCLE_INSTRUCTIONS"]){assert.ok(!html.includes(value));assert.ok(!local.includes(value));}
   assert.ok(!/expectedRevision|evidenceRef|itemId|confirmed|csrfToken/.test(local));
  }finally{await context.close();await ports.stop(web.child);await f.close();}
 }
 await t.test("handover controls execute an original dependency-ordered batch and separate completed batch from remaining duties",()=>withPage(async(page,f)=>{
  await page.locator("#handover-action").selectOption("advance");await confirm(page);await submit(page);await result(page).getByText("completed",{exact:true}).waitFor();
  assert.equal((await f.client().protectionHandover(f.ref)).data.remaining,1);assert.ok(f.rows.some(r=>r.id===H_SOURCE));assert.ok((await result(page).innerText()).includes("does not mean all duties"));
  await page.setViewportSize({width:390,height:844});await page.locator("h1").click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  if(ports.evidence)await page.screenshot({path:join(ports.evidence,"handover-mobile.png"),fullPage:true});
  await page.getByRole("link",{name:"View handover operation receipt",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();
  assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("Original handover operation"));
  await page.getByRole("link",{name:"Inspect original handover controls",exact:true}).click();await page.locator('[data-testid="handover-history"]').waitFor();
 }));
 await t.test("handover revision conflicts preserve the selected action and require explicit reapproval",()=>withPage(async(page,f)=>{
  const previous=await page.locator('[data-testid="handover-draft-revision"]').innerText();
  await f.client().changeHandover({requestId:randomUUID(),handoverRef:f.ref,action:"observe",expectedRevision:previous,confirmed:true});
  await confirm(page);await submit(page);await editor(page).getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();
  assert.equal(await page.locator('[data-testid="handover-draft-revision"]').innerText(),previous);assert.equal(await page.locator("#handover-action").inputValue(),"observe");
  await refresh(page,f);assert.equal(await editor(page).getByRole("checkbox",{name:"I confirm this handover action and its disclosed native effects.",exact:true}).isChecked(),false);
  await confirm(page);await submit(page);await result(page).getByText("completed",{exact:true}).waitFor();assert.equal(writes(f),0);
 }));
 await t.test("lost handover reply survives reload and recovery reads the original result without another native write",()=>withPage(async(page,f)=>{
  let posts=0;await page.route("**/v1/handover-changes",async route=>{posts++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort("failed");});
  await page.locator("#handover-action").selectOption("advance");await confirm(page);await submit(page);await editor(page).getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();
  const count=writes(f);await page.reload();await editor(page).waitFor();assert.equal(await page.locator("#handover-action").isDisabled(),true);
  await editor(page).getByRole("button",{name:"Read original handover result",exact:true}).click();await result(page).getByText("completed",{exact:true}).waitFor();assert.equal(posts,1);assert.equal(writes(f),count);
  await page.unroute("**/v1/handover-changes");await page.getByRole("link",{name:"View handover operation receipt",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();
  f.state.unavailable=true;const calls=f.state.calls.length;await page.reload();await page.locator('[data-testid="operation-receipt"]').waitFor();assert.equal(f.state.calls.length,calls);
 }));
 await t.test("unknown original claims cannot be cancelled or cleared by failed continuation; explicit resume keeps duty identities",()=>withPage(async(page,f)=>{
  let once=true;f.hooks.afterCommit=async label=>{if(label==="managed-handover-claim"&&once){once=false;throw Error("lost-claim");}};
  await page.locator("#handover-action").selectOption("advance");await confirm(page);await submit(page);await editor(page).getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();assert.equal(writes(f),0);
  await page.reload();await editor(page).getByRole("button",{name:"Read original handover result",exact:true}).click();await result(page).getByText("unknown",{exact:true}).waitFor();
  await consent(page);await editor(page).getByRole("button",{name:"Cancel undispatched preparation",exact:true}).click();await editor(page).getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();assert.equal(await page.locator("#handover-action").isDisabled(),true);
  f.hooks.afterCommit=undefined;await consent(page);await editor(page).getByRole("button",{name:"Resume original duties",exact:true}).click();await result(page).getByText("completed",{exact:true}).waitFor();assert.equal((await f.client().protectionHandover(f.ref)).data.remaining,1);
 }));
 await t.test("attestation uses an original observation and retirement reports real blockers without deleting the source",()=>withPage(async(page,f)=>{
  const head=(await f.client().protectionHandover(f.ref)).data;
  await f.client().changeHandover({requestId:randomUUID(),handoverRef:f.ref,action:"advance",expectedRevision:head.revision,confirmed:true});
  const observed=(await f.client().changeHandover({requestId:randomUUID(),handoverRef:f.ref,action:"observe",expectedRevision:(await f.client().protectionHandover(f.ref)).data.revision,confirmed:true})).data;
  const proof=observed.result!.observations.find(i=>i.state==="complete")!,count=writes(f);
  await refresh(page,f);await page.locator("#handover-action").selectOption("attest");await page.locator("#handover-item").fill(proof.itemId);await page.locator("#handover-evidence").fill(proof.evidenceRef!);await confirm(page);await submit(page);
  await result(page).getByText("attested",{exact:true}).waitFor();assert.equal(writes(f),count);
  await refresh(page,f);await page.locator("#handover-action").selectOption("retire");await page.locator("#handover-evidence").fill(observed.operationRef);await confirm(page);await submit(page);
  await result(page).getByText("blocked · retirement_conditions_unmet",{exact:true}).waitFor();
  await page.locator('[data-testid="handover-blockers"]').filter({hasText:"deletion_boundary_unavailable"}).waitFor();assert.ok((await result(page).innerText()).includes("blocked"));assert.ok(f.rows.some(r=>r.id===H_SOURCE));assert.equal(writes(f),count);
 }));
 await t.test("handover changes require live permission and CSRF independently of readable history",async()=>{
  await withPage(async(page,f,origin)=>{
   assert.equal(await page.locator("#handover-action").isDisabled(),true);
   const session=await page.context().request.get(`${origin}/v1/console/session`,{headers:{"x-grokbox-installation-id":H_INSTALL}});
   const denied=await page.context().request.post(`${origin}/v1/handover-changes`,{headers:{origin,"x-grokbox-installation-id":H_INSTALL,"x-grokbox-csrf":(await session.json()).data.csrfToken},data:{requestId:randomUUID(),handoverRef:f.ref,action:"observe",expectedRevision:(await f.client().protectionHandover(f.ref)).data.revision,confirmed:true}});
   assert.equal(denied.status(),403);assert.equal(writes(f),0);
  },H_READER);
  await withPage(async(page,f,origin)=>{
   const denied=await page.context().request.post(`${origin}/v1/handover-changes`,{headers:{origin,"x-grokbox-installation-id":H_INSTALL},data:{requestId:randomUUID(),handoverRef:f.ref,action:"observe",expectedRevision:(await f.client().protectionHandover(f.ref)).data.revision,confirmed:true}});
   assert.equal(denied.status(),403);assert.equal(writes(f),0);
  });
 });
}
