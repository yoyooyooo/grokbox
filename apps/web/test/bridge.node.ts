import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES } from "@grokbox/client";
import { createConsoleBridge } from "../src/server/bridge.ts";
import { webConfiguration } from "../src/server/config.ts";
import { webFixture, INSTALLATION, FIRST, READER, KEY_SENTINEL, OWNER } from "./fixture.ts";

const ORIGIN = "http://127.0.0.1:33001";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(fetchOverride?: typeof fetch, origin = ORIGIN) {
  const fixture = await webFixture(origin); cleanup.push(fixture.close);
  const config = webConfiguration({ GROKBOX_WEB_ORIGIN: origin, GROKBOX_MANAGEMENT_URL: fixture.server.url, GROKBOX_INSTALLATION_ID: INSTALLATION });
  return { ...fixture, config, bridge: createConsoleBridge(config, fetchOverride) };
}
function request(path: string, options: { method?: string; input?: unknown; headers?: Record<string, string>; origin?: string; noOrigin?: boolean } = {}) {
  const origin = options.origin ?? ORIGIN, method = options.method ?? (options.input === undefined ? "GET" : "POST");
  const headers = new Headers({ "x-grokbox-installation-id": INSTALLATION, ...options.headers });
  if (method === "POST") { if (!options.noOrigin) headers.set("origin", origin); if (!headers.has("content-type")) headers.set("content-type", "application/json"); }
  return new Request(`${origin}${path}`, { method, headers, body: options.input === undefined ? undefined : JSON.stringify(options.input) });
}
async function signIn(f: Awaited<ReturnType<typeof setup>>, credential?: string) {
  const grant = (await f.client(credential).createConsoleGrant(f.config.binding.origin)).data;
  const response = await f.bridge.forward(request("/v1/console/redeem", { input: { code: grant.code }, origin: f.config.binding.origin }));
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  const cookie = response.headers.get("set-cookie")!;
  return { cookie: cookie.split(";")[0]!, fullCookie: cookie, csrf: data.csrfToken as string, session: data, code: grant.code };
}

test("deployment binding rejects ambiguous or arbitrary endpoints", () => {
  const valid = { GROKBOX_WEB_ORIGIN: ORIGIN, GROKBOX_MANAGEMENT_URL: "http://127.0.0.1:33002", GROKBOX_INSTALLATION_ID: INSTALLATION };
  assert.equal(webConfiguration(valid).binding.installationId, INSTALLATION);
  for (const patch of [
    { GROKBOX_WEB_ORIGIN: "http://remote.invalid" }, { GROKBOX_WEB_ORIGIN: `${ORIGIN}/` },
    { GROKBOX_MANAGEMENT_URL: "https://remote.invalid" }, { GROKBOX_MANAGEMENT_URL: ORIGIN },
    { GROKBOX_MANAGEMENT_URL: "http://private@127.0.0.1:33002" }, { GROKBOX_INSTALLATION_ID: "not-an-installation" },
  ]) assert.throws(() => webConfiguration({ ...valid, ...patch }));
});

test("Host, Origin, Fetch Metadata, installation and endpoint admission precede forwarding", async () => {
  let calls = 0;
  const transport = Object.assign(async () => { calls++; throw Error("must-not-forward"); }, { preconnect: () => undefined }) as typeof fetch;
  const f = await setup(transport);
  for (const headers of [{ host: "foreign.invalid" }, { origin: "https://foreign.invalid" }, { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" }, { authorization: `Bearer ${OWNER}` }, { "x-grokbox-installation-id": "99999999-9999-4999-8999-999999999999" }] as Array<Record<string, string>>) {
    const response = await f.bridge.forward(request("/v1/identity", { headers }));
    assert.ok([403, 409].includes(response.status));
  }
  assert.equal((await f.bridge.forward(request("/v1/model-changes", { input: {}, noOrigin: true }))).status, 403);
  assert.equal((await f.bridge.forward(request("/v1/console/grants", { input: { origin: ORIGIN } }))).status, 404);
  assert.equal((await f.bridge.forward(request("/v1/arbitrary-exec", { input: {} }))).status, 404);
  assert.equal((await f.bridge.forward(request("/v1/identity", { method: "DELETE" }))).status, 403);
  assert.equal(calls, 0);
});

test("same-origin browser GET without Origin is bridged using only its console session", async () => {
  const f = await setup(), auth = await signIn(f);
  assert.match(auth.fullCookie, /HttpOnly/); assert.match(auth.fullCookie, /SameSite=Strict/);
  const response = await f.bridge.forward(request("/v1/bots", { headers: { cookie: `${auth.cookie}; unrelated=not-forwarded`, "sec-fetch-site": "same-origin" } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.total, 27);
  const publicState = await f.bridge.bootstrap(request("/bots", { headers: { cookie: auth.cookie } }));
  assert.equal(publicState.session?.principalId, "owner");
  const text = JSON.stringify(publicState);
  for (const privateValue of [auth.code, auth.csrf, auth.cookie, OWNER, KEY_SENTINEL]) assert.ok(!text.includes(privateValue));
  assert.ok(!text.includes("csrfToken"));
  assert.equal((await f.bridge.bootstrap(request("/"))).session, null);
});

test("HTTPS console cookie retains its host-only secure attributes without trusting proxy headers", async () => {
  const f = await setup(undefined, "https://console.example.test"), auth = await signIn(f);
  assert.match(auth.fullCookie, /^__Host-grokbox-console=/); assert.match(auth.fullCookie, /; Secure/);
  assert.ok(!/Domain=/i.test(auth.fullCookie));
  const wrong = await f.bridge.forward(request("/v1/identity", { origin: f.config.binding.origin,
    headers: { cookie: auth.cookie, host: "untrusted.invalid", "x-forwarded-host": "console.example.test", "x-forwarded-proto": "https" } }));
  assert.equal(wrong.status, 403);
});

test("SSR services isolate concurrent identities and never return CSRF in hydration data", async () => {
  const f = await setup(), owner = await signIn(f), reader = await signIn(f, READER);
  const [left, right] = await Promise.all([f.bridge.bootstrap(request("/", { headers: { cookie: owner.cookie } })), f.bridge.bootstrap(request("/", { headers: { cookie: reader.cookie } }))]);
  assert.equal(left.session?.principalId, "owner"); assert.equal(right.session?.principalId, "reader");
  assert.ok(left.session!.capabilities.includes("models.write")); assert.ok(!right.session!.capabilities.includes("models.write"));
  const leftClient = f.bridge.readClient(request("/", { headers: { cookie: owner.cookie } }));
  const rightClient = f.bridge.readClient(request("/", { headers: { cookie: reader.cookie } }));
  const identities = await Promise.all([leftClient.identity(), rightClient.identity()]);
  assert.equal(identities[0].data.principalId, "owner"); assert.equal(identities[1].data.principalId, "reader");
  await assert.rejects(leftClient.changeModels({ requestId: randomUUID(), expectedRevision: (await f.client().defaultModel()).data.revision,
    change: { kind: "default-selection", selection: null } }));
});

test("cookie writes enforce CSRF and current permissions in the same model domain", async () => {
  const f = await setup(), auth = await signIn(f), before = (await f.client().defaultModel()).data;
  const input = { requestId: randomUUID(), expectedRevision: before.revision, change: { kind: "bot-selection", agentId: FIRST, selection: { kind: "default" } } };
  const bad = await f.bridge.forward(request("/v1/model-changes", { input, headers: { cookie: auth.cookie } }));
  assert.equal(bad.status, 403);
  assert.equal((await f.client().defaultModel()).data.revision, before.revision);
  const success = await f.bridge.forward(request("/v1/model-changes", { input, headers: { cookie: auth.cookie, "x-grokbox-csrf": auth.csrf } }));
  assert.equal(success.status, 200);
  assert.equal((await f.client().modelOperation(input.requestId)).data.state, "succeeded");
  f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(value => value !== "models.write");
  const refused = await f.bridge.forward(request("/v1/model-changes", { input: { ...input, requestId: randomUUID(), expectedRevision: (await f.client().defaultModel()).data.revision }, headers: { cookie: auth.cookie, "x-grokbox-csrf": auth.csrf } }));
  assert.equal(refused.status, 403);
});

test("lost write response remains unknown while the original domain receipt is recoverable", async () => {
  let writes = 0;
  const transport = Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
    const result = await fetch(url, init);
    if (String(url).endsWith("/v1/model-changes")) { writes++; await result.arrayBuffer(); throw Error("synthetic-lost-response"); }
    return result;
  }, { preconnect: () => undefined }) as typeof fetch;
  const f = await setup(transport), auth = await signIn(f), requestId = randomUUID();
  const response = await f.bridge.forward(request("/v1/model-changes", { input: { requestId, expectedRevision: (await f.client().defaultModel()).data.revision,
    change: { kind: "bot-selection", agentId: FIRST, selection: { kind: "default" } } }, headers: { cookie: auth.cookie, "x-grokbox-csrf": auth.csrf } }));
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "operation_unknown");
  assert.equal(writes, 1); assert.equal((await f.client().modelOperation(requestId)).data.state, "succeeded");
});

test("request/response bounds and redirect rejection do not create fallback or repeat requests", async () => {
  let calls = 0;
  const transport = Object.assign(async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://foreign.invalid" } }); }, { preconnect: () => undefined }) as typeof fetch;
  const f = await setup(transport);
  const oversized = await f.bridge.forward(request("/v1/model-changes", { input: { text: "x".repeat(REQUEST_MAX_BYTES) } }));
  assert.equal(oversized.status, 413); assert.equal(calls, 0);
  const redirect = await f.bridge.forward(request("/v1/identity"));
  assert.equal(redirect.status, 503); assert.equal(calls, 1);
  const large = createConsoleBridge(f.config, Object.assign(async () => new Response("x".repeat(RESPONSE_MAX_BYTES + 1)), { preconnect: () => undefined }) as typeof fetch);
  assert.equal((await large.forward(request("/v1/identity"))).status, 413);
});

test("Server restart invalidates authentication, not model receipts owned by the original principal", async () => {
  const f = await setup(), auth = await signIn(f), requestId = randomUUID();
  await f.client().changeModels({ requestId, expectedRevision: (await f.client().defaultModel()).data.revision,
    change: { kind: "bot-selection", agentId: FIRST, selection: { kind: "native" } } });
  await f.restart();
  assert.equal((await f.bridge.bootstrap(request("/", { headers: { cookie: auth.cookie } }))).session, null);
  const again = await signIn(f);
  const found = await f.bridge.forward(request(`/v1/model-operations/${requestId}`, { headers: { cookie: again.cookie } }));
  assert.equal(found.status, 200); assert.equal((await found.json()).data.requestId, requestId);
});
