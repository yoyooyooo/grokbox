import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, ManagementClientError, CAPABILITIES, botRef, type ModelChangeRequest } from "@grokbox/client";
import { ManagementSourceError, openRuntimeStore, publishConfigFile, publishLayoutAliases, type NativeBotSummary, type RuntimeStore } from "@grokbox/box-runtime/runtime";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { modelConfigurationRevision } from "@grokbox/runtime-kernel/model-management";
import { startInstalledManagementServer, startManagementServer, type AccessGrant, type ManagementNative } from "../src/server.ts";
import { ownedOwnershipReader } from "../../box-runtime/test/ownership-fixture.ts";
import { nativeFixture, CATALOG_CREDENTIAL, type NativeMode } from "./native-fixture.node.ts";

const I = "11111111-1111-4111-8111-111111111111", OTHER_I = "99999999-9999-4999-8999-999999999999";
const A = "22222222-2222-4222-8222-222222222222", B = "33333333-3333-4333-8333-333333333333";
const OWNER = "synthetic-owner-credential", READER = "synthetic-reader-credential";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function matches(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual !== null && typeof actual === "object");
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(Object.hasOwn(actual, key), `Missing result field: ${key}`);
    const observed: unknown = (actual as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) matches(observed, value as Record<string, unknown>);
    else assert.deepStrictEqual(observed, value);
  }
}
const rejects = (promise: Promise<unknown>, expected: Record<string, unknown>) => assert.rejects(promise, error => { matches(error, expected); return true; });
function rawRequest(url: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers: { ...headers, ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk.toString(); });
      response.on("error", reject);
      response.on("end", () => { try { resolve({ status: response.statusCode!, data: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.end(body);
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { wrapStore?: (store: RuntimeStore) => RuntimeStore; maxConcurrentRequests?: number; nativeMode?: NativeMode; allowedOrigins?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-server-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const disk = openRuntimeStore(root, {});
  await disk.saveModels(applyUse(parseModelsFile({ version: 3, models: {
    "channel/first": { provider: "openai-responses", model: "first", endpoint: "https://models.invalid/v1", apiKeyRef: "env:PRIVATE_MODEL_KEY" },
    "channel/second": { provider: "openai-chat", model: "second", endpoint: "https://user:private-secret@models.invalid/v1?key=private-secret", apiKeyRef: "file:/private/model-key" },
  }, assignments: { main: null, agents: {} } }), "stub/echo"));
  const upstream = options.nativeMode ? await nativeFixture(root, options.nativeMode, A, B) : undefined;
  if (upstream) {
    cleanup.push(upstream.close);
    const models = await disk.loadModels();
    models.models["channel/first"]!.endpoint = upstream.endpoint;
    models.models["channel/first"]!.capabilities.reasoning = { efforts: ["high", "xhigh"] };
    await disk.saveModels(applyUse(applyUse(models, "stub/echo", A), "stub/echo", B));
  }
  const store = options.wrapStore?.(disk) ?? disk;
  const state = { nativeReads: 0, ownershipReads: 0, policyReads: 0, nativeUnavailable: false, generation: "a".repeat(64),
    bots: [A, B].map(id => ({ id, name: id === A ? "First" : "Second", title: null, description: null, nativeHarness: "box",
      hidden: false, running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [] })) as NativeBotSummary[],
    grants: [{ tokenSha256: digest(OWNER), principalId: "owner", capabilities: [...CAPABILITIES] },
      { tokenSha256: digest(READER), principalId: "reader", capabilities: ["models.read", "bots.read", "operations.read"] }] as AccessGrant[] };
  const ownership = ownedOwnershipReader(process.pid);
  const native: ManagementNative = {
    listBots: async signal => {
      state.nativeReads++;
      if (state.nativeUnavailable) throw new ManagementSourceError("source_unavailable");
      if (upstream) return upstream.native.listBots(signal);
      return { bots: structuredClone(state.bots),
        source: { kind: "native-gateway", generation: state.generation, pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" };
    },
    ownershipRead: async (...args) => { state.ownershipReads++; return upstream ? upstream.native.ownershipRead(...args) : ownership(...args); },
  };
  const serverOptions = { store, installationId: I, native, env: upstream ? { PRIVATE_MODEL_KEY: CATALOG_CREDENTIAL } : {}, maxConcurrentRequests: options.maxConcurrentRequests,
    allowedOrigins: options.allowedOrigins,
    readGrants: async () => { state.policyReads++; return structuredClone(state.grants); } };
  let server = await startManagementServer(serverOptions, { hostHealth: { enabled: false } });
  cleanup.push(() => server.close());
  const client = (token = OWNER, installationId = I, fetch?: typeof globalThis.fetch) => new ManagementClient({ baseUrl: server.url, installationId, credential: async () => token, fetch });
  const request = async (agentId = A): Promise<ModelChangeRequest> => ({ requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await disk.loadModels()),
    change: { kind: "bot-selection", agentId, selection: { kind: "default" } } });
  return { root, disk, store, state, native, upstream, client, request, get server() { return server; },
    headers: () => ({ authorization: `Bearer ${OWNER}`, "x-grokbox-installation-id": I }),
    restart: async () => { await server.close(); server = await startManagementServer(serverOptions, { hostHealth: { enabled: false } }); } };
}

async function installation(root: string, token = OWNER, id = I) {
  await publishConfigFile(join(root, "config.json"), { ...defaultConfig(), ops: { observation: { enabled: false } } });
  await publishConfigFile(join(root, "state", "installation.json"), {
    schemaVersion: 1, installationId: id, role: "box", root, daemon: { tokenSha256: digest(token) },
  });
}

async function cliConfiguration(f: Awaited<ReturnType<typeof fixture>>) {
  await installation(f.root);
  const config = defaultConfig();
  config.ops = { ...config.ops, observation: { enabled: false } };
  config.client.currentProfile = "different";
  config.client.profiles = {
    default: { serverUrl: f.server.url, daemonTokenRef: "env:TEST_MANAGEMENT_TOKEN" },
    different: { serverUrl: f.server.url, daemonTokenRef: "env:TEST_MANAGEMENT_TOKEN", installationId: OTHER_I },
    pinned: { serverUrl: f.server.url, daemonTokenRef: "env:TEST_MANAGEMENT_TOKEN", installationId: I },
  };
  await publishConfigFile(join(f.root, "config.json"), config);
  await publishLayoutAliases(f.root, f.root, I);
  return config;
}
function cli(root: string, args: string[], token = OWNER, stdin?: string | Uint8Array) {
  const entry = process.env.GROKBOX_TEST_CLI_ENTRY; assert.ok(entry);
  const child = spawn("node", [entry, ...args], { cwd: root, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: root, GROKBOX_CONFIG_DIR: root, GROKBOX_BOX_RUNTIME_ROOT: root,
      GROKBOX_PROFILE: "different", TEST_MANAGEMENT_TOKEN: token, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
  if (stdin !== undefined) { child.stdin!.on("error", () => undefined); child.stdin!.end(stdin); }
  const closed = once(child, "close");
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk.toString(); if (Buffer.byteLength(stdout) > 512 * 1024) child.kill("SIGKILL"); });
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  const done = closed.then(([code, signal]) => {
    clearTimeout(timer); assert.strictEqual(signal, null, stderr); assert.strictEqual(stderr, "");
    assert.strictEqual(stdout.trim().split("\n").length, 1);
    for (const secret of [OWNER, READER, "private-secret", "/private/model-key", "PRIVATE_MODEL_KEY"]) assert.ok(!stdout.includes(secret));
    return { code, body: JSON.parse(stdout) };
  });
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; clearTimeout(timer); });
  return { child, done };
}

test("console bootstrap file, cookie authentication and CLI model receipts share one authority", async () => {
  const origin = "https://console.example.test";
  const f = await fixture({ allowedOrigins: [origin] }); await cliConfiguration(f);
  const path = join(f.root, "console-login.json");
  const created = await cli(f.root, ["system", "console", "grant", "create", "--origin", origin, "--credential-file", path]).done;
  assert.strictEqual(created.code, 0); assert.strictEqual(created.body.data.credentialFile, path);
  const credential = JSON.parse(await readFile(path, "utf8"));
  assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
  assert.strictEqual(credential.installationId, I); assert.strictEqual(credential.origin, origin);
  assert.ok(!JSON.stringify(created.body).includes(credential.code));
  assert.strictEqual((await cli(f.root, ["system", "console", "grant", "create", "--origin", origin, "--credential-file", path]).done).code, 2);
  assert.strictEqual(JSON.parse(await readFile(path, "utf8")).code, credential.code);
  await rejects(f.client(READER).createConsoleGrant(origin), { code: "permission_denied" });
  await rejects(f.client().createConsoleGrant("https://not-configured.example"), { code: "permission_denied" });
  let cookie: string | undefined, csrf: string | undefined;
  const transport = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); headers.set("origin", origin);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(input, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.includes("Max-Age=0") ? undefined : setCookie.split(";")[0];
    return response;
  }, { preconnect() {} });
  const make = () => new ManagementClient({ baseUrl: f.server.url, installationId: I, console: { csrfToken: () => csrf }, fetch: transport });
  let client = make();
  const session = await client.redeemConsoleGrant(credential.code); csrf = session.data.csrfToken;
  assert.strictEqual(session.data.principalId, "owner");
  assert.ok(!session.data.capabilities.includes("console.grants.create"));
  assert.ok(cookie?.startsWith("__Host-grokbox-console="));
  assert.deepStrictEqual((await client.models()).data, (await f.client().models()).data);
  await rejects(client.createConsoleGrant(origin), { code: "permission_denied" });
  await rejects(client.redeemConsoleGrant(credential.code), { code: "invalid_input" });
  const request = await f.request();
  const saved = await client.changeModels(request);
  assert.deepStrictEqual((await f.client().modelOperation(request.requestId)).data, saved.data);
  f.state.grants[0] = { ...f.state.grants[0]!, capabilities: ["bots.read", "models.read", "operations.read"] };
  await rejects(client.changeModels(await f.request()), { code: "permission_denied" });
  await client.consoleLogout(); assert.strictEqual(cookie, undefined);
  await rejects(client.consoleSession(), { code: "authentication_required" });
  f.state.grants[0] = { ...f.state.grants[0]!, capabilities: [...CAPABILITIES] };
  const second = await f.client().createConsoleGrant(origin);
  await client.redeemConsoleGrant(second.data.code);
  const oldCookie = cookie;
  await f.restart(); client = make();
  await rejects(client.consoleSession(), { code: "authentication_required" });
  assert.strictEqual(cookie, oldCookie);
  const third = await f.client().createConsoleGrant(origin);
  await client.redeemConsoleGrant(third.data.code);
  assert.notStrictEqual(cookie, oldCookie);
  assert.deepStrictEqual((await f.client().modelOperation(request.requestId)).data, saved.data);
});

test("console HTTP rejects missing CSRF, foreign origins, mixed authentication and unpinned redemption", async () => {
  const origin = "https://console.example.test";
  const f = await fixture({ allowedOrigins: [origin] });
  const grant = await f.client().createConsoleGrant(origin);
  const redeem = await fetch(`${f.server.url}/v1/console/redeem`, { method: "POST", headers: { origin, "content-type": "application/json", "x-grokbox-installation-id": I }, body: JSON.stringify({ code: grant.data.code }) });
  assert.strictEqual(redeem.status, 200);
  const cookie = redeem.headers.get("set-cookie")!.split(";")[0]!;
  const body = JSON.stringify(await f.request());
  const missing = await fetch(`${f.server.url}/v1/model-changes`, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-grokbox-installation-id": I }, body });
  assert.strictEqual(missing.status, 403);
  const foreign = await fetch(`${f.server.url}/v1/models`, { headers: { cookie, origin: "https://foreign.example", "x-grokbox-installation-id": I } });
  assert.strictEqual(foreign.status, 403);
  const mixed = await fetch(`${f.server.url}/v1/models`, { headers: { ...f.headers(), cookie, origin } });
  assert.strictEqual(mixed.status, 400);
  const unpinned = await fetch(`${f.server.url}/v1/console/redeem`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ code: grant.data.code }) });
  assert.strictEqual(unpinned.status, 409);
  f.state.grants = [];
  const revoked = await fetch(`${f.server.url}/v1/models`, { headers: { cookie, origin, "x-grokbox-installation-id": I } });
  assert.strictEqual(revoked.status, 401);
});

test("model apply uses strict structured input, preserves omitted fields on patch, and shares deletion guards", async () => {
  const f = await fixture(); await cliConfiguration(f);
  const path = join(f.root, "model-input.json");
  const request = await f.request();
  const input = { modelId: "channel/first", mode: "patch", model: { alias: "updated", capabilities: { tools: false } },
    requestId: request.requestId, expectedRevision: request.expectedRevision };
  await publishConfigFile(path, input);
  const patched = await cli(f.root, ["model", "apply", "--input", `@${path}`]).done;
  assert.strictEqual(patched.code, 0); assert.strictEqual(patched.body.data.command, "model-patch");
  assert.deepStrictEqual((await cli(f.root, ["model", "apply", "--input", `@${path}`]).done).body.data, patched.body.data);
  const record = (await f.disk.loadModels()).models["channel/first"]!;
  assert.strictEqual(record.apiKeyRef, "env:PRIVATE_MODEL_KEY"); assert.strictEqual(record.endpoint, "https://models.invalid/v1");
  assert.strictEqual(record.alias, "updated"); assert.strictEqual(record.capabilities.tools, false);
  const replacement = { mode: "replace", model: { provider: "openai-responses", model: "new-wire", endpoint: "https://catalog.invalid/v1", apiKeyRef: "env:SYNTHETIC_NEW_KEY" } };
  const fresh = await f.request();
  const created = await cli(f.root, ["model", "apply", "local/new", "--input", "-", "--request-id", fresh.requestId, "--expect-revision", fresh.expectedRevision], OWNER, JSON.stringify(replacement)).done;
  assert.strictEqual(created.code, 0);
  const remove = await f.request();
  assert.strictEqual((await cli(f.root, ["model", "delete", "local/new", "--request-id", remove.requestId, "--expect-revision", remove.expectedRevision]).done).code, 0);
  await rejects(f.client().model("local/new"), { code: "not_found" });
  const referenced = await f.request();
  const refused = await cli(f.root, ["model", "delete", "stub/echo", "--request-id", referenced.requestId, "--expect-revision", referenced.expectedRevision]).done;
  assert.strictEqual(refused.code, 5); matches(refused.body, { error: { code: "model_in_use" } });
  assert.strictEqual(f.state.nativeReads, 0); assert.strictEqual(f.state.ownershipReads, 0);
});

test("model apply rejects duplicate fields, unsafe JSON, unsupported null and oversized input before Server effects", async () => {
  const f = await fixture(); await cliConfiguration(f);
  const request = await f.request(), path = join(f.root, "bad-input.json");
  const input = { modelId: "channel/first", mode: "patch", model: { alias: "new" }, requestId: request.requestId, expectedRevision: request.expectedRevision };
  const before = await readFile(join(f.root, "models.json"), "utf8");
  await publishConfigFile(path, input);
  assert.strictEqual((await cli(f.root, ["model", "apply", "channel/first", "--input", `@${path}`]).done).code, 2);
  for (const text of [JSON.stringify({ ...input, extra: true }), JSON.stringify({ ...input, model: { apiKeyRef: null } }),
    JSON.stringify(input).replace('"mode":', '"mode":"patch","mode":'), " ".repeat(65537)]) {
    await writeFile(path, text, { mode: 0o600 });
    assert.strictEqual((await cli(f.root, ["model", "apply", "--input", `@${path}`]).done).code, 2);
  }
  const invalidUtf8 = await cli(f.root, ["model", "apply", "--input", "-"], OWNER, new Uint8Array([255])).done;
  assert.strictEqual(invalidUtf8.code, 2);
  assert.strictEqual(f.state.policyReads, 0);
  assert.strictEqual(await readFile(join(f.root, "models.json"), "utf8"), before);
});

test("Bot list and exact resolution share scoped refs, preserve ambiguity, and reject ambient self", async () => {
  const f = await fixture(); await cliConfiguration(f);
  const listed = await cli(f.root, ["bot", "list", "--limit", "1"]).done;
  assert.strictEqual(listed.code, 0); assert.strictEqual(listed.body.data.bots.length, 1);
  const resolved = await cli(f.root, ["bot", "resolve", " FIRST "]).done;
  assert.strictEqual(resolved.code, 0); matches(resolved.body.data, { bot: { botRef: botRef(I, A) }, matchedBy: "name" });
  assert.strictEqual((await cli(f.root, ["bot", "get", resolved.body.data.bot.botRef]).done).code, 0);
  f.state.bots[1]!.title = "First";
  const ambiguous = await cli(f.root, ["bot", "resolve", "first"]).done;
  assert.strictEqual(ambiguous.code, 5); matches(ambiguous.body, { error: { code: "ambiguous_target", details: { totalCandidates: 2 } } });
  const calls = f.state.nativeReads;
  await rejects(f.client().resolveBot("self"), { code: "caller_identity_unavailable" });
  await rejects(f.client().resolveBot(botRef(OTHER_I, A)), { code: "wrong_installation" });
  assert.strictEqual(f.state.nativeReads, calls); assert.strictEqual(f.state.ownershipReads, 0);
});

test("Bot cursors bind native membership and generation but allow fresh volatile fields", async () => {
  const f = await fixture(), client = f.client();
  const first = (await client.bots({ limit: 1 })).data;
  f.state.bots[1]!.running = true;
  const second = (await client.bots({ cursor: first.nextCursor!, limit: 1 })).data;
  assert.strictEqual(second.bots[0]!.running, true); assert.strictEqual(second.membershipRevision, first.membershipRevision);
  f.state.bots.pop();
  await rejects(client.bots({ cursor: first.nextCursor! }), { code: "cursor_gap" });
  f.state.bots.push({ ...f.state.bots[0]!, id: B }); f.state.generation = "b".repeat(64);
  await rejects(client.bots({ cursor: first.nextCursor! }), { code: "cursor_gap" });
  f.state.bots = [];
  matches((await client.bots()).data, { bots: [], total: 0, nextCursor: null, pageBound: null });
  f.state.nativeUnavailable = true;
  await rejects(client.bots(), { code: "source_unavailable" });
});

test("UTF-8 byte-limited Bot pages remain resumable without truncating projected objects", async () => {
  const f = await fixture(), client = f.client();
  f.state.bots = Array.from({ length: 40 }, (_, index) => ({ ...f.state.bots[0]!, id: randomUUID(), name: `Bot ${index}`, description: "\u{1f680}".repeat(4096) }));
  const ids = new Set<string>();
  let cursor: string | undefined, pages = 0;
  do {
    const reply = await client.bots({ limit: 100, cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(reply)) <= 256 * 1024);
    if (pages === 0) assert.strictEqual(reply.data.pageBound, "bytes");
    for (const bot of reply.data.bots) { assert.ok(!ids.has(bot.id)); ids.add(bot.id); assert.strictEqual(Array.from(bot.description!).length, 4096); }
    cursor = reply.data.nextCursor ?? undefined;
    assert.ok(++pages <= 40);
  } while (cursor);
  assert.strictEqual(ids.size, 40); assert.ok(pages > 1);
});

test("resolution never treats truncated identity text as an exact unique match", async () => {
  const f = await fixture(), client = f.client();
  const prefix = "a".repeat(256), query = `${prefix}b`;
  Object.assign(f.state.bots[0]!, { name: prefix, textTruncated: true, truncatedFields: ["name"] });
  f.state.bots[1]!.title = query;
  await rejects(client.resolveBot(query), { code: "source_incomplete", details: { totalCandidates: 2 } });
  Object.assign(f.state.bots[0]!, { name: "Unique", description: "x".repeat(4096), truncatedFields: ["description"] });
  assert.strictEqual((await client.resolveBot("Unique")).data.bot.id, A);
});

test("packaged CLI uses a fixed local connection and shares Server model state and receipts", async () => {
  const f = await fixture(); await cliConfiguration(f);
  const identity = await cli(f.root, ["system", "identity", "get"]).done;
  assert.strictEqual(identity.code, 0); matches(identity.body, { schemaVersion: 1, installationId: I, command: "system.identity.get", data: { principalId: "owner" } });
  const bot = await cli(f.root, ["bot", "get", botRef(I, A)]).done;
  assert.strictEqual(bot.code, 0); matches(bot.body.data, { botRef: botRef(I, A), name: "First" });
  const explicit = await cli(f.root, ["model", "list", "--connection", "pinned", "--limit", "1"]).done;
  assert.strictEqual(explicit.code, 0); assert.strictEqual(explicit.body.data.models.length, 1);
  const read = await cli(f.root, ["bot", "model", "get", A]).done;
  const requestId = randomUUID();
  const args = ["bot", "model", "set", A, "--follow-default", "--request-id", requestId, "--expect-revision", read.body.data.revision];
  const changed = await cli(f.root, args).done;
  assert.strictEqual(changed.code, 0); assert.strictEqual(changed.body.data.state, "succeeded");
  assert.deepStrictEqual((await f.client().botModel(A)).data.selection, { kind: "default" });
  assert.deepStrictEqual((await cli(f.root, ["operation", "get", "--request-id", requestId]).done).body.data, changed.body.data);
  assert.deepStrictEqual((await cli(f.root, args).done).body.data, changed.body.data);
  assert.strictEqual(f.state.ownershipReads, 1);
});

test("packaged CLI emits structured failure and refuses wrong scope, undeclared input and unauthorized writes", async () => {
  const f = await fixture(); await cliConfiguration(f);
  const wrong = await cli(f.root, ["bot", "get", A, "--connection", "different"]).done;
  assert.strictEqual(wrong.code, 5); matches(wrong.body, { ok: false, error: { code: "wrong_installation" } });
  const parse = await cli(f.root, ["bot", "get", A, "--unknown-private-value"]).done;
  assert.strictEqual(parse.code, 2); assert.ok(!JSON.stringify(parse.body).includes("unknown-private-value"));
  const input = await f.request(), args = ["bot", "model", "set", A, "--follow-default", "--request-id", input.requestId, "--expect-revision", input.expectedRevision];
  const denied = await cli(f.root, args, READER).done;
  assert.strictEqual(denied.code, 3); matches(denied.body, { ok: false, error: { code: "permission_denied" } });
  const invalid = await cli(f.root, [...args, "--effort", "high"]).done;
  assert.strictEqual(invalid.code, 2);
  assert.strictEqual(f.state.nativeReads, 0); assert.strictEqual(f.state.ownershipReads, 0);
  assert.deepStrictEqual(Object.keys((await f.disk.loadModels()).assignments.agents), []);
  await f.server.close();
  const unavailable = await cli(f.root, ["bot", "get", A]).done;
  assert.strictEqual(unavailable.code, 7); matches(unavailable.body, { error: { code: "unavailable" } });
});

test("a declared uncertain model write exits unknown, and CLI readback does not retry it", async () => {
  let writes = 0;
  const f = await fixture({ wrapStore: store => ({ ...store, saveModels: async (...args) => { writes++; await store.saveModels(...args); throw new Error("synthetic failure after publication"); } }) });
  await cliConfiguration(f);
  const input = await f.request();
  const args = ["bot", "model", "set", A, "--follow-default", "--request-id", input.requestId, "--expect-revision", input.expectedRevision];
  const result = await cli(f.root, args).done;
  assert.strictEqual(result.code, 8); matches(result.body, { ok: false, error: { code: "operation_unknown", details: { operation: { requestId: input.requestId, state: "unknown" } } } });
  const receipt = await cli(f.root, ["operation", "get", "--request-id", input.requestId]).done;
  assert.strictEqual(receipt.code, 0); assert.strictEqual(receipt.body.data.state, "unknown");
  assert.strictEqual((await cli(f.root, args).done).code, 8); assert.strictEqual(writes, 1);
});

for (const mode of ["box", "conflict", "temporal", "old", "failure", "wrong-id"] as const) {
  test(`CLI selection qualifies ${mode} through the native HTTP adapter, while reset only withdraws intent`, async () => {
    const f = await fixture({ nativeMode: mode }); await cliConfiguration(f);
    const before = await readFile(join(f.root, "models.json"), "utf8");
    for (const effort of mode === "box" ? ["high", "xhigh", "default"] : ["high"]) {
      const input = await f.request();
      const selected = await cli(f.root, ["bot", "model", "set", A, "--model", "channel/first", "--effort", effort,
        "--request-id", input.requestId, "--expect-revision", input.expectedRevision]).done;
      if (mode === "box") {
        assert.strictEqual(selected.code, 0);
        const view = (await f.client().botModel(A)).data;
        matches(view, { selection: { kind: "model", modelId: "channel/first" }, effectiveWhen: "next-turn", currentTurn: "not-observed" });
        assert.deepStrictEqual(view.effectiveModel?.reasoning, effort === "default" ? null : { effort });
      } else {
        const unavailable = mode === "old" || mode === "failure";
        assert.strictEqual(selected.code, unavailable ? 7 : 3);
        matches(selected.body, { ok: false, error: { code: unavailable ? "source_unavailable" : "permission_denied",
          details: { admissionCode: mode === "conflict" ? "runtime_ownership_conflict" : mode === "temporal" ? "runtime_ownership_temporal"
            : mode === "wrong-id" ? "runtime_ownership_unconfirmed" : "runtime_ownership_unavailable" } } });
        assert.strictEqual(await readFile(join(f.root, "models.json"), "utf8"), before);
        assert.ok(!f.upstream!.calls.includes("/v1/models"));
      }
    }
    const calls = [...f.upstream!.calls], resetInput = await f.request();
    const reset = await cli(f.root, ["bot", "model", "reset", A, "--request-id", resetInput.requestId, "--expect-revision", resetInput.expectedRevision]).done;
    assert.strictEqual(reset.code, 0); assert.deepStrictEqual(f.upstream!.calls, calls);
    const models = await f.disk.loadModels();
    assert.strictEqual(models.assignments.agents[A], undefined);
    assert.deepStrictEqual(models.assignments.agents[B], { modelId: "stub/echo" });
    assert.ok(!f.upstream!.calls.includes("/api/updateAgent"));
    f.state.nativeUnavailable = true;
    const read = await cli(f.root, ["bot", "model", "get", B]).done;
    assert.strictEqual(read.code, 0); matches(read.body.data, { source: "model-configuration", currentTurn: "not-observed" });
  });
}

test("CLI default changes affect explicit followers only and clearing a referenced default refuses", async () => {
  const f = await fixture({ nativeMode: "box" }); await cliConfiguration(f);
  const invokeNewIntent = async (args: string[]) => {
    const input = await f.request();
    return cli(f.root, [...args, "--request-id", input.requestId, "--expect-revision", input.expectedRevision]).done;
  };
  assert.strictEqual((await invokeNewIntent(["model", "default", "set", "channel/first", "--effort", "high"])).code, 0);
  assert.strictEqual((await invokeNewIntent(["bot", "model", "set", B, "--model", "channel/first", "--effort", "high"])).code, 0);
  assert.strictEqual((await invokeNewIntent(["bot", "model", "set", A, "--follow-default"])).code, 0);
  assert.strictEqual((await invokeNewIntent(["model", "default", "set", "channel/first", "--effort", "xhigh"])).code, 0);
  matches((await f.client().botModel(A)).data, { selection: { kind: "default" }, effectiveModel: { reasoning: { effort: "xhigh" } } });
  matches((await f.client().botModel(B)).data, { selection: { kind: "model", modelId: "channel/first", reasoning: { effort: "high" } } });
  const refused = await invokeNewIntent(["model", "default", "reset"]);
  assert.strictEqual(refused.code, 5); matches(refused.body, { error: { code: "model_default_in_use" } });
  assert.strictEqual((await invokeNewIntent(["bot", "model", "reset", A])).code, 0);
  assert.strictEqual((await invokeNewIntent(["model", "default", "reset"])).code, 0);
  assert.strictEqual((await f.client().defaultModel()).data.selection, null);
  const missing = await invokeNewIntent(["bot", "model", "set", A, "--follow-default"]);
  assert.strictEqual(missing.code, 5); matches(missing.body, { error: { code: "model_default_missing" } });
});

test("CLI interruption detaches an admitted write and the original receipt survives a Server restart", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ wrapStore: store => ({ ...store, saveModels: async (...args) => { enter(); await gate; return store.saveModels(...args); } }) });
  await cliConfiguration(f);
  const input = await f.request();
  const running = cli(f.root, ["bot", "model", "set", A, "--follow-default", "--request-id", input.requestId, "--expect-revision", input.expectedRevision]);
  try {
    await Promise.race([entered, running.done.then(() => { throw new Error("CLI ended before write admission"); })]);
    running.child.kill("SIGINT");
    const result = await running.done;
    assert.strictEqual(result.code, 130);
    matches(result.body, { error: { code: "operation_unknown", details: { requestId: input.requestId } }, meta: { interrupted: true } });
  } finally { release(); }
  await f.restart(); await cliConfiguration(f);
  const receipt = await cli(f.root, ["operation", "get", "--request-id", input.requestId]).done;
  assert.strictEqual(receipt.code, 0); assert.strictEqual(receipt.body.data.state, "succeeded");
  assert.deepStrictEqual((await f.client().botModel(A)).data.selection, { kind: "default" });
});

test("a POSIX FIFO credential refuses before authentication instead of blocking CLI startup", async () => {
  const f = await fixture(), config = await cliConfiguration(f);
  const fifo = join(f.root, "credential.pipe");
  const made = spawnSync("mkfifo", ["-m", "600", fifo], { encoding: "utf8" });
  assert.strictEqual(made.status, 0, made.stderr);
  config.client.profiles.default!.daemonTokenRef = `file:${fifo}`;
  await publishConfigFile(join(f.root, "config.json"), config);
  const result = await cli(f.root, ["model", "list", "--timeout-ms", "1000"]).done;
  assert.strictEqual(result.code, 3); matches(result.body, { error: { code: "authentication_required" } });
  assert.strictEqual(f.state.policyReads, 0);
});

test("installed startup requires existing authority and does not initialize an incomplete root", async () => {
  const f = await fixture();
  const before = await readdir(f.root);
  await rejects(startInstalledManagementServer({ root: f.root, discoveryPath: join(f.root, "missing-native.json"), port: 0 }), { code: "unavailable" });
  assert.deepStrictEqual(await readdir(f.root), before);
});

test("installed startup consumes the live verifier and retains principal identity across credential rotation", async () => {
  const f = await fixture();
  await installation(f.root);
  const server = await startInstalledManagementServer({ root: f.root, discoveryPath: join(f.root, "missing-native.json"), port: 0 });
  cleanup.push(() => server.close());
  const client = (token: string) => new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => token });
  const owner = client(OWNER);
  assert.strictEqual((await owner.identity()).data.principalId, "installation-owner");
  const input: ModelChangeRequest = { requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await f.disk.loadModels()), change: { kind: "default-selection", selection: null } };
  const original = await owner.changeModels(input);
  await installation(f.root, "rotated-synthetic-owner");
  await rejects(owner.modelOperation(input.requestId), { code: "authentication_required" });
  assert.deepStrictEqual((await client("rotated-synthetic-owner").modelOperation(input.requestId)).data, original.data);
  await installation(f.root, "rotated-synthetic-owner", OTHER_I);
  await rejects(client("rotated-synthetic-owner").identity(), { code: "unavailable" });
});

for (const kind of ["component", "cli"] as const) test(`packaged Node ${kind} supervisor entry starts outside the source cwd and closes on its owned signal`, async () => {
  const f = await fixture();
  await installation(f.root);
  const entry = kind === "component" ? process.env.GROKBOX_TEST_SERVER_ENTRY : process.env.GROKBOX_TEST_CLI_ENTRY;
  assert.ok(entry);
  const args = kind === "component" ? [f.root, join(f.root, "missing-native.json"), "0"]
    : ["system", "service", "run", "server", "--root", f.root, "--native-discovery", join(f.root, "missing-native.json"), "--port", "0"];
  const child = spawn("node", [entry, ...args], {
    cwd: f.root, env: { PATH: process.env.PATH ?? "", HOME: f.root }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  try {
    const ready = await new Promise<{ url: string; installationId: string; pid: number }>((resolve, reject) => {
      let text = "";
      child.once("error", reject);
      child.once("exit", () => reject(new Error(`packaged-server-start-failed: ${stderr}`)));
      child.stdout!.on("data", chunk => {
        text += chunk.toString();
        if (text.length > 65536) { reject(new Error("packaged-server-output-exceeded")); return; }
        const newline = text.indexOf("\n");
        if (newline >= 0) {
          try {
            const value = JSON.parse(text.slice(0, newline));
            resolve(kind === "component" ? value : { ...value.data, installationId: value.installationId });
          } catch (error) { reject(error); }
        }
      });
    });
    assert.strictEqual(ready.pid, child.pid); assert.strictEqual(ready.installationId, I);
    const client = new ManagementClient({ baseUrl: ready.url, installationId: I, credential: async () => OWNER });
    assert.strictEqual((await client.identity()).data.principalId, "installation-owner");
    assert.deepStrictEqual((await client.defaultModel()).data.selection, { modelId: "stub/echo" });
    await rejects(client.bot(A), { code: "source_unavailable" });
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.strictEqual(code, 0); assert.strictEqual(signal, null); assert.strictEqual(stderr, "");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("shared client reads identity, native Bot data and redacted model configuration from the Server", async () => {
  const f = await fixture(), client = f.client();
  assert.deepStrictEqual((await client.identity()).data, { installationId: I, principalId: "owner", capabilities: [...CAPABILITIES], apiVersion: 1 });
  const bot = await client.bot(botRef(I, A));
  matches(bot.data, { id: A, botRef: botRef(I, A), name: "First", coverage: "current-snapshot" });
  const models = await client.models();
  assert.strictEqual((models.data.models).length, 2);
  const text = JSON.stringify(models);
  for (const secret of [OWNER, "private-secret", "/private/model-key", "PRIVATE_MODEL_KEY", "apiKeyRef"]) assert.ok(!(text).includes(secret));
  matches(models.data.models[1], { endpoint: "https://models.invalid/v1", credential: { configured: true, source: "file" } });
  matches((await client.botModel(A)).data, { selection: { kind: "native" }, source: "model-configuration", currentTurn: "not-observed" });
  assert.deepStrictEqual((await client.defaultModel()).data.selection, { modelId: "stub/echo" });
});

test("authentication, capabilities and installation scope reject before domain effects", async () => {
  const f = await fixture(), request = await f.request();
  const before = await readFile(join(f.root, "models.json"), "utf8");
  await rejects(f.client("wrong").changeModels(request), { code: "authentication_required" });
  await rejects(f.client(READER).changeModels(request), { code: "permission_denied" });
  await rejects(f.client(OWNER, OTHER_I).changeModels(request), { code: "wrong_installation" });
  await rejects(f.client().bot(botRef(OTHER_I, A)), { code: "wrong_installation" });
  assert.strictEqual(f.state.ownershipReads, 0);
  assert.strictEqual(await readFile(join(f.root, "models.json"), "utf8"), before);
  assert.ok(!(await readdir(join(f.root, "state"))).includes("model-operations"));
});

test("model mutation, readback and replay use one domain operation across restarts", async () => {
  const f = await fixture(), client = f.client(), request = await f.request();
  const result = await client.changeModels(request);
  matches(result.data, { requestId: request.requestId, state: "succeeded", effectiveWhen: "next-turn" });
  assert.deepStrictEqual((await client.botModel(A)).data.selection, { kind: "default" });
  assert.deepStrictEqual((await client.modelOperation(request.requestId)).data, result.data);
  await client.changeModels(await f.request(B));
  assert.deepStrictEqual((await client.changeModels(request)).data, result.data);
  await f.restart();
  assert.deepStrictEqual((await f.client().modelOperation(request.requestId)).data, result.data);
  assert.deepStrictEqual((await f.client().changeModels(request)).data, result.data);
  assert.strictEqual(f.state.ownershipReads, 2);
  await rejects(f.client(READER).modelOperation(request.requestId), { code: "not_found" });
});

test("same-key semantic conflict and stale concurrent revision never lose an intervening edit", async () => {
  const f = await fixture(), client = f.client();
  const requests = [await f.request(A), await f.request(B)];
  const results = await Promise.allSettled(requests.map(request => client.changeModels(request)));
  assert.strictEqual((results.filter(result => result.status === "fulfilled")).length, 1);
  assert.strictEqual((results.filter(result => result.status === "rejected")).length, 1);
  assert.strictEqual((Object.keys((await f.disk.loadModels()).assignments.agents)).length, 1);
  const winner = results[0]?.status === "fulfilled" ? requests[0]! : requests[1]!;
  await rejects(client.changeModels({ ...winner, change: { kind: "bot-selection", agentId: A, selection: { kind: "native" } } }), { code: "idempotency_conflict" });
});

test("revoked authentication does not replay a previously authorized operation", async () => {
  const f = await fixture(), client = f.client(), request = await f.request();
  await client.changeModels(request);
  f.state.grants = [];
  await rejects(client.changeModels(request), { code: "authentication_required" });
  await rejects(client.modelOperation(request.requestId), { code: "authentication_required" });
  assert.strictEqual(f.state.ownershipReads, 1);
});

test("malformed and duplicate JSON, undeclared query flags, and GET bodies perform no mutation", async () => {
  const f = await fixture(), request = await f.request(), headers = { ...f.headers(), "content-type": "application/json" };
  const text = JSON.stringify(request);
  for (const body of ["{", text.replace('"requestId":', `"requestId":"${randomUUID()}","requestId":`), JSON.stringify({ ...request, actor: "owner" })]) {
    const response = await fetch(`${f.server.url}/v1/model-changes`, { method: "POST", headers, body });
    assert.strictEqual(response.status, 400);
    matches(await response.json(), { ok: false, error: { code: "invalid_input" } });
  }
  const withBody = await rawRequest(`${f.server.url}/v1/model-default`, f.headers(), "{}");
  assert.strictEqual(withBody.status, 400);
  matches(withBody.data, { ok: false, error: { code: "invalid_input" } });
  const query = await fetch(`${f.server.url}/v1/models?sql=anything`, { headers: f.headers() });
  assert.strictEqual(query.status, 400);
  assert.strictEqual(f.state.ownershipReads, 0);
});

test("Host and Origin checks reject browser cross-origin and rebinding requests", async () => {
  const f = await fixture();
  const rejected: Record<string, string>[] = [{ origin: "https://untrusted.invalid" }, { host: "untrusted.invalid" }, { origin: "null" }];
  for (const headers of rejected) {
    const response = await rawRequest(`${f.server.url}/v1/model-default`, { ...f.headers(), ...headers });
    assert.strictEqual(response.status, 403);
    matches(response.data, { ok: false, error: { code: "permission_denied" } });
  }
  assert.strictEqual(f.state.policyReads, 0);
});

test("native source failure is not an empty Bot success and does not disable model readback", async () => {
  const f = await fixture(); f.state.nativeUnavailable = true;
  await rejects(f.client().bot(A), { code: "source_unavailable" });
  assert.deepStrictEqual((await f.client().defaultModel()).data.selection, { modelId: "stub/echo" });
});

test("model pagination binds the exact revision and installation", async () => {
  const f = await fixture(), client = f.client();
  const first = (await client.models({ limit: 1 })).data;
  assert.strictEqual((first.models).length, 1); assert.notStrictEqual(first.nextCursor, null);
  const second = (await client.models({ limit: 1, cursor: first.nextCursor! })).data;
  assert.strictEqual((second.models).length, 1); assert.notStrictEqual(second.models[0]?.id, first.models[0]?.id);
  await rejects(client.models({ cursor: first.nextCursor!.replace(I, OTHER_I) }), { code: "cursor_gap" });
  await client.changeModels(await f.request());
  await rejects(client.models({ cursor: first.nextCursor! }), { code: "cursor_gap" });
});

test("lost HTTP response preserves request-id recovery and never automatically retries", async () => {
  const f = await fixture(); let posts = 0;
  const drop = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await fetch(input, init);
    if (init?.method === "POST") { posts++; await response.body?.cancel(); throw new TypeError("synthetic-response-loss"); }
    return response;
  }, { preconnect: () => undefined }) as typeof fetch;
  const request = await f.request(), client = f.client(OWNER, I, drop);
  await rejects(client.changeModels(request), { code: "operation_unknown", details: { requestId: request.requestId, installationId: I } });
  assert.strictEqual((await f.client().modelOperation(request.requestId)).data.state, "succeeded");
  assert.strictEqual(posts, 1); assert.strictEqual(f.state.ownershipReads, 1);
});

test("publication uncertainty stays unknown through the API and subsequent readback", async () => {
  let writes = 0;
  const f = await fixture({ wrapStore: store => ({ ...store, saveModels: async (...args) => { writes++; await store.saveModels(...args); throw Error("synthetic-write-response-loss"); } }) });
  const request = await f.request();
  const error = await f.client().changeModels(request).then(() => null, error => error);
  assert.ok(error instanceof ManagementClientError);
  matches(error, { code: "operation_unknown", details: { operation: { state: "unknown", requestId: request.requestId } } });
  assert.strictEqual((await f.client().modelOperation(request.requestId)).data.state, "unknown");
  await rejects(f.client().changeModels(request), { code: "operation_unknown" });
  assert.strictEqual(writes, 1);
});

test("Server close waits for its accepted commit and a new Server can read the receipt", async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ wrapStore: store => ({ ...store, saveModels: async (...args) => { enter(); await gate; await store.saveModels(...args); } }) });
  const request = await f.request();
  const pending = f.client().changeModels(request).catch(() => undefined);
  await entered;
  let closed = false;
  const closing = f.server.close().then(() => { closed = true; });
  await Promise.resolve(); assert.strictEqual(closed, false);
  release(); await closing; await pending;
  assert.strictEqual(f.server.status().state, "stopped");
  await f.restart();
  assert.strictEqual((await f.client().modelOperation(request.requestId)).data.state, "succeeded");
});
