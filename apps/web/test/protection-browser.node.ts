import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { protectionFixture, P_BOT, P_TARGET, P_INSTALL, P_OWNER, P_READER } from "./protection-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;
  launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
const wait=async(check:()=>Promise<boolean>)=>{const end=Date.now()+5000;while(!await check()){if(Date.now()>end)throw Error("browser_protection_deadline");await new Promise(r=>setTimeout(r,25));}};
export async function protectionBrowserJourney(t:TestContext,ports:Ports){
  async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof protectionFixture>>,origin:string)=>Promise<void>,token=P_OWNER){
    const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await protectionFixture(origin,{simulatedRestore:true});
    const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url),page=await context.newPage();
    page.setDefaultTimeout(12000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    try{
      await wait(async()=>!!(await f.client().botProtection(P_BOT)).data.subject?.lastSnapshotRef);
      const grant=(await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();
      await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();await page.goto(`${origin}/protection?bot=${P_BOT}`);
      await page.locator('[data-testid="bot-protection"]').waitFor();
      await run(page,f,origin);assert.deepEqual(errors,[]);
      const html=await (await context.request.get(`${origin}/protection?bot=${P_BOT}`)).text();
      for(const secret of [P_OWNER,"PRIVATE_RECOVERY_MATERIAL","PRIVATE_PROTECTION_ROUTINE","PRIVATE_PROFILE",grant.code])assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
    }finally{await context.close();await ports.stop(web.child);await f.close();}
  }
  const editor=(page:Page)=>page.locator('[data-testid="bot-protection"]');
  const confirm=(page:Page)=>editor(page).getByRole("checkbox",{name:"I confirm this protection policy change and its permitted future native effects.",exact:true}).check();
  await t.test("production protection page reads default state, saves one shared policy and exposes only snapshot metadata",async()=>withPage(async(page,f)=>{
    assert.equal(await page.locator("#protection-mode").inputValue(),"alert");
    assert.ok((await page.locator('[data-testid="protection-worker"]').innerText()).includes("management-server"));
    await page.locator("#protection-tier").selectOption("memory");await confirm(page);
    await editor(page).getByRole("button",{name:"Save Bot protection",exact:true}).click();
    await editor(page).getByText("Protection policy recorded",{exact:true}).waitFor();
    assert.equal((await f.client().botProtection(P_BOT)).data.policy.tier,"memory");
    await page.getByRole("link",{name:"Inspect retained snapshot",exact:true}).click();await page.locator('[data-testid="protection-snapshot"]').waitFor();
    assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE_RECOVERY_MATERIAL"));
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await page.screenshot({path:join(ports.evidence,"protection-mobile.png"),fullPage:true});}
    await page.setViewportSize({width:1440,height:1000});if(ports.evidence)await page.screenshot({path:join(ports.evidence,"protection-desktop.png"),fullPage:true});
  }));
  await t.test("protection conflict retains policy draft until explicitly reading a new revision",async()=>withPage(async(page,f)=>{
    await page.locator("#protection-mode").selectOption("prepare");await confirm(page);
    await f.client().changeProtection({requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,confirmed:true,action:"set",botRef:P_BOT,patch:{pauseOnOwnershipLoss:false}});
    await editor(page).getByRole("button",{name:"Save Bot protection",exact:true}).click();await editor(page).getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();
    assert.equal(await page.locator("#protection-mode").inputValue(),"prepare");
    await editor(page).getByRole("button",{name:"Read latest protection revision, keep draft",exact:true}).click();
    await editor(page).getByRole("button",{name:"Save Bot protection",exact:true}).click();await editor(page).getByText("Protection policy recorded",{exact:true}).waitFor();
    assert.equal((await f.client().botProtection(P_BOT)).data.policy.mode,"prepare");
  }));
  await t.test("lost protection reply survives refresh, blocks replacement submission and links the original receipt",async()=>withPage(async(page,f)=>{
    let posts=0;await page.route("**/v1/protection-changes",async route=>{posts++;const result=await route.fetch();assert.equal(result.status(),200);await route.abort("failed");});
    await page.locator("#protection-tier").selectOption("observe");await confirm(page);await editor(page).getByRole("button",{name:"Save Bot protection",exact:true}).click();
    await editor(page).getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();await page.reload();
    await editor(page).getByRole("button",{name:"Recover protection change",exact:true}).waitFor();assert.equal(await page.locator("#protection-mode").isDisabled(),true);
    await editor(page).getByRole("button",{name:"Recover protection change",exact:true}).click();await editor(page).getByText("Protection policy recorded",{exact:true}).waitFor();
    assert.equal(posts,1);await page.unroute("**/v1/protection-changes");
    await editor(page).getByRole("link",{name:"View protection operation receipt",exact:true}).click();
    await page.locator('[data-testid="operation-receipt"]').waitFor();assert.ok(page.url().includes("domain=protection"));
    assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("Protection policy receipt"));
    assert.equal((await f.client().botProtection(P_BOT)).data.policy.tier,"observe");
    const local=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));
    assert.ok(!/pauseOnOwnershipLoss|captureIntervalMs|PRIVATE_|expectedRevision/.test(local));
  }));
  await t.test("read-only protection sessions cannot change policy and owner writes still require CSRF",async()=>{
    await withPage(async(page,f,origin)=>{
      assert.equal(await page.locator("#protection-mode").isDisabled(),true);
      const session=await page.context().request.get(`${origin}/v1/console/session`,{headers:{"x-grokbox-installation-id":P_INSTALL}});
      const before=(await f.client().protection()).data.revision;
      const denied=await page.context().request.post(`${origin}/v1/protection-changes`,{headers:{origin,"x-grokbox-installation-id":P_INSTALL,"x-grokbox-csrf":(await session.json()).data.csrfToken},
        data:{requestId:randomUUID(),expectedRevision:before,confirmed:true,action:"system",enabled:false}});
      assert.equal(denied.status(),403);assert.equal((await f.client().protection()).data.revision,before);
    },P_READER);
    await withPage(async(page,f,origin)=>{
      const denied=await page.context().request.post(`${origin}/v1/protection-changes`,{headers:{origin,"x-grokbox-installation-id":P_INSTALL},
        data:{requestId:randomUUID(),expectedRevision:(await f.client().protection()).data.revision,confirmed:true,action:"system",enabled:false}});
      assert.equal(denied.status(),403);
    });
  });
  await t.test("a promoted successor keeps its unfinished handover discoverable after navigation and refresh",async()=>withPage(async(page,f,origin)=>{
    await page.locator("#protection-mode").selectOption("auto-replace");await confirm(page);
    await editor(page).getByRole("button",{name:"Save Bot protection",exact:true}).click();
    await editor(page).getByText("Protection policy recorded",{exact:true}).waitFor();
    await page.goto(`${origin}/`);f.state.temporal.add(P_BOT);
    await wait(async()=>(await f.client().botProtection(P_BOT)).data.subject?.currentBotRef===`bot:${P_INSTALL}:${P_TARGET}`);
    await page.goto(`${origin}/protection?bot=${P_BOT}`);
    await page.getByRole("link",{name:"Inspect successor handover",exact:true}).click();
    await page.locator('[data-testid="protection-handover"]').waitFor();
    const details=await page.locator('[data-testid="protection-handover"]').innerText();
    assert.ok(details.includes("active_with_handover"));assert.ok(details.includes(P_BOT));assert.ok(details.includes(P_TARGET));
    assert.ok(details.includes("retirement eligibility are not proven"));assert.equal(f.state.created,1);
    const url=page.url();await page.reload();await page.locator('[data-testid="protection-handover"]').waitFor();
    assert.equal(page.url(),url);
    const successorLinks=page.getByRole("link",{name:"Inspect successor handover",exact:true});
    const linkCount=await successorLinks.count();
    if(linkCount!==1){
      const current=(await f.client().protection()).data;
      assert.equal(linkCount,1,JSON.stringify({store:current.store,subjects:current.subjects,body:(await page.locator("body").innerText()).slice(-12000)}));
    }
    assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE_RECOVERY_MATERIAL"));
    assert.equal(f.state.calls.includes("/api/sendPrompt"),false);
  }));
  await t.test("leaving the page does not stop the protection worker or its exact-Routine loss handling",async()=>withPage(async(page,f,origin)=>{
    await page.goto(`${origin}/`);f.state.temporal.add(P_BOT);
    await wait(async()=>(await f.client().botProtection(P_BOT)).data.subject?.pause?.complete===true);
    await page.goto(`${origin}/protection?bot=${P_BOT}`);await editor(page).waitFor();
    assert.equal(f.state.routines.get(P_BOT)![0]!.isEnabled,false);assert.equal(f.state.created,0);
    assert.ok((await page.locator("body").innerText()).includes("Pending; not delivery proof"));
  }));
}
