import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { webFixture, INSTALLATION, FIRST, SECOND, OWNER, READER, KEY_SENTINEL } from "./fixture.ts";
import { httpsFixture } from "./https-fixture.ts";
import { seedObservations } from "./observation-fixture.ts";
import { receiverBrowserJourney } from "./receiver-browser.node.ts";
import { setupBrowserJourney } from "./setup-browser.node.ts";
import { materialsBrowserJourney } from "./materials-browser.node.ts";
import { protectionBrowserJourney } from "./protection-browser.node.ts";
import { lifecycleBrowserJourney } from "./lifecycle-browser.node.ts";
import { contextBrowserJourney } from "./context-browser.node.ts";
import { compactionBrowserJourney } from "./compaction-browser.node.ts";
import { hostHealthBrowserJourney } from "./host-health-browser.node.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
  await closed; clearTimeout(kill);
}
async function launchWeb(entry: string, home: string, origin: string, managementUrl: string, port?: number, args: string[] = []) {
  const child = spawn("node", [entry, ...args], { cwd: home, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "production", GROKBOX_WEB_ORIGIN: origin,
    GROKBOX_WEB_PORT: String(port ?? new URL(origin).port), GROKBOX_MANAGEMENT_URL: managementUrl, GROKBOX_INSTALLATION_ID: INSTALLATION,
  } });
  let stdout = "", stderr = "";
  child.stdout!.on("data", data => { stdout = (stdout + data.toString()).slice(-8192); });
  child.stderr!.on("data", data => { stderr = (stderr + data.toString()).slice(-8192); });
  const deadline = Date.now() + 12_000;
  while (!stdout.includes('"state":"running"')) {
    if (child.exitCode !== null || Date.now() > deadline) { await stop(child); throw new Error(`Web startup failed: ${stderr}`); }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return { child, diagnostics: () => stderr };
}
async function cli(root: string, entry: string, args: string[], input?: unknown) {
  const child = spawn("node", [entry, ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH ?? "", HOME: root, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root,
    SYNTHETIC_MANAGEMENT_CREDENTIAL: OWNER, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0",
  } });
  let stdout = "", stderr = "";
  child.stdout!.on("data", data => { stdout += data.toString(); if (stdout.length > 512 * 1024) child.kill("SIGKILL"); });
  child.stderr!.on("data", data => { stderr = (stderr + data.toString()).slice(-4096); });
  child.stdin!.on("error", () => undefined); child.stdin!.end(input === undefined ? undefined : JSON.stringify(input));
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code, signal] = await once(child, "close"); clearTimeout(deadline);
  assert.equal(signal, null, stderr); assert.equal(code, 0, `${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}
async function visible(page: Page, selector: string) {
  try { await page.locator(selector).waitFor({ state: "visible", timeout: 12_000 }); }
  catch (error) { throw new Error(`${String(error)}\nPage: ${(await page.locator("body").innerText()).slice(0, 3000)}`); }
}
async function login(page: Page, context: BrowserContext, f: Awaited<ReturnType<typeof webFixture>>, origin: string, token = OWNER) {
  const grant = (await f.client(token).createConsoleGrant(origin)).data;
  await page.goto(`${origin}/login`);
  await visible(page, "#login-code");
  await page.locator("#login-code").fill(grant.code);
  await page.getByRole("button", { name: "安全登录", exact: true }).click();
  await page.getByRole("heading", { name: "Box 概览", exact: true }).waitFor({ timeout: 12_000 });
  const cookies = await context.cookies();
  const cookie = cookies.find(item => item.name === "grokbox-console-local");
  assert.ok(cookie); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, "Strict");
  return { code: grant.code, cookie: cookie.value };
}

test("relocated production Web: real Chrome, shared CLI/domain, recovery and process lifetime", { timeout: 150_000 }, async t => {
  const artifact = process.env.GROKBOX_WEB_ARTIFACT, cliEntry = process.env.GROKBOX_TEST_CLI_ENTRY;
  assert.ok(artifact && cliEntry);
  const directory = await mkdtemp(join(tmpdir(), "grokbox-web-browser-"));
  const relocated = join(directory, "installed-web"); await cp(artifact, relocated, { recursive: true });
  const origin = `http://127.0.0.1:${await freePort()}`, f = await webFixture(origin);
  let web: Awaited<ReturnType<typeof launchWeb>> | undefined, browser: Browser | undefined;
  const evidence = process.env.GROKBOX_WEB_EVIDENCE;
  const errors: string[] = [], foreignRequests: string[] = [];
  let recoveredId: string | undefined;
  try {
    web = await launchWeb(join(relocated, "run.mjs"), directory, origin, f.server.url);
    browser = await chromium.launch({ executablePath: process.env.GROKBOX_TEST_CHROME ?? "/usr/bin/google-chrome", headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (!request.url().startsWith(`${origin}/`) && !request.url().startsWith("data:")) foreignRequests.push(request.url()); });
    let auth: { code: string; cookie: string };

    await t.test("production artifact is complete, relocatable, and has no browser-side server imports", async () => {
      const manifest = JSON.parse(await readFile(join(relocated, "manifest.json"), "utf8"));
      assert.equal(manifest.node, ">=22.12.0"); assert.match(manifest.sourceDigest, /^[a-f0-9]{64}$/);
      for (const [path, info] of Object.entries(manifest.files) as Array<[string, { sha256: string; bytes: number }]>) {
        const bytes = await readFile(join(relocated, path)); assert.equal(bytes.length, info.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), info.sha256);
      }
      for (const file of await readdir(join(relocated, "client", "assets"))) {
        if (!file.endsWith(".js")) continue;
        const text = await readFile(join(relocated, "client", "assets", file), "utf8");
        for (const secret of ["GROKBOX_MANAGEMENT_URL", "grokboxOwnership", "node:fs", "createConsoleBridge", OWNER, KEY_SENTINEL]) assert.ok(!text.includes(secret), `Browser bundle includes ${secret}`);
      }
      const response = await context.request.get(`${origin}/bots`, { maxRedirects: 0 });
      assert.ok([302, 307].includes(response.status())); assert.equal(response.headers()["location"], "/login");
      const code = (await f.client().createConsoleGrant(origin)).data.code;
      const body = await (await context.request.get(`${origin}/login`)).text();
      assert.ok(body.includes("登录控制台")); assert.ok(!body.includes(code));
      assert.ok(!body.includes("csrfToken")); assert.ok(!body.includes(OWNER));
      const denied = await context.request.get(`${origin}/assets/../server/server.js`);
      assert.notEqual(denied.status(), 200);
    });

    await t.test("login, SSR hydration and public-only page state", async () => {
      auth = await login(page, context, f, origin);
      const response = await context.request.get(`${origin}/`), html = await response.text();
      assert.ok(html.includes("Synthetic First"), "Authenticated HTML must include real SSR query data.");
      assert.equal(response.headers()["cache-control"], "no-store");
      const session = await context.request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": INSTALLATION } });
      assert.equal(session.status(), 200);
      const csrf = (await session.json()).data.csrfToken;
      for (const secret of [auth.code, auth.cookie, csrf, OWNER, READER, KEY_SENTINEL]) assert.ok(!html.includes(secret));
      assert.ok(!html.includes('"csrfToken"'));
      assert.ok((await page.locator("body").innerText()).includes("27"));
      if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "overview-desktop.png"), fullPage: true }); }
      assert.deepEqual(errors, []);
    });

    await t.test("observation pages distinguish a missing source without initializing or querying native services", async () => {
      const before = await readdir(f.root), nativeReads = f.state.reads, ownershipReads = f.state.ownershipReads;
      await page.goto(`${origin}/observation`);
      await page.getByRole("alert").filter({ hasText: "source_unavailable" }).waitFor();
      assert.deepEqual(await readdir(f.root), before); assert.equal(f.state.reads, nativeReads); assert.equal(f.state.ownershipReads, ownershipReads);
      assert.ok(!(await page.locator("body").innerText()).includes("全系统健康"));
    });

    await t.test("persistent observation, incident and event pages consume the same source as formal CLI commands", async () => {
      const seeded = await seedObservations(f), nativeReads = f.state.reads, ownershipReads = f.state.ownershipReads;
      await page.goto(`${origin}/observation`);
      await page.getByRole("heading", { name: "持续观察", exact: true }).waitFor();
      await page.getByText("confirmed_box", { exact: true }).first().waitFor();
      const snapshot = (await f.client().observation()).data;
      await page.getByRole("heading", { name: "管理服务与后台采集", exact: true }).waitFor();
      const cliService = await cli(f.root, cliEntry, ["system", "service", "get", "server"]);
      assert.equal(cliService.data.component, "server"); assert.equal(cliService.data.observation.owner, "management-server");
      assert.equal(cliService.data.observation.state, "not_configured");
      const cliSnapshot = await cli(f.root, cliEntry, ["system", "observation", "get"]);
      assert.equal(cliSnapshot.data.cursor, snapshot.cursor);
      assert.equal(cliSnapshot.data.databaseId, snapshot.databaseId);
      const html = await (await context.request.get(`${origin}/observation`)).text();
      assert.ok(html.includes("confirmed_box")); assert.ok(!html.includes("csrfToken"));
      if (evidence) await page.screenshot({ path: join(evidence, "observation-desktop.png"), fullPage: true });
      await page.getByRole("link", { name: "从此快照接续变化 →", exact: true }).click();
      await page.getByText("该游标之后暂未记录新变化；不证明上游没有变化。", { exact: true }).waitFor();
      await seeded.sample(seeded.at + 2, "temporal");
      await page.getByRole("button", { name: "重新读取当前区间", exact: true }).click();
      await page.getByText("ownership_changed", { exact: true }).first().waitFor();
      const cliEvents = await cli(f.root, cliEntry, ["event", "list", "--cursor", snapshot.cursor]);
      assert.ok(cliEvents.data.entries.some((row: { kind: string }) => row.kind === "ownership_changed"));
      await page.getByRole("link", { name: "持久异常", exact: true }).click();
      await page.getByRole("heading", { name: "持久异常", exact: true }).waitFor();
      await page.getByText("ownership_conflict", { exact: true }).first().waitFor();
      const cliIncidents = await cli(f.root, cliEntry, ["incident", "list"]);
      assert.equal(await page.locator("tbody tr").count(), cliIncidents.data.incidents.length);
      assert.equal(f.state.reads, nativeReads, "Observation pages and CLI reads must never call native list.");
      assert.equal(f.state.ownershipReads, ownershipReads, "Status and snapshot reads must never invoke native ownership reads.");
      if (evidence) await page.screenshot({ path: join(evidence, "incidents-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin}/observation`);
      await page.getByRole("heading", { name: "持续观察", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.setViewportSize({ width: 1440, height: 1000 });
      await f.observations.finish(seeded.epoch, seeded.at + 3);
      await f.observations.begin(randomUUID(), seeded.at + 4, [FIRST, SECOND]);
      await page.goto(`${origin}/events?cursor=${encodeURIComponent(snapshot.cursor)}`);
      await page.getByRole("alert").filter({ hasText: "cursor_gap" }).waitFor();
      await page.getByRole("link", { name: "重新获取快照", exact: true }).click();
      await page.getByRole("heading", { name: "持续观察", exact: true }).waitFor();
    });

    await t.test("Bot paging, navigation, stable identity and non-leaking per-object form state", async () => {
      await page.goto(`${origin}/bots`); await visible(page, "#bot-filter");
      assert.equal(await page.locator("tbody tr").count(), 25);
      await page.getByRole("link", { name: "下一页 →", exact: true }).click();
      await page.waitForURL(/cursor=/);
      await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 2);
      await page.goBack(); await visible(page, "#bot-filter");
      await page.waitForFunction(() => document.querySelectorAll("tbody tr").length === 25);
      await page.getByRole("link", { name: "Synthetic First", exact: true }).click();
      await page.getByRole("radio", { name: "指定模型", exact: true }).check();
      await page.locator("#bot-model").fill("draft-only-marker");
      await page.getByRole("link", { name: "← Bot 列表", exact: true }).click();
      await page.getByRole("link", { name: "Synthetic Second", exact: true }).click();
      await page.getByRole("radio", { name: "指定模型", exact: true }).check();
      assert.equal(await page.locator("#bot-model").inputValue(), "");
      await page.goto(`${origin}/bots/${FIRST}`);
      await page.getByRole("radio", { name: "跟随默认", exact: true }).check();
      await page.getByRole("button", { name: "保存 Bot 模型选择", exact: true }).click();
      await page.getByText("配置已保存，供后续轮次采用", { exact: true }).waitFor();
      assert.equal((await f.client().botModel(FIRST)).data.selection.kind, "default");
      const output = await cli(f.root, cliEntry, ["bot", "model", "get", FIRST]);
      assert.equal(output.data.selection.kind, "default");
    });

    await t.test("real CLI concurrent model patch refuses stale browser revision and preserves draft", async () => {
      await page.goto(`${origin}/models?selected=channel%2Ffirst`); await visible(page, "#edit-alias");
      await page.locator("#edit-alias").fill("browser-draft");
      const expectedRevision = (await f.client().model("channel/first")).data.revision;
      const output = await cli(f.root, cliEntry, ["model", "apply", "--input", "-"], {
        modelId: "channel/first", mode: "patch", model: { alias: "cli-alias" }, requestId: randomUUID(), expectedRevision,
      });
      assert.equal(output.data.state, "succeeded");
      await page.getByRole("button", { name: "保存模型配置", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "revision_conflict" }).waitFor();
      assert.equal(await page.locator("#edit-alias").inputValue(), "browser-draft");
      assert.equal((await f.client().model("channel/first")).data.model.alias, "cli-alias");
      const editor = page.locator("section.card").filter({ has: page.locator("#edit-alias") });
      await editor.getByRole("button", { name: "读取最新版本，保留草稿", exact: true }).click();
      await editor.getByText("cli-alias", { exact: true }).waitFor();
      await page.getByRole("button", { name: "保存模型配置", exact: true }).click();
      await page.getByText("配置已保存，供后续轮次采用", { exact: true }).waitFor();
      assert.equal((await f.client().model("channel/first")).data.model.alias, "browser-draft");
      assert.equal(await page.locator("#edit-key-ref").inputValue(), "");
    });

    await t.test("lost committed response is recovered after page refresh without another POST", async () => {
      await page.goto(`${origin}/bots/${FIRST}`);
      await page.getByRole("radio", { name: "原生模型", exact: true }).check();
      let posts = 0;
      await page.route("**/v1/model-changes", async route => {
        posts++;
        const response = await route.fetch(); assert.equal(response.status(), 200);
        await route.abort("failed");
      });
      await page.getByRole("button", { name: "保存 Bot 模型选择", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
      recoveredId = await page.evaluate(() => {
        const rows = Object.keys(localStorage).filter(key => key.startsWith("grokbox:operation:")).map(key => JSON.parse(localStorage.getItem(key)!));
        return rows.sort((a, b) => b.createdAt - a.createdAt)[0].requestId as string;
      });
      assert.equal(posts, 1); assert.equal((await f.client().modelOperation(recoveredId!)).data.state, "succeeded");
      await page.unroute("**/v1/model-changes");
      await page.getByRole("link", { name: "查询原操作回执", exact: true }).click();
      await visible(page, '[data-testid="operation-receipt"]');
      await page.reload(); await visible(page, '[data-testid="operation-receipt"]');
      assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("配置提交已确认"));
      assert.equal(posts, 1);
    });

    await t.test("incident drafts survive CLI revision conflicts and use the same durable writer", async () => {
      const incident = (await f.client().incidents()).data.incidents.find(row => row.status === "open")!;
      assert.ok(incident);
      await page.goto(`${origin}/incidents?selected=${encodeURIComponent(incident.incidentRef)}`);
      await page.getByRole("radio", { name: "暂缓提醒", exact: true }).check();
      const deadline = new Date(Date.now() + 3600_000); deadline.setSeconds(0, 0);
      const local = `${deadline.getFullYear()}-${String(deadline.getMonth() + 1).padStart(2, "0")}-${String(deadline.getDate()).padStart(2, "0")}T${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}`;
      await page.locator("#incident-until").fill(local);
      const output = await cli(f.root, cliEntry, ["incident", "ack", incident.incidentRef, "--request-id", randomUUID(), "--expect-revision", String(incident.revision)]);
      assert.equal(output.data.repaired, false);
      await page.getByRole("button", { name: "保存异常处理", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "revision_conflict" }).waitFor();
      assert.equal(await page.locator("#incident-until").inputValue(), local);
      await page.getByRole("button", { name: "读取最新异常版本，保留草稿", exact: true }).click();
      await page.getByText(`草稿使用版本 ${output.data.appliedRevision}`, { exact: false }).waitFor();
      await page.getByRole("button", { name: "保存异常处理", exact: true }).click();
      await page.getByText("异常管理已记录，未宣称修复", { exact: true }).waitFor();
      const detail = (await f.client().incident(incident.incidentRef)).data.incident;
      assert.equal(detail.acknowledged, true); assert.equal(detail.status, "open"); assert.ok(detail.snoozeUntilMs! > Date.now());
    });

    await t.test("lost incident reply blocks replacement writes through refresh and recovers by original domain locator", async () => {
      const incident = (await f.client().incidents()).data.incidents.find(row => row.status === "open")!;
      await page.goto(`${origin}/incidents?selected=${encodeURIComponent(incident.incidentRef)}`);
      let posts = 0;
      await page.route("**/v1/incident-changes", async route => { posts++; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort("failed"); });
      await page.getByRole("button", { name: "保存异常处理", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "operation_unknown" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "保存异常处理", exact: true }).isDisabled(), true);
      await page.reload(); await page.getByRole("button", { name: "查询原异常操作", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "保存异常处理", exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "查询原异常操作", exact: true }).click();
      await page.getByText("异常管理已记录，未宣称修复", { exact: true }).waitFor();
      assert.equal(posts, 1); await page.unroute("**/v1/incident-changes");
      await page.getByRole("link", { name: "查询异常操作回执", exact: true }).click();
      await visible(page, '[data-testid="operation-receipt"]'); assert.ok(page.url().includes("domain=incident"));
      assert.ok((await page.locator('[data-testid="operation-receipt"]').innerText()).includes("异常管理已记录"));
    });

    await t.test("browser event stream reconnects read-only, receives committed changes and exposes epoch gaps", async () => {
      const snapshot = (await f.client().observation()).data, nativeReads = f.state.reads, ownershipReads = f.state.ownershipReads;
      let connections = 0;
      await page.route("**/v1/observation-events/watch?**", route => { connections++; return connections === 1 ? route.abort("failed") : route.continue(); });
      await page.goto(`${origin}/events?cursor=${encodeURIComponent(snapshot.cursor)}&watch=true`);
      await page.locator('[data-testid="event-watch-status"] strong').filter({ hasText: /^connected$/ }).waitFor();
      assert.ok(connections >= 2);
      const incident = (await f.client().incidents()).data.incidents.find(row => row.status === "open")!;
      await cli(f.root, cliEntry, ["incident", "ack", incident.incidentRef, "--request-id", randomUUID(), "--expect-revision", String(incident.revision)]);
      await page.locator("tbody tr").filter({ hasText: "incident_ack" }).waitFor();
      assert.equal(await page.locator("tbody tr").filter({ hasText: "incident_ack" }).count(), 1);
      await f.observations.finish(snapshot.collectorEpoch!, Date.now());
      await f.observations.begin(randomUUID(), Date.now(), [FIRST, SECOND]);
      await page.getByRole("alert").filter({ hasText: "cursor_gap" }).waitFor();
      await page.getByRole("button", { name: "从新快照重新接续", exact: true }).click();
      await page.locator('[data-testid="event-watch-status"] strong').filter({ hasText: /^connected$/ }).waitFor();
      assert.equal(f.state.reads, nativeReads); assert.equal(f.state.ownershipReads, ownershipReads);
      await page.getByRole("button", { name: "停止订阅", exact: true }).click();
      await page.unroute("**/v1/observation-events/watch?**");
      const deadline = Date.now() + 2000;
      while (f.server.status().activeRequests && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(f.server.status().activeRequests, 0);
    });

    await t.test("notification page observes the management-owned worker without starting native work or granting consent", async () => {
      const reads = f.state.reads, ownershipReads = f.state.ownershipReads;
      await page.goto(`${origin}/notifications`);
      await visible(page, '[data-testid="notification-worker"]');
      assert.ok((await page.locator('[data-testid="notification-worker"]').innerText()).includes("management-server"));
      const status = await cli(f.root, cliEntry, ["notification", "status"]);
      assert.equal(status.data.owner, "management-server"); assert.equal(status.data.botReport, "not_observed");
      await page.getByRole("button", { name: "读取通知状态", exact: true }).click();
      assert.equal(f.state.reads, reads); assert.equal(f.state.ownershipReads, ownershipReads);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await page.setViewportSize({ width: 1440, height: 1000 });
      if (evidence) await page.screenshot({ path: join(evidence, "notifications-desktop.png"), fullPage: true });
    });

    await t.test("read-only identity is isolated in both SSR and browser mutation permission", async () => {
      const readContext = await browser!.newContext();
      try {
        const readPage = await readContext.newPage();
        await login(readPage, readContext, f, origin, READER);
        await readPage.goto(`${origin}/bots/${FIRST}`);
        const save = readPage.getByRole("button", { name: "保存 Bot 模型选择", exact: true });
        await save.waitFor(); assert.equal(await save.isDisabled(), true);
        const session = await readContext.request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": INSTALLATION } });
        const sessionData = (await session.json()).data; assert.equal(sessionData.principalId, "reader");
        const revision = (await f.client().defaultModel()).data.revision;
        const denied = await readContext.request.post(`${origin}/v1/model-changes`, { headers: { origin, "x-grokbox-installation-id": INSTALLATION, "x-grokbox-csrf": sessionData.csrfToken },
          data: { requestId: randomUUID(), expectedRevision: revision, change: { kind: "bot-selection", agentId: FIRST, selection: { kind: "default" } } } });
        assert.equal(denied.status(), 403); assert.equal((await f.client().defaultModel()).data.revision, revision);
        const ownHtml = await (await context.request.get(`${origin}/`)).text(), readerHtml = await (await readContext.request.get(`${origin}/`)).text();
        assert.ok(ownHtml.includes('"principalId":"owner"') || ownHtml.includes('owner'));
        assert.ok(readerHtml.includes("reader"));
        await readPage.goto(`${origin}/observation`);
        await readPage.getByRole("alert").filter({ hasText: "permission_denied" }).waitFor();
        assert.equal(await readPage.locator("tbody tr").count(), 0);
        await readPage.goto(`${origin}/notifications`);
        await readPage.getByRole("alert").filter({ hasText: "permission_denied" }).waitFor();
        assert.equal(await readPage.locator('[data-testid="notification-worker"]').count(), 0);
      } finally { await readContext.close(); }
    });

    await t.test("incident writes require both CSRF and independent incident permission in a real browser session", async () => {
      const prior = [...f.state.grants[1]!.capabilities]; f.state.grants[1]!.capabilities = [...prior, "observations.read"];
      const readContext = await browser!.newContext();
      try {
        const readPage = await readContext.newPage(); await login(readPage, readContext, f, origin, READER);
        const incident = (await f.client().incidents()).data.incidents.find(row => row.status === "open")!;
        await readPage.goto(`${origin}/incidents?selected=${encodeURIComponent(incident.incidentRef)}`);
        const save = readPage.getByRole("button", { name: "保存异常处理", exact: true }); await save.waitFor(); assert.equal(await save.isDisabled(), true);
        const session = await readContext.request.get(`${origin}/v1/console/session`, { headers: { "x-grokbox-installation-id": INSTALLATION } });
        const input = { requestId: randomUUID(), incidentRef: incident.incidentRef, expectedRevision: incident.revision, action: "ack" };
        const denied = await readContext.request.post(`${origin}/v1/incident-changes`, { data: input,
          headers: { origin, "x-grokbox-installation-id": INSTALLATION, "x-grokbox-csrf": (await session.json()).data.csrfToken } });
        assert.equal(denied.status(), 403);
        const noCsrf = await context.request.post(`${origin}/v1/incident-changes`, { data: input, headers: { origin, "x-grokbox-installation-id": INSTALLATION } });
        assert.equal(noCsrf.status(), 403);
        assert.equal((await f.client().incident(incident.incidentRef)).data.incident.revision, incident.revision);
      } finally { f.state.grants[1]!.capabilities = prior; await readContext.close(); }
    });

    await t.test("source failure is not an empty list and mobile layout remains bounded", async () => {
      f.state.nativeUnavailable = true;
      await page.goto(`${origin}/bots`);
      await page.getByRole("alert").filter({ hasText: "source_unavailable" }).waitFor();
      assert.equal(await page.locator("tbody tr").count(), 0);
      assert.ok(!(await page.locator("body").innerText()).includes("当前来源返回空成员快照"));
      f.state.nativeUnavailable = false;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin}/models`); await page.getByRole("heading", { name: "模型配置", exact: true }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      if (evidence) await page.screenshot({ path: join(evidence, "models-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    });

    await t.test("Web restart preserves management session and never owns management process lifetime", async () => {
      await stop(web!.child); assert.equal(f.server.status().state, "running");
      assert.equal((await f.client().identity()).data.installationId, INSTALLATION);
      web = await launchWeb(join(relocated, "run.mjs"), directory, origin, f.server.url);
      await page.goto(`${origin}/operations?requestId=${recoveredId}`);
      await visible(page, '[data-testid="operation-receipt"]');
      assert.equal((await f.client().modelOperation(recoveredId!)).data.state, "succeeded");
    });

    await t.test("formal CLI Web entry owns only its foreground Web child", async () => {
      await stop(web!.child);
      web = await launchWeb(cliEntry, directory, origin, f.server.url, undefined, ["system", "service", "run", "web",
        "--console-origin", origin, "--management-url", f.server.url, "--installation-id", INSTALLATION, "--port", new URL(origin).port]);
      await page.goto(`${origin}/bots`); await visible(page, "#bot-filter");
      assert.equal(f.server.status().state, "running");
      await stop(web.child);
      assert.equal((await f.client().identity()).data.installationId, INSTALLATION);
      web = await launchWeb(join(relocated, "run.mjs"), directory, origin, f.server.url);
    });

    await t.test("browser HTTPS proxy uses Secure host-only cookies and the same protected domain", async () => {
      const publicPort = await freePort(), upstreamPort = await freePort(), secureOrigin = `https://127.0.0.1:${publicPort}`;
      const tlsDirectory = join(directory, "tls"); await mkdir(tlsDirectory);
      const secureFixture = await webFixture(secureOrigin);
      let secureWeb: Awaited<ReturnType<typeof launchWeb>> | undefined, proxy: Awaited<ReturnType<typeof httpsFixture>> | undefined;
      const secureContext = await browser!.newContext({ ignoreHTTPSErrors: true });
      try {
        secureWeb = await launchWeb(join(relocated, "run.mjs"), directory, secureOrigin, secureFixture.server.url, upstreamPort);
        proxy = await httpsFixture(tlsDirectory, publicPort, upstreamPort);
        const securePage = await secureContext.newPage();
        const grant = (await secureFixture.client().createConsoleGrant(secureOrigin)).data;
        await securePage.goto(`${secureOrigin}/login`); await visible(securePage, "#login-code");
        await securePage.locator("#login-code").fill(grant.code);
        await securePage.getByRole("button", { name: "安全登录", exact: true }).click();
        await securePage.getByRole("heading", { name: "Box 概览", exact: true }).waitFor();
        const cookie = (await secureContext.cookies()).find(item => item.name === "__Host-grokbox-console");
        assert.ok(cookie); assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.path, "/");
        await securePage.goto(`${secureOrigin}/bots/${FIRST}`);
        await securePage.getByRole("radio", { name: "跟随默认", exact: true }).check();
        await securePage.getByRole("button", { name: "保存 Bot 模型选择", exact: true }).click();
        await securePage.getByText("配置已保存，供后续轮次采用", { exact: true }).waitFor();
        assert.equal((await secureFixture.client().botModel(FIRST)).data.selection.kind, "default");
        const response = await secureContext.request.get(`${secureOrigin}/v1/console/session`, { headers: { "x-grokbox-installation-id": INSTALLATION } });
        assert.equal(response.status(), 200);
        const denied = await secureContext.request.post(`${secureOrigin}/v1/console/logout`, { headers: { "x-grokbox-installation-id": INSTALLATION, origin: secureOrigin }, data: {} });
        assert.equal(denied.status(), 403);
        const observations = await seedObservations(secureFixture);
        const snapshot = (await secureFixture.client().observation()).data;
        await securePage.goto(`${secureOrigin}/events?cursor=${encodeURIComponent(snapshot.cursor)}&watch=true`);
        await securePage.locator('[data-testid="event-watch-status"] strong').filter({ hasText: /^connected$/ }).waitFor();
        await observations.sample(Date.now(), "temporal");
        await securePage.locator("tbody tr").filter({ hasText: "ownership_changed" }).first().waitFor();
        const incident = (await secureFixture.client().incidents()).data.incidents.find(row => row.status === "open")!;
        await secureFixture.client().changeIncident({ requestId: randomUUID(), incidentRef: incident.incidentRef, expectedRevision: incident.revision, action: "ack" });
        await securePage.locator("tbody tr").filter({ hasText: "incident_ack" }).waitFor();
        await securePage.getByRole("button", { name: "停止订阅", exact: true }).click();
      } finally { await secureContext.close(); await proxy?.close(); if (secureWeb) await stop(secureWeb.child); await secureFixture.close(); }
    });

    await t.test("management restart requires re-login but original principal can recover earlier receipts", async () => {
      await f.restart();
      await page.goto(`${origin}/operations?requestId=${recoveredId}`);
      await visible(page, "#login-code");
      await login(page, context, f, origin);
      await page.goto(`${origin}/operations?requestId=${recoveredId}`); await visible(page, '[data-testid="operation-receipt"]');
    });

    await t.test("logout clears other tabs and browser has no hydration errors or foreign requests", async () => {
      const otherPage = await context.newPage();
      await otherPage.goto(`${origin}/bots`); await visible(otherPage, "#bot-filter");
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await visible(page, "#login-code"); await visible(otherPage, "#login-code");
      assert.ok(!(await otherPage.locator("body").innerText()).includes("Synthetic First"));
      assert.deepEqual(errors, []); assert.deepEqual(foreignRequests, []);
      await otherPage.close();
    });
    await t.test("receiver consent, independent tests and recovery use production browser artifacts", async receiverTests => {
      await receiverBrowserJourney(receiverTests, { browser: browser!, entry: join(relocated, "run.mjs"), home: directory, evidence, freePort, launchWeb, stop });
    });
    await t.test("first setup and native-definition recovery use the same production browser and management API", async setupTests => {
      await setupBrowserJourney(setupTests, { browser:browser!,entry:join(relocated,"run.mjs"),home:directory,evidence,freePort,launchWeb,stop });
    });
    await t.test("material sources, bounded search and source recovery use the production console", async materialTests => {
      await materialsBrowserJourney(materialTests,{browser:browser!,entry:join(relocated,"run.mjs"),home:directory,evidence,freePort,launchWeb,stop});
    });
    await t.test("default protection, policy recovery and metadata use the production browser",async protectionTests=>{
      await protectionBrowserJourney(protectionTests,{browser:browser!,entry:join(relocated,"run.mjs"),home:directory,evidence,freePort,launchWeb,stop});
    });
    await t.test("manual lifecycle history remains an observational production browser surface", async lifecycleTests => {
      await lifecycleBrowserJourney(lifecycleTests, { browser: browser!, entry: join(relocated, "run.mjs"), home: directory, evidence, freePort, launchWeb, stop });
    });
    await t.test("current-state control and original recovery use native owner transactions through the production console", async contextTests => {
      await contextBrowserJourney(contextTests, { browser: browser!, entry: join(relocated, "run.mjs"), home: directory, evidence, freePort, launchWeb, stop });
      await compactionBrowserJourney(contextTests, { browser: browser!, entry: join(relocated, "run.mjs"), home: directory, evidence, freePort, launchWeb, stop });
    });
    await t.test("Host health uses real Rust and existing incidents through the production console",async healthTests=>{
      await hostHealthBrowserJourney(healthTests,{browser:browser!,entry:join(relocated,"run.mjs"),home:directory,evidence,freePort,launchWeb,stop});
    });
    await context.close();
  } finally {
    await browser?.close(); if (web) await stop(web.child); await f.close(); await rm(directory, { recursive: true, force: true });
  }
});
