import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { materialsFixture, materialUntil, MATERIAL_INSTALLATION, MATERIAL_BOT, MATERIAL_OWNER, MATERIAL_READER, BODY_SENTINEL } from "./materials-fixture.ts";
type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;
  launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
export async function materialsBrowserJourney(t:TestContext,ports:Ports){
  async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof materialsFixture>>,origin:string)=>Promise<void>,token=MATERIAL_OWNER){
    const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await materialsFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
    const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[],foreign:string[]=[];
    page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));page.on("request",request=>{if(new URL(request.url()).origin!==origin)foreign.push(request.url());});
    try{
      await materialUntil(()=>f.client().materials(),r=>r.data.items.length===8);
      const grant=(await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();
      await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();await page.goto(`${origin}/materials`);await page.getByRole("heading",{name:"Materials",exact:true}).waitFor();
      await run(page,f,origin);assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);
      const html=await(await context.request.get(`${origin}/materials`)).text();
      for(const secret of [MATERIAL_OWNER,grant.code,BODY_SENTINEL,f.nativeRoot,f.filesRoot,"UNAUTHORIZED_SHARD","SYNTHETIC_SECRET_NOT_A_DOCUMENT"])assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
      const local=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));
      assert.ok(!local.includes(BODY_SENTINEL));assert.ok(!local.includes('"content"'));assert.ok(!local.includes('"expectedRevision"'));
    }finally{await context.close();await ports.stop(web.child);await f.close();}
  }
  async function filePage(page:Page,origin:string){await page.goto(`${origin}/materials?kind=file`);await page.getByRole("link",{name:"notes.md",exact:true}).click();await page.locator("#material-text").waitFor();}
  async function save(page:Page,text:string){await page.locator("#material-text").fill(text);await page.getByRole("checkbox",{name:"I confirm replacing this existing source text.",exact:true}).check();await page.getByRole("button",{name:"Save source text",exact:true}).click();}

  await t.test("production browser separates Memory scopes and Project membership without preloading private bodies",async()=>withPage(async(page,f,origin)=>{
    assert.equal(await page.locator('[data-testid="material-list"] tbody tr').count(),4);assert.ok(!(await page.locator("body").innerText()).includes(BODY_SENTINEL));
    await page.locator("#material-scope").selectOption("user");await page.waitForFunction(()=>document.querySelectorAll('[data-testid="material-list"] tbody tr').length===1);
    assert.ok((await page.locator('[data-testid="material-list"]').innerText()).includes("user-memory"));
    await page.goto(`${origin}/materials?scope=agent`);await page.getByRole("link",{name:`agents/${MATERIAL_BOT}/memory/profile.md`,exact:true}).click();
    await page.locator('[data-testid="material-body"]').waitFor();assert.ok((await page.locator('[data-testid="material-body"]').innerText()).includes(BODY_SENTINEL));
    assert.equal(await page.locator("#material-text").count(),0);assert.equal(await page.getByRole("button",{name:"Save source text",exact:true}).count(),0);
    await page.getByRole("link",{name:"Projects",exact:true}).click();await page.getByRole("link",{name:"projects/alpha/project.md",exact:true}).click();
    await page.getByRole("heading",{name:"Observed Project memberships",exact:true}).waitFor();assert.ok((await page.locator("main").innerText()).includes(MATERIAL_BOT));
    assert.ok(!(await page.locator("main").innerText()).includes("not-authorized"));
    await page.goto(`${origin}/materials`);await page.locator("#material-query").fill("shared phrase");await page.getByRole("button",{name:"Search materials",exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="material-list"] tbody tr').length===3);
    assert.ok(!(await page.locator("main").innerText()).includes(BODY_SENTINEL));
    if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await page.screenshot({path:join(ports.evidence,"materials-memory-desktop.png"),fullPage:true});}
  }));
  await t.test("browser edits an authorized file through the shared source writer and opens its original receipt",async()=>withPage(async(page,f,origin)=>{
    await filePage(page,origin);await save(page,"Browser source edit with Unicode café.\n");await page.getByText("Source write verified",{exact:true}).waitFor();
    assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"Browser source edit with Unicode café.\n");
    await page.getByRole("link",{name:"View source receipt",exact:true}).click();await page.locator('[data-testid="operation-receipt"]').waitFor();
    assert.ok(page.url().includes("domain=material"));assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("source-readback"));
    assert.ok(!(await page.locator('[data-testid="operation-receipt"]').innerText()).includes("Browser source edit"));
  }));
  await t.test("external source conflict preserves the browser draft until an explicit revision refresh",async()=>withPage(async(page,f,origin)=>{
    await filePage(page,origin);await f.put(f.filesRoot,"notes.md","External content before browser submit.");
    const draft="My preserved draft.";await save(page,draft);await page.getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();
    assert.equal(await page.locator("#material-text").inputValue(),draft);assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"External content before browser submit.");
    await page.getByRole("button",{name:"Read latest revision, keep draft",exact:true}).click();
    const current=(await f.client().materials({kind:"file"})).data.items.find(d=>d.path==="notes.md")!;
    const read=(await f.client().readMaterial(current.ref)).data.document;
    await page.getByText(`Draft revision ${read.revision}`,{exact:false}).waitFor({state:"attached"});
    assert.equal(await page.locator("#material-text").inputValue(),draft);await page.getByRole("button",{name:"Save source text",exact:true}).click();
    await page.getByText("Source write verified",{exact:true}).waitFor();assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),draft);
  }));
  await t.test("lost browser source reply stays recoverable through refresh without a replacement POST",async()=>withPage(async(page,f,origin)=>{
    await filePage(page,origin);let posts=0;
    await page.route("**/v1/material-changes",async route=>{posts++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort("failed");});
    await save(page,"Saved exactly once from browser.");await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();
    await page.reload();await page.getByRole("button",{name:"Recover source write",exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:"Save source text",exact:true}).isDisabled(),true);
    await page.getByRole("button",{name:"Recover source write",exact:true}).click();await page.getByText("Source write verified",{exact:true}).waitFor();
    assert.equal(posts,1);assert.equal(await readFile(join(f.filesRoot,"notes.md"),"utf8"),"Saved exactly once from browser.");await page.unroute("**/v1/material-changes");
  }));
  await t.test("read-only sessions do not gain body/search/write permissions, and valid owner writes still require CSRF",async()=>{
    await withPage(async(page,f,origin)=>{
      const doc=(await f.client().materials({kind:"file"})).data.items.find(d=>d.path==="notes.md")!;
      await page.goto(`${origin}/materials?kind=file&selected=${encodeURIComponent(doc.ref)}`);await page.getByRole("alert").filter({hasText:"permission_denied"}).waitFor();
      assert.equal(await page.locator("#material-text").count(),0);assert.equal(await page.locator('[data-testid="material-body"]').count(),0);
      await page.goto(`${origin}/materials?query=private`);await page.getByRole("alert").filter({hasText:"permission_denied"}).waitFor();
      assert.equal(await page.locator('[data-testid="material-list"]').count(),0);
    },MATERIAL_READER);
    await withPage(async(page,f,origin)=>{
      const doc=(await f.client().materials({kind:"file"})).data.items.find(d=>d.path==="notes.md")!;
      const response=await page.context().request.post(`${origin}/v1/material-changes`,{headers:{origin,"x-grokbox-installation-id":MATERIAL_INSTALLATION},data:{ref:doc.ref,requestId:randomUUID(),expectedRevision:doc.revision,content:"not allowed",confirmed:true}});
      assert.equal(response.status(),403);assert.ok((await readFile(join(f.filesRoot,"notes.md"),"utf8")).startsWith("Original"));
    });
  });
  await t.test("native text is escaped and long source references remain usable on a narrow screen",async()=>withPage(async(page,f,origin)=>{
    const text='<script>window.materialUnexpectedScript=true</script>\n'+"long-native-text-".repeat(100);
    await f.put(f.nativeRoot,`agents/${MATERIAL_BOT}/memory/profile.md`,text);
    const doc=(await f.client().materials({kind:"memory",scope:"agent"})).data.items.find(d=>d.path.endsWith("profile.md"))!;
    await page.goto(`${origin}/materials?selected=${encodeURIComponent(doc.ref)}`);await page.locator('[data-testid="material-body"]').waitFor();
    assert.equal(await page.locator('[data-testid="material-body"]').innerText(),text);
    assert.equal(await page.evaluate(()=>Object.hasOwn(window,"materialUnexpectedScript")),false);
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(ports.evidence)await page.screenshot({path:join(ports.evidence,"materials-mobile.png"),fullPage:true});
  }));
}
