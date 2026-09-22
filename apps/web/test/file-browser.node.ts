import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { fileFixture, FILE_OWNER, FILE_READER, FILE_INSTALLATION as I } from "./file-fixture.ts";

type Ports={browser:Browser;entry:string;home:string;evidence?:string;freePort:()=>Promise<number>;launchWeb:(entry:string,home:string,origin:string,management:string)=>Promise<{child:ChildProcess}>;stop:(child:ChildProcess)=>Promise<void>};
const digest=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
export async function fileBrowserJourney(t:TestContext,ports:Ports){
  async function withPage(run:(page:Page,f:Awaited<ReturnType<typeof fileFixture>>,origin:string)=>Promise<void>,token=FILE_OWNER){
    const origin=`http://127.0.0.1:${await ports.freePort()}`,f=await fileFixture(origin),web=await ports.launchWeb(ports.entry,ports.home,origin,f.server.url);
    const context=await ports.browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[];page.setDefaultTimeout(12000);page.on("pageerror",e=>errors.push(e.message));
    try{
      const grant=(await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`);await page.locator("#login-code").fill(grant.code);await page.getByRole("button",{name:"安全登录",exact:true}).click();await page.getByRole("heading",{name:"Box 概览",exact:true}).waitFor();
      const beforeNative=f.state.nativeReads;
      await page.goto(`${origin}/files`);await page.getByRole("heading",{name:"Files",exact:true}).waitFor();await page.locator('[data-testid="file-editor"]').waitFor();
      await run(page,f,origin);assert.deepEqual(errors,[]);assert.equal(f.state.nativeReads,beforeNative);
      const html=await (await context.request.get(`${origin}/files`)).text();assert.ok(!html.includes(FILE_OWNER));assert.ok(!html.includes(grant.code));assert.ok(!html.includes('"csrfToken"'));
      const locators=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith("grokbox:operation:")).map(k=>localStorage.getItem(k)).join("\n"));
      for(const secret of ["PRIVATE_BROWSER_FILE_BODY","expectedRevision","confirmed","contentBase64","deletionRequestId",FILE_OWNER])assert.ok(!locators.includes(secret),secret);
    }finally{await context.close();await ports.stop(web.child);await f.close();}
  }
  const confirm=(page:Page)=>page.getByRole("checkbox",{name:"I confirm this exact source change.",exact:true}).check();
  const apply=(page:Page)=>page.getByRole("button",{name:"Apply file change",exact:true}).click();
  const operation=(page:Page)=>page.locator('[data-testid="file-operation"]');
  const expectState=async(page:Page,action:string,state:string)=>{await operation(page).getByText(new RegExp(`${action} /`)).waitFor();await operation(page).getByText(state,{exact:true}).waitFor();};

  await t.test("file source creation, explicit read, recoverable deletion and original restore work in production Chrome",async()=>withPage(async(page,f,origin)=>{
    await page.locator("#file-name").fill("note.txt");await page.locator("#file-text").fill("PRIVATE_BROWSER_FILE_BODY <script>not-executed</script>");await confirm(page);await apply(page);await expectState(page,"write","succeeded");
    assert.equal(await readFile(join(f.files,"note.txt"),"utf8"),"PRIVATE_BROWSER_FILE_BODY <script>not-executed</script>");
    await page.getByRole("link",{name:"Inspect note.txt",exact:true}).click();await page.locator('[data-testid="file-selected"]').waitFor();
    assert.equal(await page.locator('[data-testid="file-content"]').count(),0);
    await page.getByRole("button",{name:"Read source content",exact:true}).click();await page.locator('[data-testid="file-content"]').waitFor();
    assert.equal(await page.locator('[data-testid="file-content"] script').count(),0);
    await page.locator("#file-action").selectOption("delete");await confirm(page);await apply(page);await expectState(page,"delete","succeeded");
    assert.ok(!(await readdir(f.files)).includes("note.txt"));
    await page.getByRole("checkbox",{name:"I confirm this original recovery action.",exact:true}).check();await page.getByRole("button",{name:"Restore original deletion",exact:true}).click();await expectState(page,"restore","succeeded");
    assert.equal(await readFile(join(f.files,"note.txt"),"utf8"),"PRIVATE_BROWSER_FILE_BODY <script>not-executed</script>");
    await page.getByRole("link",{name:"Open file operation receipt",exact:true}).click();await page.getByRole("heading",{name:"Original file operation",exact:true}).waitFor();
    assert.ok(page.url().includes("domain=file"));await page.getByRole("link",{name:"Inspect original file controls",exact:true}).click();await expectState(page,"restore","succeeded");
    assert.ok(page.url().startsWith(`${origin}/files`));
  }));

  await t.test("real browser binary upload and verified download retain exact bytes, not a text approximation",async()=>withPage(async(page,f)=>{
    const bytes=Buffer.from(Array.from({length:95000},(_,i)=>i%256));
    await page.locator("#file-action").selectOption("upload");await page.locator("#file-name").fill("binary.bin");
    await page.locator("#file-upload").setInputFiles({name:"source.bin",mimeType:"application/octet-stream",buffer:bytes});await confirm(page);await apply(page);await expectState(page,"upload","succeeded");
    assert.deepEqual(await readFile(join(f.files,"binary.bin")),bytes);
    await page.getByRole("link",{name:"Inspect binary.bin",exact:true}).click();await page.locator('[data-testid="file-selected"]').waitFor();
    assert.equal(await page.getByRole("button",{name:"Read source content",exact:true}).isDisabled(),true);
    const downloading=page.waitForEvent("download");await page.getByRole("button",{name:"Download verified file",exact:true}).click();const download=await downloading;
    assert.equal(download.suggestedFilename(),"binary.bin");const path=await download.path();assert.ok(path);assert.deepEqual(await readFile(path),bytes);
    assert.ok((await operation(page).innerText()).includes(digest(bytes)));
  }));

  await t.test("lost file publication response recovers the original request after refresh without resending",async()=>withPage(async(page,f)=>{
    let posts=0;await page.route("**/v1/file-changes",async route=>{posts++;const response=await route.fetch();assert.equal(response.status(),200);await route.abort("failed");});
    await page.locator("#file-name").fill("once.txt");await page.locator("#file-text").fill("once");await confirm(page);await apply(page);
    await page.getByRole("alert").filter({hasText:"operation_unknown"}).waitFor();assert.equal(await readFile(join(f.files,"once.txt"),"utf8"),"once");
    await page.reload();await page.getByRole("button",{name:"Recover file request",exact:true}).waitFor();await page.getByRole("button",{name:"Recover file request",exact:true}).click();await expectState(page,"write","succeeded");
    assert.equal(posts,1);await page.unroute("**/v1/file-changes");
    await page.getByRole("link",{name:"Open file operation receipt",exact:true}).click();await page.getByRole("heading",{name:"Original file operation",exact:true}).waitFor();assert.equal(posts,1);
  }));

  await t.test("file conflicts keep text and require explicit revision review; narrow layout and locators remain bounded",async()=>withPage(async(page,f,origin)=>{
    await writeFile(join(f.files,"conflict.txt"),"before");await page.goto(`${origin}/files?selected=${encodeURIComponent(f.ref("conflict.txt"))}`);await page.locator("#file-text").fill("PRIVATE_BROWSER_FILE_BODY");await confirm(page);
    await writeFile(join(f.files,"conflict.txt"),"external edit");await apply(page);await page.getByRole("alert").filter({hasText:"revision_conflict"}).waitFor();
    assert.equal(await page.locator("#file-text").inputValue(),"PRIVATE_BROWSER_FILE_BODY");assert.equal(await readFile(join(f.files,"conflict.txt"),"utf8"),"external edit");
    await page.getByRole("button",{name:"Refresh source revision, keep draft",exact:true}).click();await page.locator('[data-testid="file-draft-revision"]').getByText(digest("external edit"),{exact:true}).waitFor();
    await confirm(page);await apply(page);await expectState(page,"write","succeeded");assert.equal(await readFile(join(f.files,"conflict.txt"),"utf8"),"PRIVATE_BROWSER_FILE_BODY");
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    if(ports.evidence){await mkdir(ports.evidence,{recursive:true});await page.screenshot({path:join(ports.evidence,"files-mobile.png"),fullPage:true});}
  }));

  await t.test("metadata-only file sessions cannot read content or change sources; owner requests still require CSRF",async()=>{
    await withPage(async(page,f,origin)=>{
      await writeFile(join(f.files,"private.txt"),"private content");await page.goto(`${origin}/files?selected=${encodeURIComponent(f.ref("private.txt"))}`);await page.locator('[data-testid="file-selected"]').waitFor();
      assert.equal(await page.getByRole("button",{name:"Read source content",exact:true}).isDisabled(),true);assert.equal(await page.getByRole("button",{name:"Apply file change",exact:true}).isDisabled(),true);
      const response=await page.context().request.get(`${origin}/v1/file-content/${encodeURIComponent(f.ref("private.txt"))}`,{headers:{"x-grokbox-installation-id":I}});assert.equal(response.status(),403);
    },FILE_READER);
    await withPage(async(page,f,origin)=>{
      const response=await page.context().request.post(`${origin}/v1/file-changes`,{headers:{origin,"x-grokbox-installation-id":I},data:{action:"write",requestId:randomUUID(),ref:f.ref("must-not-exist"),confirmed:true,expectedRevision:null,content:"no"}});
      assert.equal(response.status(),403);assert.deepEqual(await readdir(f.files),[]);
    });
  });
}
