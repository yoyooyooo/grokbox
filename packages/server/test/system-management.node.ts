import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { defaultConfig } from "@grokbox/runtime-kernel/config";
import { modelConfigurationRevision } from "@grokbox/runtime-kernel/model-management";
import { openConfigStore, rootConfigLayout, openRuntimeStore, openModelCredentialManagement, publishConfigFile } from "@grokbox/box-runtime/runtime";
import { startInstalledManagementServer } from "../src/installed.ts";
import { startManagementServer, type AccessGrant } from "../src/server.ts";
const exec = promisify(execFile);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const denied = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-system-")), installationId = randomUUID(), token = randomUUID();
  const config = { ...defaultConfig(), ops: { enabled: false }, runtime: { continuity: { enabled: false } } };
  await publishConfigFile(join(root, "config.json"), config);
  await publishConfigFile(join(root, "state/installation.json"), { schemaVersion: 1, role: "box", root, installationId, daemon: { tokenSha256: digest(token) } });
  await publishConfigFile(join(root, "models.json"), { version: 3, models: { "test/model": {
    id: "test/model", provider: "openai", model: "test", endpoint: "https://example.invalid/v1", apiKeyRef: "env:TEST_KEY",
    capabilities: { tools: false, images: false }, dataTypes: ["text"]
  } }, assignments: { main: null, agents: {} } });
  let server = await startInstalledManagementServer({ root, discoveryPath: join(root, "absent-native.json"), port: 0 });
  const client = (bearer = token) => new ManagementClient({ baseUrl: server.url, installationId, credential: async () => bearer });
  return { root, installationId, config, token, client, url: () => server.url,
    restart: async () => { await server.close(); server = await startInstalledManagementServer({ root, discoveryPath: join(root, "absent-native.json"), port: 0 }); },
    close: async () => { await server.close(); await rm(root, { recursive: true, force: true }); } };
}
for (const domain of ["config", "access"] as const) {
  for (const mode of ["unchanged", "revoked", "rebound", "token-removed"] as const) {
    test(`system ${domain} checks current principal and capability at the staged publication: ${mode}`, async () => {
      const f = await fixture();
      let armed = false, reads = 0, staged = false;
      const capability = domain === "config" ? "system.config.write" : "system.access.write";
      const owner: AccessGrant = { tokenSha256: digest(f.token), principalId: "installation-owner", capabilities: [...CAPABILITIES] };
      let grants: AccessGrant[] = [owner];
      const server = await startManagementServer({
        store: openRuntimeStore(f.root, {}), installationId: f.installationId, env: {},
        native: { listBots: async () => { throw Error("unused-native-list"); }, ownershipRead: async () => { throw Error("unused-native-ownership"); } },
        readGrants: async () => {
          const current = structuredClone(grants);
          if (armed && ++reads === 2) {
            if (mode === "revoked") grants = [{ ...owner, capabilities: owner.capabilities.filter(item => item !== capability) }];
            if (mode === "rebound") grants = [{ ...owner, principalId: "different-owner" }];
            if (mode === "token-removed") grants = [];
          }
          if (armed && reads === 3) {
            const parent = domain === "config" ? f.root : join(f.root, "state");
            staged = (await readdir(parent)).some(name => name.endsWith(".tmp"));
          }
          return current;
        },
      }, { hostHealth: { enabled: false } });
      const client = new ManagementClient({ baseUrl: server.url, installationId: f.installationId, credential: async () => f.token });
      try {
        const before = await readFile(join(f.root, "config.json"), "utf8"), requestId = randomUUID();
        const request = domain === "config"
          ? { requestId, expectedRevision: (await client.systemConfig()).data.revision, confirmed: true,
            domain: "runtime", mode: "patch", value: { desiredMode: "observe" } }
          : { requestId, expectedRevision: (await client.access()).data.revision, confirmed: true, action: "grant",
            grant: { grantId: randomUUID(), principalId: "reader", tokenSha256: digest(randomUUID()), capabilities: ["models.read"] } };
        armed = true;
        const response = await fetch(`${server.url}/v1/${domain === "config" ? "system-config" : "access"}-changes`, {
          method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-grokbox-installation-id": f.installationId },
          body: JSON.stringify(request), signal: AbortSignal.timeout(10000),
        });
        await response.arrayBuffer();
        assert.equal(reads, 3);
        assert.equal(staged, true, "the authorization recheck must run after the real file has been staged");
        armed = false; grants = [owner];
        if (mode === "unchanged") {
          assert.equal(response.status, 200);
          if (domain === "config") assert.notEqual(await readFile(join(f.root, "config.json"), "utf8"), before);
          else assert.equal((await client.access()).data.grants.length, 1);
        } else {
          assert.equal(response.status, domain === "config" ? 503 : mode === "token-removed" ? 401 : 403);
          assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
          assert.equal((await client.access()).data.grants.length, 0);
          if (domain === "config") await denied(client.systemConfigOperation(requestId), "operation_unknown");
          else await denied(client.accessOperation(requestId), "not_found");
        }
      } finally { await server.close(); await f.close(); }
    });
  }
}

test("config uses original publisher, preserves domain peers, and returns historical receipts after restart and later changes", async () => {
  const f = await fixture();
  try {
    const before = await f.client().systemConfig();
    assert.equal(before.data.document.client, undefined); assert.equal(before.data.grantsIncluded, false);
    const request = { requestId: randomUUID(), expectedRevision: before.data.revision, confirmed: true as const,
      domain: "runtime" as const, mode: "patch" as const, value: { desiredMode: "observe" } };
    const committed = (await f.client().changeSystemConfig(request)).data;
    assert.equal(committed.commit, "committed"); assert.notEqual(committed.application.state, "applied");
    const stored = (await openConfigStore(rootConfigLayout(f.root)).read()).document;
    assert.equal(stored.runtime?.continuity?.enabled, false); assert.equal(stored.runtime?.desiredMode, "observe");
    await denied(f.client().changeSystemConfig({ ...request, requestId: randomUUID() }), "revision_conflict");
    await denied(f.client().changeSystemConfig({ ...request, requestId: randomUUID(), expectedRevision: committed.revision,
      value: { continuity: { enabled: true } } }), "invalid_input");
    const second = { ...request, requestId: randomUUID(), expectedRevision: committed.revision, value: { desiredMode: "disabled" } };
    await f.client().changeSystemConfig(second);
    assert.deepEqual((await f.client().changeSystemConfig(request)).data, committed);
    await denied(f.client().changeSystemConfig({ ...request, value: { desiredMode: "route" } }), "idempotency_conflict");
    await f.restart();
    assert.deepEqual((await f.client().systemConfigOperation(request.requestId)).data, committed);
    await writeFile(join(f.root, "config.json"), "{corrupt");
    assert.deepEqual((await f.client().changeSystemConfig(request)).data, committed);
    assert.deepEqual((await f.client().systemConfigOperation(request.requestId)).data, committed);
  } finally { await f.close(); }
});
test("installed access grants authenticate immediately, revoke without restart, and cannot resurrect through replay", async () => {
  const f = await fixture();
  try {
    const delegated = randomUUID(), grantId = randomUUID();
    const revision = (await f.client().access()).data.revision;
    const request = { requestId: randomUUID(), expectedRevision: revision, confirmed: true as const, action: "grant" as const,
      grant: { grantId, principalId: "read-only", tokenSha256: digest(delegated), capabilities: ["models.read", "system.config.read", "operations.read"] } };
    const receipt = (await f.client().changeAccess(request)).data;
    await denied(f.client().changeAccess({ ...request, grant: { ...request.grant, principalId: "other" } }), "idempotency_conflict");
    assert.equal((await f.client(delegated).identity()).data.principalId, "read-only");
    await f.client(delegated).systemConfig();
    await denied(f.client(delegated).changeSystemConfig({ requestId: randomUUID(), expectedRevision: (await f.client().systemConfig()).data.revision,
      confirmed: true, domain: "ops", mode: "patch", value: { enabled: true } }), "permission_denied");
    await denied(f.client(delegated).changeAccess(request), "permission_denied");
    assert.ok(!JSON.stringify((await f.client().access()).data).includes(digest(delegated)));
    assert.ok(!JSON.stringify((await f.client().systemConfig()).data).includes(digest(delegated)));
    await f.client().changeAccess({ requestId: randomUUID(), expectedRevision: receipt.revision, confirmed: true, action: "revoke", grantId });
    await denied(f.client(delegated).identity(), "authentication_required");
    assert.deepEqual((await f.client().changeAccess(request)).data, receipt);
    await denied(f.client(delegated).identity(), "authentication_required");
    await f.restart();
    assert.equal((await f.client().access()).data.grants.length, 0);
    assert.deepEqual((await f.client().accessOperation(request.requestId)).data, receipt);
    await assert.rejects(f.client().changeAccess({ ...request, requestId: randomUUID(), grant: { ...request.grant, principalId: "installation-owner" } }));
    await assert.rejects(f.client().changeAccess({ ...request, requestId: randomUUID(), grant: { ...request.grant, capabilities: ["system.config.write"] } }));
    assert.equal((await stat(join(f.root, "state/management-access.json"))).mode & 0o077, 0);
  } finally { await f.close(); }
});
test("model maintenance reads metadata without materializing credentials or sending provider requests", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.client().systemHost()).data.lifecycleOwner, "official-supervisor");
    assert.equal((await f.client().systemIntegration()).data.component, "host-integration");
    const check = (await f.client().modelCheck("test/model")).data;
    assert.equal(check.providerRequestSent, false); assert.equal(check.cost, "none");
    assert.equal((await f.client().modelCredential("test/model")).data.credential.source, "env");
    await denied(f.client().modelCheck("absent"), "not_found");
    await denied(f.client().modelCredentialOperation(randomUUID()), "not_found");
  } finally { await f.close(); }
});
test("credential import keeps original writer, hides key and path, and never repeats an uncertain source call", async () => {
  const f = await fixture();
  try {
    const store = openRuntimeStore(f.root, {}), owner = openModelCredentialManagement(store, f.installationId, "installation-owner");
    let calls = 0;
    const request = { requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await store.loadModels()),
      modelId: "test/model", piProvider: "test", confirmed: true as const };
    const readCredential = async () => { calls++; return "fixture-model-key-private"; };
    const receipt = await Effect.runPromise(owner.change(request, async () => {}, readCredential));
    assert.equal(receipt.state, "succeeded"); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(receipt).includes("fixture-model-key")); assert.ok(!JSON.stringify(receipt).includes(f.root));
    assert.deepEqual(await Effect.runPromise(owner.change(request, async () => {}, readCredential)), receipt); assert.equal(calls, 1);
    assert.equal((await f.client().modelCredential("test/model")).data.credential.source, "file");
    const failed = { ...request, requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await store.loadModels()) };
    const unknown = await Effect.runPromise(owner.change(failed, async () => {}, async () => { calls++; throw new Error("lost source result"); }));
    assert.equal(unknown.state, "failed"); assert.equal(calls, 2);
    assert.deepEqual(await Effect.runPromise(owner.change(failed, async () => {}, readCredential)), unknown); assert.equal(calls, 2);
    const recovered = await Effect.runPromise(owner.change({ ...failed, requestId: randomUUID() }, async () => {}, readCredential));
    assert.equal(recovered.state, "succeeded"); assert.equal(calls, 3);
  } finally { await f.close(); }
});
test("packed CLI connections stay initiating-machine scoped and remote errors never fall back to local config writes", async () => {
  const f = await fixture();
  const clientRoot = await mkdtemp(join(tmpdir(), "grokbox-client-"));
  try {
    const cli = process.env.GROKBOX_TEST_CLI_ENTRY!;
    const run = async (args: string[]) => JSON.parse((await exec(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, HOME: clientRoot,
      GROKBOX_CONFIG_DIR: clientRoot, GROKBOX_BOX_RUNTIME_ROOT: f.root, TEST_OWNER: f.token }, timeout: 15000 })).stdout);
    const before = await run(["connection", "list"]);
    const file = join(clientRoot, "connection-input.json");
    await writeFile(file, JSON.stringify({ endpoint: f.url(), installationId: f.installationId, credentialRef: "env:TEST_OWNER" }));
    const id = randomUUID(), args = ["connection", "set", "target", "--input", "@"+file, "--request-id", id, "--expect-revision", before.data.revision, "--confirm"];
    const done = await run(args); assert.equal(done.data.remoteChanged, false);
    assert.equal((await run(["connection", "check", "target"])).data.installationId, f.installationId);
    assert.equal((await run(["system", "config", "get", "--connection", "target"])).data.grantsIncluded, false);
    const config = JSON.parse(await readFile(join(clientRoot, "config.json"), "utf8"));
    assert.equal(config.client.currentProfile, "default"); assert.equal(config.client.profiles.target.installationId, f.installationId);
    assert.deepEqual((await run(args)).data, done.data);
    const bytes = await readFile(join(clientRoot, "config.json"), "utf8");
    config.client.profiles.target.serverUrl = "http://127.0.0.1:1"; await publishConfigFile(join(clientRoot, "config.json"), config);
    const localBefore = await readFile(join(clientRoot, "config.json"), "utf8");
    const targetBefore = await readFile(join(f.root, "config.json"), "utf8");
    await assert.rejects(run(["system", "config", "reset", "--domain", "ops", "--connection", "target", "--request-id", randomUUID(),
      "--expect-revision", "a".repeat(64), "--confirm", "--timeout-ms", "100"]));
    assert.equal(await readFile(join(clientRoot, "config.json"), "utf8"), localBefore);
    assert.equal(await readFile(join(f.root, "config.json"), "utf8"), targetBefore);
    assert.notEqual(bytes, localBefore);
    await writeFile(join(clientRoot, "config.json"), "{corrupt");
    assert.deepEqual((await run(args)).data, done.data);
    assert.equal((await run(["connection", "operation", "get", id])).data.configRevision, done.data.configRevision);
  } finally { await f.close(); await rm(clientRoot, { recursive: true, force: true }); }
});

test("probe API binds its original receipt and uses bounded echo without provider contact", async () => {
  const f = await fixture();
  try {
    const request = { requestId: randomUUID(), modelId: "stub/echo", expectedRevision: (await f.client().modelCheck("stub/echo")).data.revision, confirmed: true as const, timeoutMs: 1000 };
    const result = (await f.client().probeModel(request)).data;
    assert.equal(result.state, "succeeded"); assert.equal(result.providerRequestSent, false);
    assert.equal(result.cost.amount, "none"); assert.equal(result.responseStored, false);
    assert.deepEqual((await f.client().probeModel(request)).data, result);
    await denied(f.client().probeModel({ ...request, timeoutMs: 2000 }), "idempotency_conflict");
    await f.restart();
    assert.deepEqual((await f.client().modelProbeOperation(request.requestId)).data, result);
  } finally { await f.close(); }
});
test("credential cancellation joins the source and settles a known failure without publishing a late model", async () => {
  const f = await fixture();
  try {
    const store = openRuntimeStore(f.root, {}), owner = openModelCredentialManagement(store, f.installationId, "installation-owner");
    const original = await store.loadModels(), controller = new AbortController();
    const started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
    const request = { requestId: randomUUID(), expectedRevision: modelConfigurationRevision(original), modelId: "test/model", piProvider: "test", confirmed: true as const };
    const result = Effect.runPromise(owner.change(request, async () => {}, async (_provider, _model, signal) => {
      assert.ok(signal);
      started.resolve();
      return new Promise<string>((_resolve, reject) => {
        const cancel = () => { stopped.resolve(); reject(new Error("source cancelled")); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    }), { signal: controller.signal });
    await started.promise;
    controller.abort();
    await assert.rejects(result);
    await stopped.promise;
    assert.deepEqual(await store.loadModels(), original);
    assert.equal((await owner.receipt(request.requestId))?.state, "failed");
  } finally { await f.close(); }
});

test("credential Scope joins a started publication and settles its original success receipt", async () => {
  const f = await fixture();
  const released = Promise.withResolvers<void>();
  try {
    const store = openRuntimeStore(f.root, {}), published = Promise.withResolvers<void>(), controller = new AbortController();
    const controlled = { ...store, saveModels: async (...args: Parameters<typeof store.saveModels>) => {
      await store.saveModels(...args); published.resolve(); await released.promise;
    } };
    const owner = openModelCredentialManagement(controlled, f.installationId, "installation-owner");
    const request = { requestId: randomUUID(), expectedRevision: modelConfigurationRevision(await store.loadModels()), modelId: "test/model", piProvider: "test", confirmed: true as const };
    let settled = false;
    const result = Effect.runPromise(owner.change(request, async () => {}, async () => "fixture-key"), { signal: controller.signal }).finally(() => { settled = true; });
    await published.promise; controller.abort(); await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    released.resolve(); await assert.rejects(result);
    assert.equal((await owner.receipt(request.requestId))?.state, "succeeded");
  } finally { released.resolve(); await f.close(); }
});
test("credential cancellation at final authorization and locked CAS refusal both settle before-publication failure", async () => {
  for (const mode of ["cancel", "cas"] as const) {
    const f = await fixture();
    try {
      const store = openRuntimeStore(f.root, {}), controller = new AbortController(), original = await store.loadModels();
      const controlled = { ...store, saveModels: async (...args: Parameters<typeof store.saveModels>) => {
        if (mode === "cas") await store.saveModels({ ...original, models: { ...original.models, "test/model": { ...original.models["test/model"]!, model: "changed" } } });
        await store.saveModels(...args);
      } };
      const owner = openModelCredentialManagement(controlled, f.installationId, "installation-owner");
      const request = { requestId: randomUUID(), expectedRevision: modelConfigurationRevision(original), modelId: "test/model", piProvider: "test", confirmed: true as const };
      let authorizations = 0;
      const result = Effect.runPromise(owner.change(request, async () => { if (++authorizations === 3 && mode === "cancel") controller.abort(); }, async () => "fixture-key"), { signal: controller.signal });
      if (mode === "cancel") await assert.rejects(result); else assert.equal((await result).state, "failed");
      assert.equal((await owner.receipt(request.requestId))?.state, "failed");
      assert.equal((await store.loadModels()).models["test/model"]!.apiKeyRef, original.models["test/model"]!.apiKeyRef);
    } finally { await f.close(); }
  }
});

for (const value of [{ enabled: true }, { preset: "maintainer" }]) test(`generic ops config cannot change notification eligibility through ${Object.keys(value)[0]}`, async () => {
  const f = await fixture();
  try {
    const before = await readFile(join(f.root, "config.json"), "utf8");
    const request = { requestId: randomUUID(), expectedRevision: (await f.client().systemConfig()).data.revision,
      confirmed: true as const, domain: "ops" as const, mode: "patch" as const, value };
    await denied(f.client().changeSystemConfig(request), "invalid_input");
    const { value: _value, ...reset } = request;
    await denied(f.client().changeSystemConfig({ ...reset, requestId: randomUUID(), mode: "reset" }), "invalid_input");
    assert.equal(await readFile(join(f.root, "config.json"), "utf8"), before);
  } finally { await f.close(); }
});

for (const phase of ["reservation", "post-reservation"] as const) test(`Server.close joins model probe ${phase} and its final receipt`, async () => {
  const f = await fixture(), store = openRuntimeStore(f.root, {}), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let armed = false, blocked = false, closed = false;
  // A file credential avoids any environment or real provider credential. The
  // post-reservation barrier is before fetch, so this endpoint must never run.
  const credential = join(f.root, "probe-test-secret");
  await writeFile(credential, "synthetic-probe-test-secret", { mode: 0o600 });
  const models = JSON.parse(await readFile(join(f.root, "models.json"), "utf8"));
  models.models["test/model"].apiKeyRef = `file:${credential}`;
  models.models["test/model"].endpoint = "http://127.0.0.1:1/v1";
  await publishConfigFile(join(f.root, "models.json"), models);
  const server = await startManagementServer({ store, installationId: f.installationId, env: {},
    native: { listBots: async () => { throw Error("unexpected-native-read"); }, ownershipRead: async () => { throw Error("unexpected-native-read"); } },
    readGrants: async () => {
      const entries = await readdir(join(f.root, "state/model-probe-operations")).catch(() => [] as string[]);
      const atBarrier = phase === "reservation" ? entries.includes("probe.lock") : entries.some(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (armed && !blocked && atBarrier) { blocked = true; entered.resolve(); await released.promise; }
      return [{ principalId: "installation-owner", tokenSha256: digest(f.token), capabilities: ["models.probe", "operations.read"] }];
    },
  }, { hostHealth: { enabled: false } });
  let closing: Promise<void> | undefined;
  try {
    const requestId = randomUUID(); armed = true;
    const response = fetch(`${server.url}/v1/model-probes`, { method: "POST", headers: {
      authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-grokbox-installation-id": f.installationId,
    }, body: JSON.stringify({ requestId, modelId: "test/model", expectedRevision: modelConfigurationRevision(await store.loadModels()), confirmed: true, timeoutMs: 12345 }) })
      .then(response => response.arrayBuffer()).catch(() => undefined);
    const barrierTimeout = setTimeout(() => entered.reject(new Error("probe publication barrier was not reached")), 5000);
    await entered.promise.finally(() => clearTimeout(barrierTimeout));
    closing = server.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false, "the owning Server must join the original probe before returning");
    released.resolve(); await closing; await response;
    const paths = (await readdir(join(f.root, "state/model-probe-operations"))).filter(name => name.endsWith(".json"));
    if (phase === "post-reservation") {
      assert.equal(paths.length, 1);
      const receipt = JSON.parse(await readFile(join(f.root, "state/model-probe-operations", paths[0]!), "utf8")).receipt;
      assert.equal(receipt.state, "failed"); assert.equal(receipt.providerRequestSent, false);
    } else assert.equal(paths.length, 0);
  } finally { released.resolve(); await closing; await server.close(); await f.close(); }
});

for (const mode of ["oversized", "malformed", "cancelled"] as const) test(`Server.close joins the returned ${mode} provider body through actual cancellation`, async () => {
  const f = await fixture(), store = openRuntimeStore(f.root, {});
  const requested = Promise.withResolvers<void>(), cancelling = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  let sourceCalls = 0, cancelDone = false, closed = false;
  const credential = join(f.root, "probe-body-test-secret");
  await writeFile(credential, "synthetic-probe-body-test-secret", { mode: 0o600 });
  const models = JSON.parse(await readFile(join(f.root, "models.json"), "utf8"));
  models.models["test/model"].apiKeyRef = `file:${credential}`;
  models.models["test/model"].endpoint = "https://probe-body.invalid/v1";
  await publishConfigFile(join(f.root, "models.json"), models);
  const realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (!String(url).startsWith("https://probe-body.invalid/")) return realFetch(url, init);
    sourceCalls++; requested.resolve();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        if (mode === "oversized") controller.enqueue(new Uint8Array(70000).fill(65));
        if (mode === "malformed") controller.enqueue(new TextEncoder().encode("data: {invalid-json}\n\n"));
      },
      async cancel() { cancelling.resolve(); await released.promise; cancelDone = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: realFetch.preconnect });
  const server = await startManagementServer({ store, installationId: f.installationId, env: {},
    native: { listBots: async () => { throw Error("unexpected-native-read"); }, ownershipRead: async () => { throw Error("unexpected-native-read"); } },
    readGrants: async () => [{ principalId: "installation-owner", tokenSha256: digest(f.token), capabilities: ["models.probe", "operations.read"] }],
  }, { hostHealth: { enabled: false } });
  let closing: Promise<void> | undefined;
  const barrierTimeout = setTimeout(() => { requested.reject(Error("provider request missing")); cancelling.reject(Error("body cancellation missing")); }, 5000);
  try {
    const requestId = randomUUID();
    const response = realFetch(`${server.url}/v1/model-probes`, { method: "POST", headers: {
      authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-grokbox-installation-id": f.installationId,
    }, body: JSON.stringify({ requestId, modelId: "test/model", expectedRevision: modelConfigurationRevision(await store.loadModels()), confirmed: true, timeoutMs: 12345 }) })
      .then(response => response.arrayBuffer()).catch(() => undefined);
    await requested.promise; await new Promise<void>(resolve => setImmediate(resolve));
    if (mode !== "cancelled") await cancelling.promise;
    closing = server.close().then(() => { closed = true; });
    await cancelling.promise; clearTimeout(barrierTimeout);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false); assert.equal(cancelDone, false);
    released.resolve(); await closing; await response;
    assert.equal(cancelDone, true); assert.equal(sourceCalls, 1);
    const paths = (await readdir(join(f.root, "state/model-probe-operations"))).filter(name => name.endsWith(".json"));
    assert.equal(paths.length, 1);
    const receipt = JSON.parse(await readFile(join(f.root, "state/model-probe-operations", paths[0]!), "utf8")).receipt;
    assert.equal(receipt.state, "unknown"); assert.equal(receipt.retryAllowed, false);
  } finally {
    clearTimeout(barrierTimeout); released.resolve();
    try { await closing; await server.close(); await f.close(); }
    finally { globalThis.fetch = realFetch; }
  }
});
