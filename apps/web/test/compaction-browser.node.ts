import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { publishConfigFile } from "@grokbox/box-runtime/runtime";
import { compactionFixture, C_BOT, C_INSTALL, C_SCOPE, C_OWNER, C_READER } from "./compaction-fixture.ts";
type Ports = { browser: Browser; entry: string; home: string; evidence?: string; freePort: () => Promise<number>;
  launchWeb: (entry: string, home: string, origin: string, management: string) => Promise<{ child: ChildProcess }>; stop: (child: ChildProcess) => Promise<void> };
export async function compactionBrowserJourney(t: TestContext, ports: Ports) {
  async function withPage(run: (page: Page, f: Awaited<ReturnType<typeof compactionFixture>>, origin: string) => Promise<void>, token = C_OWNER) {
    const origin = `http://127.0.0.1:${await ports.freePort()}`, f = await compactionFixture(origin);
    const web = await ports.launchWeb(ports.entry, ports.home, origin, f.server.url), context = await ports.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    try {
      const grant = (await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`); await page.locator("#login-code").fill(grant.code); await page.getByRole("button", { name: "安全登录", exact: true }).click();
      await page.getByRole("heading", { name: "Box 概览", exact: true }).waitFor();
      await page.goto(`${origin}/contexts?mode=compact&bot=${C_BOT}`); await editor(page).waitFor();
      await run(page, f, origin); assert.deepEqual(errors, []);
      const html = await (await context.request.get(page.url())).text(), local = await page.evaluate(() => Object.keys(localStorage).map(k => localStorage.getItem(k)).join("\n"));
      for (const secret of [grant.code, C_OWNER, "PRIVATE_SYSTEM", "PRIVATE_LATEST_INPUT", "synthetic-provider-key"]) { assert.ok(!html.includes(secret)); assert.ok(!local.includes(secret)); }
      assert.ok(!/expectedRevision|selectionRevision|policyRevision|approval|summaryInputTokens/.test(local));
    } finally { await context.close(); await ports.stop(web.child); await f.close(); }
  }
  const editor = (page: Page) => page.locator('[data-testid="compaction-editor"]');
  const state = (page: Page, value: string) => page.locator('[data-testid="compaction-result"]').getByText(value, { exact: true }).waitFor();
  const submit = async (page: Page) => { await page.locator("#compaction-confirm").check(); await editor(page).getByRole("button", { name: "Compact current context", exact: true }).click(); };
  await t.test("compaction uses the real shared management path, displays cost and history, and has no user task side effect", async () => withPage(async (page, f) => {
    assert.equal(f.state.dispatches, 0); assert.ok((await editor(page).innerText()).includes("possible summary-model cost"));
    await submit(page); await state(page, "completed"); assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1); assert.equal(f.state.userInputs, 0);
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (ports.evidence) await page.screenshot({ path: join(ports.evidence, "compaction-mobile.png"), fullPage: true });
    await page.getByRole("link", { name: "View compaction operation receipt", exact: true }).click(); await page.locator('[data-testid="operation-receipt"]').waitFor();
    assert.ok(page.url().includes("domain=compaction")); assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("Compaction operation receipt"));
  }));
  await t.test("changed cost/model plan keeps the draft and requires an explicit fresh review", async () => withPage(async (page, f) => {
    const old = await page.locator('[data-testid="compaction-draft-revision"]').innerText();
    f.models.models["fixture/compaction"]!.contextWindowTokens = 400000; await publishConfigFile(join(f.root, "models.json"), f.models);
    await submit(page); await editor(page).getByRole("alert").filter({ hasText: "revision_conflict" }).waitFor();
    assert.equal(await page.locator('[data-testid="compaction-draft-revision"]').innerText(), old); assert.equal(f.state.dispatches, 0);
    const current = (await f.client().compactionPreview(C_BOT)).data; assert.notEqual(current.revision, old);
    const read = page.waitForResponse(r => r.url().endsWith(`/v1/context-compactions/${C_BOT}`) && r.request().method() === "GET");
    await editor(page).getByRole("button", { name: "Review latest compaction plan", exact: true }).click();
    // Router invalidation may retire this CDP response body immediately. The
    // HTTP status plus the newly rendered, independently read revision are the
    // oracles; reading a retired body's text merely to format a passing assertion
    // races navigation and is not additional application evidence.
    const response = await read; assert.equal(response.status(), 200, response.statusText());
    await page.waitForFunction(v => document.querySelector('[data-testid="compaction-draft-revision"]')?.textContent === v, current.revision);
    await submit(page); await state(page, "completed"); assert.equal(f.state.dispatches, 1);
  }));
  await t.test("lost Web reply retains the original locator over refresh and querying it never repeats a summary", async () => withPage(async (page, f) => {
    let posts = 0;
    await page.route("**/v1/context-compactions", async route => { posts++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("failed"); });
    await submit(page); await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
    await page.reload(); await editor(page).waitFor(); assert.equal(await page.locator("#compaction-confirm").isDisabled(), true);
    await editor(page).getByRole("button", { name: "Read original compaction result", exact: true }).click(); await state(page, "completed");
    assert.equal(posts, 1); assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1);
    await page.unroute("**/v1/context-compactions");
  }));
  await t.test("unknown checkpoint cannot be cancelled into permission for a new compaction", async () => withPage(async (page, f) => {
    f.state.checkpointUnknown = true; await submit(page); await editor(page).getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
    await page.reload(); await editor(page).waitFor();
    await page.locator("#compaction-continue-confirm").check(); await editor(page).getByRole("button", { name: "Cancel before compaction dispatch", exact: true }).click();
    await editor(page).getByRole("alert").filter({ hasText: "revision_conflict" }).waitFor(); assert.equal(await page.locator("#compaction-confirm").isDisabled(), true);
    await page.reload(); await editor(page).getByRole("button", { name: "Read original compaction result", exact: true }).click(); await state(page, "unknown");
    assert.equal(f.state.dispatches, 1); assert.equal(f.state.checkpoints, 1);
  }));
  await t.test("readers cannot compact through a disabled button or direct bridge, and owner writes require CSRF", async () => {
    await withPage(async (page, f, origin) => {
      assert.equal(await page.locator("#compaction-confirm").isDisabled(), true);
      const session = await page.context().request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": C_INSTALL } });
      const p = (await f.client().compactionPreview(C_BOT)).data;
      const result = await page.context().request.post(`${origin}/v1/context-compactions`, { headers: { origin, "x-grokbox-installation-id": C_INSTALL, "x-grokbox-csrf": (await session.json()).data.csrfToken },
        data: { botRef: p.botRef, requestId: randomUUID(), scopeId: C_SCOPE, expectedRevision: p.revision, confirmed: true } });
      assert.equal(result.status(), 403); assert.equal(f.state.dispatches, 0);
    }, C_READER);
    await withPage(async (page, f, origin) => {
      const p = (await f.client().compactionPreview(C_BOT)).data;
      const result = await page.context().request.post(`${origin}/v1/context-compactions`, { headers: { origin, "x-grokbox-installation-id": C_INSTALL },
        data: { botRef: p.botRef, requestId: randomUUID(), scopeId: C_SCOPE, expectedRevision: p.revision, confirmed: true } });
      assert.equal(result.status(), 403); assert.equal(f.state.dispatches, 0);
    });
  });
  await t.test("unavailable native source leaves history readable without retargeting a different selected Bot", async () => withPage(async (page, f, origin) => {
    const p = (await f.client().compactionPreview(C_BOT)).data, r = (await f.client().compact({ requestId: randomUUID(), botRef: p.botRef, scopeId: C_SCOPE, expectedRevision: p.revision, confirmed: true })).data;
    f.state.unavailable = true;
    await page.goto(`${origin}/contexts?mode=compact&bot=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&operationRef=${encodeURIComponent(r.operationRef)}`);
    await page.locator('[data-testid="compaction-history"]').waitFor(); await page.getByRole("alert").filter({ hasText: "belongs to another Bot" }).waitFor();
    assert.equal(await editor(page).getByRole("button", { name: "Read original compaction result", exact: true }).count(), 0);
    await page.reload(); await page.locator('[data-testid="compaction-history"]').waitFor(); assert.equal(f.state.dispatches, 1);
  }));
}
