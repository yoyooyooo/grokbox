import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { contextFixture, C_OWNER, C_READER, C_WRITER, C_SOURCE, C_TARGET, C_SCOPE, C_INSTALL } from "./context-fixture.ts";

type Ports = { browser: Browser; entry: string; home: string; evidence?: string; freePort: () => Promise<number>;
  launchWeb: (entry: string, home: string, origin: string, management: string) => Promise<{ child: ChildProcess }>; stop: (child: ChildProcess) => Promise<void> };
export async function contextBrowserJourney(t: TestContext, ports: Ports) {
  async function withPage(run: (page: Page, f: Awaited<ReturnType<typeof contextFixture>>, origin: string) => Promise<void>, token = C_OWNER) {
    const origin = `http://127.0.0.1:${await ports.freePort()}`, f = await contextFixture(origin);
    const web = await ports.launchWeb(ports.entry, ports.home, origin, f.server.url), context = await ports.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    try {
      const grant = (await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`); await page.locator("#login-code").fill(grant.code); await page.getByRole("button", { name: "安全登录", exact: true }).click();
      await page.getByRole("heading", { name: "Box 概览", exact: true }).waitFor(); await page.goto(`${origin}/contexts?bot=${C_SOURCE}`);
      await page.locator('[data-testid="context-editor"]').waitFor();
      await run(page, f, origin); assert.deepEqual(errors, []);
      const html = await (await context.request.get(page.url())).text(), local = await page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join("\n"));
      for (const value of [C_OWNER, grant.code, "PRIVATE_CONTEXT_MEMORY", "PRIVATE_CONTEXT_HISTORY", "PRIVATE_NATIVE_ROOT", "PRIVATE_NATIVE_LEAF"]) {
        assert.ok(!html.includes(value)); assert.ok(!local.includes(value));
      }
      assert.ok(!html.includes('"csrfToken"')); assert.ok(!/expectedRevision|snapshotRef|activationExpectedRevision/.test(local));
    } finally { await context.close(); await ports.stop(web.child); await f.close(); }
  }
  const editor = (page: Page) => page.locator('[data-testid="context-editor"]');
  const confirm = (page: Page) => editor(page).getByRole("checkbox", { name: "I confirm this exact context change and its private recovery material.", exact: true }).check();
  const consent = (page: Page) => editor(page).getByRole("checkbox", { name: "I confirm continuing only this original operation, without a replacement request.", exact: true }).check();
  const state = async (page: Page, value: string) => { await page.locator('[data-testid="context-result"]').getByText(value, { exact: true }).waitFor(); };

  await t.test("production context page captures a real worker checkpoint and displays only source metadata and original receipts", async () => withPage(async (page, f) => {
    const calls = f.state.calls.filter(c => c === "capture").length; await confirm(page); await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click();
    await state(page, "captured"); assert.equal(f.state.calls.filter(c => c === "capture").length, calls + 1);
    assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE_"));
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (ports.evidence) { await mkdir(ports.evidence, { recursive: true }); await page.screenshot({ path: join(ports.evidence, "context-mobile.png"), fullPage: true }); }
    await page.setViewportSize({ width: 1440, height: 1000 }); if (ports.evidence) await page.screenshot({ path: join(ports.evidence, "context-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: "View context operation receipt", exact: true }).click(); await page.locator('[data-testid="operation-receipt"]').waitFor();
    assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("Current context operation"));
  }));

  await t.test("stale source revision keeps the user's context action and explicit refresh is required", async () => withPage(async (page, f) => {
    await page.locator("#context-action").selectOption("reset"); await confirm(page);
    const old = await page.locator('[data-testid="context-draft-revision"]').innerText();
    const end = f.owner.enter(C_SOURCE); try { await f.owner.checkpoint(C_SOURCE, async () => {}); } finally { end(); }
    await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click();
    await editor(page).getByRole("alert").filter({ hasText: "source_changed" }).waitFor(); assert.equal(await page.locator("#context-action").inputValue(), "reset");
    assert.equal(await page.locator('[data-testid="context-draft-revision"]').innerText(), old);
    await editor(page).getByRole("button", { name: "Read latest context revision, keep selection", exact: true }).click();
    await page.waitForFunction(previous => document.querySelector('[data-testid="context-draft-revision"]')?.textContent !== previous, old);
    await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click(); await state(page, "prepared");
    assert.equal(f.source.store.getConversationStateStructure().messages.length, 0); assert.equal(f.source.memories[0].content, "PRIVATE_CONTEXT_MEMORY");
  }));

  await t.test("lost reset reply survives page reload, blocks another source change and recovers without repeating the native apply", async () => withPage(async (page, f) => {
    let posts = 0; await page.route("**/v1/context-changes", async route => { posts++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("failed"); });
    await page.locator("#context-action").selectOption("reset"); await confirm(page); await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click();
    await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor(); await page.reload(); await editor(page).waitFor();
    assert.equal(await page.locator("#context-action").isDisabled(), true); await editor(page).getByRole("button", { name: "Read original context result", exact: true }).click(); await state(page, "prepared");
    assert.equal(posts, 1); assert.equal(f.state.calls.filter(c => c === "initialize").length, 1); await page.unroute("**/v1/context-changes");
  }));

  await t.test("unknown native application is reconciled explicitly and a lost release is recoverable after its revision changes", async () => withPage(async (page, f) => {
    f.state.loseAfter = "initialize"; await page.locator("#context-action").selectOption("reset"); await confirm(page);
    await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click(); await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
    await page.reload(); await editor(page).getByRole("button", { name: "Read original context result", exact: true }).click(); await state(page, "unknown");
    await consent(page); await editor(page).getByRole("button", { name: "Cancel before source application", exact: true }).click();
    await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor(); assert.equal(await page.locator("#context-action").isDisabled(), true);
    await consent(page); await editor(page).getByRole("button", { name: "Reconcile original context", exact: true }).click(); await state(page, "prepared");
    await editor(page).getByRole("button", { name: "Read latest context revision, keep selection", exact: true }).click();
    const head = (await f.client().context(C_SOURCE)).data.revision; await page.waitForFunction(value => document.querySelector('[data-testid="context-draft-revision"]')?.textContent === value, head);
    f.state.loseAfter = "activate"; await consent(page); await editor(page).getByRole("button", { name: "Release original context hold", exact: true }).click();
    await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor(); await page.reload();
    await editor(page).getByRole("button", { name: "Read original context result", exact: true }).click(); await state(page, "unknown");
    await consent(page); await editor(page).getByRole("button", { name: "Release original context hold", exact: true }).click(); await state(page, "released");
    assert.equal(f.state.calls.filter(c => c === "initialize").length, 1); assert.ok(!f.state.calls.some(c => /startup|birth|sendPrompt/.test(c)));
  }));

  await t.test("context mutations require live capabilities and CSRF, and a writer cannot release an original hold", async () => {
    await withPage(async (page, f, origin) => {
      assert.equal(await page.locator("#context-action").isDisabled(), true);
      const session = await page.context().request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": C_INSTALL } });
      const r = await f.declaration("reset"), before = f.state.calls.filter(c => c === "initialize").length;
      const denied = await page.context().request.post(`${origin}/v1/context-changes`, { data: r, headers: { origin, "x-grokbox-installation-id": C_INSTALL, "x-grokbox-csrf": (await session.json()).data.csrfToken } });
      assert.equal(denied.status(), 403); assert.equal(f.state.calls.filter(c => c === "initialize").length, before);
    }, C_READER);
    await withPage(async (page, f, origin) => {
      const denied = await page.context().request.post(`${origin}/v1/context-changes`, { data: await f.declaration("reset"), headers: { origin, "x-grokbox-installation-id": C_INSTALL } });
      assert.equal(denied.status(), 403);
      await page.locator("#context-action").selectOption("reset"); await confirm(page); await editor(page).getByRole("button", { name: "Submit context change", exact: true }).click(); await state(page, "prepared");
      await consent(page); assert.equal(await editor(page).getByRole("button", { name: "Release original context hold", exact: true }).isDisabled(), true);
    }, C_WRITER);
  });

  await t.test("original history stays available when native state cannot be read and never retargets to a selected different Bot", async () => withPage(async (page, f, origin) => {
    const r = await f.declaration("capture"), result = (await f.client().changeContext(r)).data;
    await page.goto(`${origin}/contexts?bot=${C_TARGET}&operationRef=${encodeURIComponent(result.operationRef)}`);
    await page.locator('[data-testid="context-history"]').waitFor(); await page.getByRole("alert").filter({ hasText: "does not belong" }).waitFor();
    assert.equal(await editor(page).getByRole("button", { name: "Read original context result", exact: true }).count(), 0);
    f.state.failNative = true; await page.reload(); await page.locator('[data-testid="context-history"]').waitFor();
    assert.ok((await page.locator('[data-testid="context-history"]').innerText()).includes("captured"));
    assert.equal(await editor(page).count(), 0);
  }));
}
