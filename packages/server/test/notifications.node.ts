import "./notification-receiver.node.ts";
import "./receiver-management.node.ts";
import "./receiver-boundaries.node.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { CAPABILITIES, ManagementClient } from "@grokbox/client";
import { openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type ManagementServer, type ManagementNative, type AccessGrant } from "../src/server.ts";
import { automaticFixture, tick } from "../../box-runtime/test/fixtures/automatic-notice.ts";
import { webFixture } from "../../../apps/web/test/fixture.ts";

const I = "11111111-1111-4111-8111-111111111111", TOKEN = "synthetic-notification-manager", READER = "synthetic-notification-reader";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const rejects = (value: Promise<unknown>, code: string) => assert.rejects(value, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code);
async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  do { const value = await read(); if (ready(value)) return value; await tick(5); } while (Date.now() < deadline);
  throw Error("notification_manager_test_deadline");
}
async function fixture() {
  const f = await automaticFixture(), servers: ManagementServer[] = [];
  const state = { unexpectedReads: 0, grants: [
    { principalId: "owner", tokenSha256: digest(TOKEN), capabilities: [...CAPABILITIES] },
    { principalId: "reader", tokenSha256: digest(READER), capabilities: ["system.read"] },
  ] as AccessGrant[] };
  const native: ManagementNative = {
    listBots: async () => { state.unexpectedReads++; throw Error("no_catalog_needed"); },
    ownershipRead: async () => { state.unexpectedReads++; throw Error("collector_not_configured"); },
    readNotificationReceiver: f.readNative,
  };
  async function start() {
    const server = await startManagementServer({ store: openRuntimeStore(f.root, {}), installationId: I, native, observations: f.store,
      readGrants: async () => structuredClone(state.grants), env: {} }, { hostHealth:{enabled:false}, notification: { request: f.request, idleMs: 5, blockedMs: 5 } });
    servers.push(server);
    return server;
  }
  const client = (server: ManagementServer, token = TOKEN) => new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => token });
  return { ...f, state, native, start, client, close: async () => { for (const server of servers.reverse()) await server.close(); await f.close(); } };
}

test("unconfigured management notification worker reads no native data and creates no state", async () => {
  const f = await webFixture("https://notification-worker.example.test");
  try {
    await until(() => f.server.status().notifications, value => !!value && value.cycles > 0);
    const before = await readdir(f.root);
    const status = (await f.client().notificationWorker()).data;
    assert.equal(status.owner, "management-server"); assert.equal(status.state, "waiting");
    assert.equal(status.lastCycle?.state, "blocked");
    assert.deepEqual(await readdir(f.root), before); assert.equal(f.state.reads, 0); assert.equal(f.state.ownershipReads, 0);
    await rejects(f.client("synthetic-web-reader-credential").notificationWorker(), "permission_denied");
    assert.equal(status.botReport, "not_observed"); assert.equal(status.userRead, "not_observed");
  } finally { await f.close(); }
});

test("a prepared binding is not worker authorization and queries do not enable it", async () => {
  const f = await fixture();
  try {
    await f.emit(); const before = await readFile(f.store.path), server = await f.start();
    await until(() => server.status().notifications, value => !!value && value.cycles >= 2);
    assert.equal((await f.client(server).notificationWorker()).data.lastCycle?.reason, "automatic_not_authorized");
    assert.deepEqual(await readFile(f.store.path), before); assert.equal(f.reads(), 0); assert.equal(f.requests.length, 0);
    assert.equal(f.state.unexpectedReads, 0);
    await rejects(f.client(server, READER).notificationWorker(), "permission_denied");
    f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(cap => cap !== "notifications.read");
    await rejects(f.client(server).notificationWorker(), "permission_denied");
  } finally { await f.close(); }
});

test("management lifetime delivers new authorized work without a caller and owns cancellation", async () => {
  const f = await fixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const server = await f.start(); await until(() => server.status().notifications, value => !!value && value.cycles > 0);
    const work = await f.emit();
    await until(() => f.store.notificationDelivery(work), row => "attempt" in row && row.attempt?.state === "native-accepted");
    assert.equal(f.requests.length, 2); assert.equal(JSON.parse(f.requests[1]!).workId, work);
    const status = (await f.client(server).notificationWorker()).data;
    assert.equal(status.automaticDiagnosis, false); assert.equal(status.serviceInstallation, "not_proven");
    assert.ok(!JSON.stringify(status).includes("authorizationId")); assert.ok(!JSON.stringify(status).includes(work));
    assert.ok(!JSON.stringify(status).includes("PRIVATE"));
    await server.close(); assert.equal(server.status().notifications?.state, "stopped");
    const after = await readFile(f.store.path); await tick(30); assert.deepEqual(await readFile(f.store.path), after);
    await f.emit(); await tick(30); assert.equal(f.requests.length, 2); assert.equal(f.state.unexpectedReads, 0);
  } finally { await f.close(); }
});

test("competing management processes share the existing single-attempt outbox rather than duplicating delivery", async () => {
  const f = await fixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const a = await f.start(), b = await f.start();
    await until(() => [a.status().notifications, b.status().notifications], rows => rows.every(row => !!row && row.cycles > 0));
    const work = await f.emit();
    await until(() => f.store.notificationDelivery(work), row => "attempt" in row && row.attempt?.state === "native-accepted");
    await tick(40); assert.equal(f.requests.filter(body => JSON.parse(body).workId === work).length, 1);
    assert.equal((await f.client(a).identity()).data.installationId, I); assert.equal((await f.client(b).identity()).data.installationId, I);
  } finally { await f.close(); }
});

test("closing management aborts and settles its in-flight HTTP notification; restart never repeats unknown work", async () => {
  const f = await fixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const server = await f.start(); await until(() => server.status().notifications, row => !!row && row.cycles > 0);
    f.reply(() => undefined);
    const work = await f.emit(); await until(() => f.requests.length, count => count === 2);
    await server.close();
    assert.equal(server.status().notifications?.state, "stopped");
    const receipt = await f.store.notificationDelivery(work); assert.ok("attempt" in receipt); assert.equal(receipt.attempt?.state, "unknown");
    const next = await f.start(); await until(() => next.status().notifications, row => !!row && row.cycles >= 3);
    assert.equal(f.requests.length, 2); assert.equal((await f.client(next).identity()).data.installationId, I);
  } finally { await f.close(); }
});

test("receiver failure is isolated from management APIs and shutdown cancels the pending source read", async () => {
  const f = await fixture(); let entered = false, aborted = false;
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    f.native.readNotificationReceiver = async (_agent, _routine, signal) => new Promise((_resolve, reject) => {
      entered = true;
      const stop = () => { aborted = true; reject(Error("synthetic_receiver_cancelled")); };
      if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
    });
    const server = await f.start(); await until(() => server.status().notifications, row => !!row && row.cycles > 0);
    await f.emit(); await until(() => entered, Boolean);
    assert.equal((await f.client(server).identity()).data.installationId, I);
    await server.close(); assert.equal(aborted, true); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("formal packaged CLI reads the management notification worker without native or local fallback", async () => {
  const f = await fixture();
  try {
    const server = await f.start(), document = structuredClone(f.document);
    document.client.profiles = { default: { serverUrl: server.url, daemonTokenRef: "env:TEST_NOTIFICATION_MANAGEMENT_TOKEN", installationId: I } };
    await publishConfigFile(join(f.root, "config.json"), document);
    await publishConfigFile(join(f.root, "state", "installation.json"), { schemaVersion: 1, installationId: I, role: "box", root: f.root, daemon: { tokenSha256: digest(TOKEN) } });
    await publishLayoutAliases(f.root, f.root, I);
    assert.ok(process.env.GROKBOX_TEST_CLI_ENTRY);
    const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, "notification", "status"], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, TEST_NOTIFICATION_MANAGEMENT_TOKEN: TOKEN } });
    let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await once(child, "close"); clearTimeout(deadline);
    assert.equal(signal, null); assert.equal(code, 0, stderr + stdout); assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).data.owner, "management-server"); assert.ok(!stdout.includes(TOKEN)); assert.equal(f.reads(), 0);
  } finally { await f.close(); }
});
