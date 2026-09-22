import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { desktopFixture, DESKTOP_AGENT as A, DESKTOP_OWNER, DESKTOP_READER, DESKTOP_INSTALLATION as I } from "./desktop-fixture.ts";
import { openConfigStore, rootConfigLayout, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { join } from "node:path";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function desktopBrowserJourney(t:TestContext,p:Ports){
  async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof desktopFixture>>,origin:string)=>Promise<void>,token=DESKTOP_OWNER){
    const origin=`http://127.0.0.1:${await p.freePort()}`,f=await desktopFixture(origin),web=await p.launchWeb(p.entry,p.home,origin,f.server.url),context=await p.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(12000);const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    try{const grant=(await f.client(token).createConsoleGrant(origin)).data;await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();const nativeReads=f.state.nativeReads;
      await page.goto(`${origin}/desktop`);await page.locator('[data-testid="desktop-review"]').waitFor();await page.getByRole("button",{name:"Refresh desktop review, keep draft",exact:true}).waitFor();
      await run(page,f,origin);assert.deepEqual(errors,[]);assert.equal(f.state.nativeReads,nativeReads);
      const html=await(await context.request.get(`${origin}/desktop`)).text();for(const value of [DESKTOP_OWNER,grant.code,'"csrfToken"'])assert.ok(!html.includes(value));
    }finally{await context.close();await p.stop(web.child);await f.close();}
  }
  const prune=async(page:Page)=>{await page.getByRole("checkbox",{name:"I confirm the reviewed desktop reclaim and possible browser-profile loss.",exact:true}).check();await page.getByRole("button",{name:"Reclaim reviewed desktops",exact:true}).click();};
  const policy=async(page:Page)=>{await page.getByRole("checkbox",{name:"I confirm this policy; enabling authorizes future eligible desktop helper effects.",exact:true}).check();await page.getByRole("button",{name:"Apply desktop policy",exact:true}).click();};
  await t.test("browser reviews protection, applies exact policy and reclaims only the reviewed idle fork",async()=>withPage(async(page,f)=>{
    await page.locator("#desktop-keep").fill(JSON.stringify([A]));await policy(page);await page.locator('[data-testid="desktop-receipt"]').getByText("succeeded",{exact:true}).waitFor();assert.deepEqual(f.state.stops,[]);
    await page.getByRole("button",{name:"Refresh desktop review, keep draft",exact:true}).click();await page.getByText("Reviewed eligible instances: 0.",{exact:false}).waitFor();
    await page.locator("#desktop-keep").fill("[]");await policy(page);await page.locator('[data-testid="desktop-receipt"]').getByText("succeeded",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Refresh desktop review, keep draft",exact:true}).click();await page.getByText("Reviewed eligible instances: 1.",{exact:false}).waitFor();
    await prune(page);await page.getByText("Display 2: stopped · display-dark",{exact:true}).waitFor();assert.deepEqual(f.state.stops,[2]);assert.equal(f.state.world.assignments[A],2);
    await page.getByRole("link",{name:"View original desktop operation",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();assert.ok(page.url().includes("domain=desktop"));
  }));
  await t.test("lost browser reclaim reply recovers after reload without a second request",async()=>withPage(async(page,f)=>{
    let posts=0;await page.route("**/v1/desktop-prunes",async route=>{posts++;const result=await route.fetch();assert.equal(result.status(),200);await route.abort("failed");});await prune(page);
    await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();await page.reload();await page.getByRole("button",{name:"Recover desktop reclaim",exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:"Reclaim reviewed desktops",exact:true}).isDisabled(),true);await page.getByRole("button",{name:"Recover desktop reclaim",exact:true}).click();
    await page.getByText("Display 2: stopped · display-dark",{exact:true}).waitFor();assert.equal(posts,1);assert.deepEqual(f.state.stops,[2]);
    const stored=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));assert.ok(!/expectedRevision|agentIds|confirmed|stopWindowPath|csrfToken/.test(stored));
  }));
  await t.test("unknown helper settlement remains blocked after refresh and original-operation lookup",async()=>withPage(async(page,f)=>{
    f.state.stop=async()=>{throw Error("unknown-helper-result");};await prune(page);await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();await page.reload();
    await page.getByRole("button",{name:"Recover desktop reclaim",exact:true}).click();await page.getByText("Display 2: unknown · not-observed",{exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:"Reclaim reviewed desktops",exact:true}).isDisabled(),true);assert.deepEqual(f.state.stops,[2]);
  }));
  await t.test("policy conflict retains the draft until explicit review; narrow view has no page overflow",async()=>withPage(async(page,f)=>{
    await page.locator("#desktop-keep").fill(JSON.stringify([A]));const store=openConfigStore(rootConfigLayout(f.root)),value=(await store.read()).document;value.desktop!.idleReclaim!.minIdleMs=900000;await publishConfigFile(join(f.root,"config.json"),value);
    await policy(page);await page.getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();assert.equal(await page.locator("#desktop-keep").inputValue(),JSON.stringify([A]));
    await page.getByRole("button",{name:"Refresh desktop review, keep draft",exact:true}).click();await page.waitForFunction(()=>(document.querySelector('button[type="submit"]') as HTMLButtonElement)?.disabled===true);
    await policy(page);await page.locator('[data-testid="desktop-receipt"]').getByText("succeeded",{exact:true}).waitFor();assert.deepEqual((await store.read()).document.desktop!.keepAgentIds,[A]);
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(f.state.stops,[]);
  }));
  await t.test("real read-only session and missing CSRF cannot acquire desktop effects",async()=>{
    await withPage(async(page,f)=>{assert.equal(await page.getByRole("button",{name:"Apply desktop policy",exact:true}).isDisabled(),true);assert.equal(await page.getByRole("button",{name:"Reclaim reviewed desktops",exact:true}).isDisabled(),true);assert.deepEqual(f.state.stops,[]);},DESKTOP_READER);
    await withPage(async(page,f,origin)=>{const response=await page.context().request.post(`${origin}/v1/desktop-prunes`,{headers:{origin,"x-grokbox-installation-id":I},data:{requestId:randomUUID(),expectedRevision:(await f.client().desktop()).data.revision,confirmed:true}});assert.equal(response.status(),403);assert.deepEqual(f.state.stops,[]);});
  });
}
