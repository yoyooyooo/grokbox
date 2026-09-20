import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setupFixture, SETUP_BOT, SETUP_INSTALLATION, SETUP_OWNER, SETUP_READER, SETUP_KEY } from "./setup-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;
  launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function setupBrowserJourney(t:TestContext,ports:Ports){
  async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof setupFixture>>,origin:string)=>Promise<void>,token=SETUP_OWNER){
    const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await setupFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
    const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];
    page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
    try{
      const grant=(await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();
      await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();await page.goto(`${origin}/notification-setup`);await page.getByRole("heading",{name:"Notification setup",exact:true}).waitFor();
      await run(page,f,origin);assert.deepEqual(errors,[]);
      const html=await (await context.request.get(`${origin}/notification-setup`)).text();
      for(const secret of [SETUP_KEY,SETUP_OWNER,"synthetic-setup-gateway",grant.code])assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
      const stored=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));
      assert.ok(!stored.includes(SETUP_KEY));assert.ok(!stored.includes('"prompt"'));assert.ok(!stored.includes('"expectedRevision"'));assert.ok(!stored.includes('"blueprint"'));
    }finally{await context.close();await ports.stop(web.child);await f.close();}
  }
  async function fields(page:Page){await page.locator("#setup-bot").fill(SETUP_BOT);await page.locator("#setup-budget").fill("10");await page.locator("#setup-target-budget").fill("10");await page.locator("#setup-settings-consent").check();}
  async function configure(page:Page){await fields(page);await page.getByRole("button",{name:"Save notification settings",exact:true}).click();await page.locator('[data-testid="setup-result"]').filter({hasText:"configuration-committed"}).waitFor();}
  async function create(page:Page){await page.locator("#setup-routine-consent").check();await page.getByRole("button",{name:"Create disabled reminder Routine",exact:true}).click();await page.locator('[data-testid="setup-result"]').filter({hasText:"disabled-definition-observed"}).waitFor();await page.waitForFunction(()=>Boolean((document.querySelector("#setup-routine")as HTMLSelectElement)?.value));}

  await t.test("browser completes unprepared receiver setup, then independently enables and optionally tests",async()=>withPage(async(page,f)=>{
    assert.equal(f.rows.length,0);await configure(page);assert.equal(f.calls.filter(c=>c.method!=="getAgentAutomations"&&c.method!=="listAgents").length,0);
    await create(page);assert.equal(f.rows[0]!.isEnabled,false);
    await page.locator("#setup-binding-consent").check();await page.getByRole("button",{name:"Bind selected disabled Routine",exact:true}).click();
    await page.locator('[data-testid="setup-result"]').filter({hasText:"credential-stored"}).waitFor();assert.equal(f.deliveries.length,0);
    await page.getByRole("button",{name:"Enable selected native Routine",exact:true}).click();await page.locator('[data-testid="setup-result"]').filter({hasText:"requested-state-observed"}).waitFor();
    assert.equal(f.rows[0]!.isEnabled,true);assert.equal((await f.client().receivers()).data.receivers[0]!.automatic,null);
    if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await page.screenshot({path:join(ports.evidence,"notification-first-setup-desktop.png"),fullPage:true});}
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(ports.evidence)await page.screenshot({path:join(ports.evidence,"notification-first-setup-mobile.png"),fullPage:true});
    await page.getByRole("link",{name:"Continue to receiver permission and optional test →",exact:true}).click();await page.locator('[data-testid="receiver-editor"]').waitFor();
    await page.getByRole("button",{name:"Verify receiver",exact:true}).click();await page.waitForFunction(()=>(document.querySelector("#receiver-model-revision")as HTMLInputElement)?.value.length===64);
    await page.getByRole("checkbox",{name:"I confirm this receiver change; enabling allows future bounded model wake costs.",exact:true}).check();
    await page.getByRole("button",{name:"Apply receiver change",exact:true}).click();await page.getByText("Receiver consent recorded",{exact:true}).waitFor();
    assert.equal(f.deliveries.length,0);assert.deepEqual(await f.observations.incidents(),[]);
    await page.getByRole("button",{name:"Verify receiver",exact:true}).click();await page.waitForFunction(()=>(document.querySelector("#receiver-model-revision")as HTMLInputElement)?.value.length===64);
    await page.getByRole("checkbox",{name:"I authorize one optional test and its possible model cost.",exact:true}).check();
    await page.getByRole("button",{name:"Send optional test",exact:true}).click();await page.getByText("Independent test receipt",{exact:true}).waitFor();
    assert.equal(f.deliveries.length,1);assert.deepEqual(await f.observations.incidents(),[]);
    assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);assert.equal(f.calls.filter(c=>c.method==="getAutomationWebhookCredential").length,1);
  }));

  await t.test("lost browser setup acknowledgement blocks replacement through refresh and uses the original receipt",async()=>withPage(async(page,f)=>{
    await fields(page);let posts=0;
    await page.route("**/v1/setup-changes",async route=>{posts++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort("failed");});
    await page.getByRole("button",{name:"Save notification settings",exact:true}).click();await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();
    await page.reload();await page.getByRole("button",{name:"Query original setup operation",exact:true}).waitFor();assert.equal(await page.locator("#setup-bot").isDisabled(),true);
    await page.getByRole("button",{name:"Query original setup operation",exact:true}).click();await page.locator('[data-testid="setup-result"]').filter({hasText:"configuration-committed"}).waitFor();
    assert.equal(posts,1);assert.equal(await page.locator("#setup-bot").isDisabled(),false);await page.unroute("**/v1/setup-changes");
    await page.getByRole("link",{name:"View setup receipt",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();
    assert.ok(page.url().includes("domain=notification-settings"));assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("configuration-committed"));assert.equal(f.deliveries.length,0);
  }));

  await t.test("lost native create is reconciled from the browser to an exact returned disabled definition, without recreation",async()=>withPage(async(page,f)=>{
    await configure(page);f.state.loseReply="createAgentAutomation";await page.locator("#setup-routine-consent").check();
    await page.getByRole("button",{name:"Create disabled reminder Routine",exact:true}).click();await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();
    await page.reload();await page.getByRole("button",{name:"Query original setup operation",exact:true}).waitFor();
    const routine=(await f.client().routines(SETUP_BOT)).data.routines[0]!;await page.locator("#setup-routine").selectOption(routine.routineRef);
    await page.getByRole("button",{name:"Reconcile selected disabled Routine",exact:true}).click();await page.locator('[data-testid="setup-result"]').filter({hasText:"disabled-definition-observed"}).waitFor();
    assert.equal(f.calls.filter(c=>c.method==="createAgentAutomation").length,1);assert.equal(f.rows.length,1);
    await page.getByRole("link",{name:"View setup receipt",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();assert.ok(page.url().includes("domain=routine"));
  }));

  await t.test("setup revision conflict keeps the draft, and refresh does not silently replace fields",async()=>withPage(async(page,f)=>{
    await fields(page);await page.locator("#setup-budget").fill("7");
    const latest=(await f.client().notificationSettings()).data;
    await f.client().changeSetup({action:"settings",expectedRevision:latest.revision,requestId:randomUUID(),confirmed:true,settings:{alias:"default",botRef:`bot:${SETUP_INSTALLATION}:${SETUP_BOT}`,routineKey:"ops-notice",mode:"actionable-user",installationBudget:5,targetBudget:5}});
    await page.getByRole("button",{name:"Save notification settings",exact:true}).click();await page.getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();
    assert.equal(await page.locator("#setup-budget").inputValue(),"7");
    const response=page.waitForResponse(r=>r.url().endsWith("/v1/notification-settings")&&r.status()===200);
    await page.getByRole("button",{name:"Read latest settings revision, keep draft",exact:true}).click();await response;
    assert.equal(await page.locator("#setup-budget").inputValue(),"7");await page.getByRole("button",{name:"Save notification settings",exact:true}).click();
    await page.locator('[data-testid="setup-result"]').filter({hasText:"configuration-committed"}).waitFor();assert.equal((await f.client().notificationSettings()).data.installationBudget,7);
  }));

  await t.test("real browser permissions and CSRF refuse first-setup writes before native effects",async()=>{
    await withPage(async(page,f,origin)=>{
      assert.equal(await page.locator("#setup-bot").isDisabled(),true);
      const session=await page.context().request.get(`${origin}/v1/console/session`,{headers:{"x-grokbox-installation-id":SETUP_INSTALLATION}}),csrf=(await session.json()).data.csrfToken;
      const settings=(await f.client().notificationSettings()).data;
      const response=await page.context().request.post(`${origin}/v1/setup-changes`,{headers:{origin,"x-grokbox-installation-id":SETUP_INSTALLATION,"x-grokbox-csrf":csrf},data:{action:"settings",expectedRevision:settings.revision,requestId:randomUUID(),confirmed:true,settings:{alias:"default",botRef:SETUP_BOT,routineKey:"ops-notice",mode:"actionable-user",installationBudget:10,targetBudget:10}}});
      assert.equal(response.status(),403);assert.equal(f.rows.length,0);assert.equal(f.deliveries.length,0);
    },SETUP_READER);
    await withPage(async(page,f,origin)=>{
      const response=await page.context().request.post(`${origin}/v1/setup-changes`,{headers:{origin,"x-grokbox-installation-id":SETUP_INSTALLATION},data:{action:"settings",confirmed:true}});
      assert.equal(response.status(),403);assert.equal(f.rows.length,0);assert.equal(f.deliveries.length,0);
    });
  });
}
