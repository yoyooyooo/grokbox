import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page } from "playwright";
import { receiverFixture, RECEIVER_OWNER, RECEIVER_READER, RECEIVER_INSTALLATION, RECEIVER_MODEL } from "./receiver-fixture.ts";

type Ports = { browser: Browser; entry: string; home: string; evidence?: string; freePort: () => Promise<number>;
  launchWeb: (entry: string, home: string, origin: string, management: string) => Promise<{ child: ChildProcess }>;
  stop: (child: ChildProcess) => Promise<void> };
export async function receiverBrowserJourney(t: TestContext, ports: Ports) {
  async function withPage(run: (page: Page, f: Awaited<ReturnType<typeof receiverFixture>>, origin: string) => Promise<void>, token = RECEIVER_OWNER) {
    const origin = `http://127.0.0.1:${await ports.freePort()}`, f = await receiverFixture(origin);
    const web = await ports.launchWeb(ports.entry, ports.home, origin, f.server.url), context = await ports.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    try {
      const grant = (await f.client(token).createConsoleGrant(origin)).data;
      await page.goto(`${origin}/login`); await page.locator("#login-code").fill(grant.code);
      await page.getByRole("button", { name: "安全登录", exact: true }).click();
      await page.getByRole("heading", { name: "Box 概览", exact: true }).waitFor();
      await page.goto(`${origin}/notifications?selected=${encodeURIComponent(f.ref)}`);
      await page.locator('[data-testid="receiver-editor"]').waitFor();
      await run(page, f, origin);
      assert.deepEqual(errors, []);
      const html = await (await context.request.get(`${origin}/notifications?selected=${encodeURIComponent(f.ref)}`)).text();
      for (const secret of [RECEIVER_OWNER, "PRIVATE_TEST_KEY", grant.code]) assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
    } finally { await context.close(); await ports.stop(web.child); await f.close(); }
  }
  const verify = async (page: Page) => {
    await page.getByRole("button", { name: "Verify receiver", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector("#receiver-model-revision") as HTMLInputElement)?.value.length === 64);
  };
  const confirm = (page: Page) => page.getByRole("checkbox", { name: "I confirm this receiver change; enabling allows future bounded model wake costs.", exact: true }).check();
  const testConsent = (page: Page) => page.getByRole("checkbox", { name: "I authorize one optional test and its possible model cost.", exact: true }).check();

  await t.test("browser enables a fresh receiver without sending a test, then disables and explicitly re-enables", async () => withPage(async (page, f) => {
    assert.equal(f.requests.length, 0); assert.deepEqual(await f.store.incidents(), []);
    await verify(page); await confirm(page); await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByText("Receiver consent recorded", { exact: true }).waitFor();
    assert.equal((await f.client().receiver(f.ref)).data.revision, 2); assert.equal(f.requests.length, 0);
    await page.locator("#receiver-action").selectOption("disable"); await confirm(page);
    await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByText(/disable: revision 2 → 3/).waitFor(); assert.equal((await f.client().receiver(f.ref)).data.automatic, null);
    await page.locator("#receiver-action").selectOption("enable"); await verify(page); await confirm(page);
    await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByText(/enable: revision 3 → 4/).waitFor(); assert.ok((await f.client().receiver(f.ref)).data.automatic);
    assert.equal(f.requests.length, 0); assert.deepEqual(await f.store.incidents(), []);
    if (ports.evidence) { await mkdir(ports.evidence, { recursive: true }); await page.screenshot({ path: join(ports.evidence, "notification-receiver-desktop.png"), fullPage: true }); }
  }));

  await t.test("optional browser test before enable creates only a test delivery and links its retained receipt", async () => withPage(async (page, f) => {
    await verify(page); await testConsent(page); await page.getByRole("button", { name: "Send optional test", exact: true }).click();
    await page.getByText("Independent test receipt", { exact: true }).waitFor();
    assert.equal(f.requests.length, 1); assert.equal((await f.client().receiver(f.ref)).data.automatic, null); assert.deepEqual(await f.store.incidents(), []);
    const delivery = (await f.client().notifications()).data.notifications[0]!;
    assert.equal(delivery.purpose, "test"); assert.equal(delivery.incidentRef, null);
    await page.getByRole("link", { name: "View notification test receipt", exact: true }).click();
    await page.locator('[data-testid="operation-receipt"]').waitFor(); assert.ok(page.url().includes("domain=notification-test"));
    assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("native-accepted"));
    await page.goBack(); await page.locator('[data-testid="receiver-editor"]').waitFor();
    await page.getByRole("link", { name: delivery.workId, exact: true }).click();
    await page.locator('[data-testid="notification-delivery"]').waitFor();
    assert.ok((await page.locator('[data-testid="notification-delivery"]').innerText()).includes("none — an explicit test"));
    assert.equal(f.requests.length, 1);
  }));

  await t.test("unknown optional test blocks another test after refresh, but cannot block enabling future notifications", async () => withPage(async (page, f) => {
    f.reply(response => { response.writeHead(500); response.end("PRIVATE_TEST_FAILURE"); });
    await verify(page); await testConsent(page); await page.getByRole("button", { name: "Send optional test", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
    await page.reload(); await page.getByRole("button", { name: "Recover notification test", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send optional test", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Recover notification test", exact: true }).click();
    await page.getByText("Independent test receipt", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send optional test", exact: true }).isDisabled(), true);
    await verify(page); await confirm(page); await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByText("Receiver consent recorded", { exact: true }).waitFor();
    assert.ok((await f.client().receiver(f.ref)).data.automatic); assert.equal(f.requests.length, 1);
  }));

  await t.test("lost browser consent reply recovers by original request after refresh without resubmission", async () => withPage(async (page, f) => {
    await verify(page); await confirm(page); let posts = 0;
    await page.route("**/v1/notification-receiver-changes", async route => { posts++; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort("failed"); });
    await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
    await page.reload(); await page.getByRole("button", { name: "Recover receiver change", exact: true }).waitFor();
    assert.equal(await page.locator("#receiver-action").isDisabled(), true);
    await page.getByRole("button", { name: "Recover receiver change", exact: true }).click();
    await page.getByText("Receiver consent recorded", { exact: true }).waitFor();
    assert.equal(posts, 1); assert.equal(f.requests.length, 0);
    await page.unroute("**/v1/notification-receiver-changes");
    await page.getByRole("link", { name: "View receiver operation receipt", exact: true }).click();
    await page.locator('[data-testid="operation-receipt"]').waitFor(); assert.ok(page.url().includes("domain=receiver"));
  }));

  await t.test("receiver revision conflict preserves draft; narrow screen and local recovery contain no credentials or model input", async () => withPage(async (page, f) => {
    await verify(page); await page.locator("#receiver-action").selectOption("disable"); await confirm(page);
    await f.client().changeReceiver({ receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: RECEIVER_MODEL, action: "enable", confirmed: true });
    await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "revision_conflict" }).waitFor();
    assert.equal(await page.locator("#receiver-action").inputValue(), "disable");
    assert.equal(await page.locator("#receiver-model-revision").inputValue(), RECEIVER_MODEL);
    await page.getByRole("button", { name: "Refresh receiver revision, keep draft", exact: true }).click();
    await page.getByText(/Draft revision 2;/).waitFor();
    await page.getByRole("button", { name: "Apply receiver change", exact: true }).click();
    await page.getByText(/disable: revision 2 → 3/).waitFor();
    const locators = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("grokbox:operation:")).map(key => localStorage.getItem(key)).join("\n"));
    assert.ok(!locators.includes(RECEIVER_MODEL)); assert.ok(!locators.includes("PRIVATE_TEST_KEY"));
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (ports.evidence) await page.screenshot({ path: join(ports.evidence, "notification-receiver-mobile.png"), fullPage: true });
  }));

  await t.test("real read-only session cannot enable or test, and a valid owner still needs CSRF", async () => {
    await withPage(async (page, f, origin) => {
      assert.equal(await page.locator("#receiver-action").isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Send optional test", exact: true }).isDisabled(), true);
      const session = await page.context().request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": RECEIVER_INSTALLATION } });
      const csrf = (await session.json()).data.csrfToken;
      const input = { receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, action: "enable", expectedModelRevision: RECEIVER_MODEL, confirmed: true };
      const denied = await page.context().request.post(`${origin}/v1/notification-receiver-changes`, { data: input, headers: { origin, "x-grokbox-installation-id": RECEIVER_INSTALLATION, "x-grokbox-csrf": csrf } });
      assert.equal(denied.status(), 403); assert.equal(f.requests.length, 0); assert.equal((await f.client().receiver(f.ref)).data.revision, 1);
    }, RECEIVER_READER);
    await withPage(async (page, f, origin) => {
      const response = await page.context().request.post(`${origin}/v1/notification-tests`, { data: { receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: RECEIVER_MODEL, action: "test", confirmed: true },
        headers: { origin, "x-grokbox-installation-id": RECEIVER_INSTALLATION } });
      assert.equal(response.status(), 403); assert.equal(f.requests.length, 0); assert.deepEqual(await f.store.incidents(), []);
    });
  });
}
