import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { lifecycleFixture, lifecycleIntent, L_OWNER, L_READER, L_SCOPE, L_INSTALL } from "./lifecycle-fixture.ts";
type Ports = { browser: Browser; entry: string; home: string; evidence?: string; freePort: () => Promise<number>;
  launchWeb: (entry: string, home: string, origin: string, management: string) => Promise<{ child: ChildProcess }>; stop: (child: ChildProcess) => Promise<void> };
export async function lifecycleBrowserJourney(t: TestContext, ports: Ports) {
  async function withPage(run: (page: Page, f: Awaited<ReturnType<typeof lifecycleFixture>>, origin: string) => Promise<void>, token = L_OWNER) {
    const origin = `http://127.0.0.1:${await ports.freePort()}`, f = await lifecycleFixture(origin);
    const web = await ports.launchWeb(ports.entry, ports.home, origin, f.server.url), context = await ports.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(12000); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      const grant = (await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`); await page.locator("#login-code").fill(grant.code); await page.getByRole("button", { name: "安全登录", exact: true }).click();
      await page.getByRole("heading", { name: "Box 概览", exact: true }).waitFor();
      await page.goto(`${origin}/lifecycles`); await page.getByRole("heading", { name: "Bot lifecycles", exact: true }).waitFor();
      await run(page, f, origin); assert.deepEqual(errors, []);
      const html = await (await context.request.get(page.url())).text();
      for (const secret of [L_OWNER, grant.code, "PRIVATE_LIFECYCLE_INSTRUCTIONS", "PRIVATE_SOURCE_DESCRIPTION", "PRIVATE_MATERIAL"]) assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
    } finally { await context.close(); await ports.stop(web.child); await f.close(); }
  }
  const create = async (f: Awaited<ReturnType<typeof lifecycleFixture>>, kind: "clone" | "replace" = "clone") => {
    const intent = lifecycleIntent(kind), preview = (await f.client().previewLifecycle(intent)).data;
    return (await f.client().submitLifecycle({ ...intent, scopeId: L_SCOPE, planRevision: preview.planRevision, confirmed: true })).data;
  };
  await t.test("production lifecycle history exposes scoped stages without loading instructions or offering task creation", async () => withPage(async (page, f, origin) => {
    const result = await create(f);
    await page.getByRole("button", { name: "Refresh lifecycle history", exact: true }).click();
    await page.getByRole("link", { name: result.requestId, exact: true }).click(); await page.locator('[data-testid="lifecycle-receipt"]').waitFor();
    const text = await page.locator('[data-testid="lifecycle-receipt"]').innerText(); assert.ok(text.includes(result.planRevision)); assert.ok(text.includes(result.targetBotRef!));
    assert.equal(await page.getByRole("button", { name: /create|start|resume/i }).count(), 0);
    const calls = f.state.calls.length; await page.reload(); await page.locator('[data-testid="lifecycle-receipt"]').waitFor(); assert.equal(f.state.calls.length, calls);
    await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (ports.evidence) { await mkdir(ports.evidence, { recursive: true }); await page.screenshot({ path: join(ports.evidence, "lifecycle-mobile.png"), fullPage: true }); }
    await page.setViewportSize({ width: 1440, height: 1000 }); if (ports.evidence) await page.screenshot({ path: join(ports.evidence, "lifecycle-desktop.png"), fullPage: true });
    const session = await page.context().request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": L_INSTALL } });
    const response = await page.context().request.post(`${origin}/v1/lifecycle-resumptions`, { headers: { origin, "x-grokbox-installation-id": L_INSTALL, "x-grokbox-csrf": (await session.json()).data.csrfToken },
      data: { requestId: result.requestId, scopeId: L_SCOPE, planRevision: result.planRevision, confirmed: true } });
    assert.ok(response.status() >= 400); assert.equal(f.state.created, 1);
  }));
  await t.test("unknown native birth stays visible after refresh while the native source is unavailable", async () => withPage(async (page, f, origin) => {
    f.state.failBirth = true; const result = await create(f); f.state.failNative = true;
    await page.goto(`${origin}/lifecycles?operation=${encodeURIComponent(result.operationRef)}`); await page.locator('[data-testid="lifecycle-receipt"]').waitFor();
    assert.ok((await page.locator('[data-testid="lifecycle-receipt"]').innerText()).includes("effect_unknown"));
    await page.reload(); await page.locator('[data-testid="lifecycle-receipt"]').waitFor();
    assert.ok((await page.locator('[data-testid="lifecycle-receipt"]').innerText()).includes("Not durably associated")); assert.equal(f.state.created, 1);
  }));
  await t.test("a reader sees only their own window and cannot use a known reference to read another actor's operation", async () => withPage(async (page, f, origin) => {
    const result = await create(f);
    await page.goto(`${origin}/lifecycles?operation=${encodeURIComponent(result.operationRef)}`);
    await page.getByRole("alert").filter({ hasText: "not_found" }).waitFor(); assert.equal(await page.locator('[data-testid="lifecycle-receipt"]').count(), 0);
    assert.ok(!(await page.locator("body").innerText()).includes(result.targetBotRef!));
  }, L_READER));
  await t.test("the original replacement links to unfinished handover metadata without making it a retirement certificate", async () => withPage(async (page, f, origin) => {
    const result = await create(f, "replace");
    await page.goto(`${origin}/lifecycles?operation=${encodeURIComponent(result.operationRef)}`);
    await page.getByRole("link", { name: "Inspect remaining handover duties", exact: true }).click();
    await page.locator('[data-testid="protection-handover"]').waitFor();
    assert.ok((await page.locator('[data-testid="protection-handover"]').innerText()).includes("not proven")); assert.equal(f.state.created, 1);
  }));
}
