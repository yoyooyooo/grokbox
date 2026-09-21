import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sep, resolve } from "node:path";
import { CAPABILITIES, ManagementClient, type NotificationSendRequest } from "@grokbox/client";
import { openRuntimeStore, openMonitorStore } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { receiverFixture, RECEIVER_INSTALLATION as I, RECEIVER_OWNER as TOKEN, RECEIVER_MODEL as MODEL } from "../../../apps/web/test/receiver-fixture.ts";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code);
const origin = "https://send-lifetime.example.test";
const input = async (f: Awaited<ReturnType<typeof receiverFixture>>): Promise<NotificationSendRequest> => ({ notificationRef: `notification:${I}:${f.databaseId}:${await f.emit()}`,
  receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: MODEL, confirmed: true });

test("a grant revoked during the final native qualification is rechecked after outbox start and before HTTPS", async () => {
  const f = await receiverFixture(origin);
  try {
    const request = await input(f); let reads = 0;
    f.native.readNotificationReceiver = async () => {
      const native = await f.readNative();
      if (++reads === 3) f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(c => c !== "notifications.send");
      return native;
    };
    await rejects(f.client().sendNotification(request), "notification_send_refused");
    const receipt = (await f.client().notificationSendOperation(f.databaseId, request.requestId)).data;
    assert.equal(receipt.state, "refused"); assert.equal(receipt.attempt?.state, "definitely-not-accepted");
    assert.equal(receipt.reason, null); assert.equal(reads, 3); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("management shutdown waits for the original native transport and durable unknown settlement", async () => {
  const f = await receiverFixture(origin); let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  try {
    const request = await input(f);
    f.reply(() => { received(); }); // Deliberately withhold the native HTTP response.
    const pending = f.client().sendNotification(request).catch(() => undefined);
    await requestReceived;
    await f.server.close(); await pending;
    const work = await f.store.notificationDelivery(request.notificationRef.split(":")[3]!);
    assert.equal(work.attempt?.state, "unknown"); assert.equal(f.requests.length, 1);
    const bytes = await readFile(f.store.path);
    await new Promise(resolve => setTimeout(resolve, 15)); assert.deepEqual(await readFile(f.store.path), bytes);
    await f.restart();
    assert.equal((await f.client().notificationSendOperation(f.databaseId, request.requestId)).data.state, "unknown");
    await rejects(f.client().sendNotification(request), "operation_unknown"); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("SIGKILL after original request claim survives cold management restart with zero re-dispatch", async () => {
  const entry = process.env.GROKBOX_TEST_SEND_CRASH_ENTRY; assert.ok(entry);
  const child = spawn("node", [entry], { env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(),
    GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", root: string | undefined;
  child.stdout.on("data", data => { stdout += data; if (stdout.length > 16384) child.kill("SIGKILL"); });
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, signal] = await once(child, "close"); assert.equal(code, null); assert.equal(signal, "SIGKILL"); assert.equal(stderr, "");
    const record = JSON.parse(stdout) as { root: string; databaseId: string; input: NotificationSendRequest };
    root = resolve(record.root); assert.ok(root.startsWith(resolve(tmpdir()) + sep + "automatic-notice-"));
    const store = openMonitorStore(root), original = await readFile(store.path); let nativeReads = 0;
    const unavailable = async (): Promise<never> => { nativeReads++; throw Error("native_unavailable_during_cold_readback"); };
    const server = await startManagementServer({ installationId: I, store: openRuntimeStore(root, {}), observations: store,
      readGrants: async () => [{ principalId: "owner", tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), capabilities: [...CAPABILITIES] }],
      native: { listBots: unavailable, ownershipRead: unavailable, readNotificationReceiver: unavailable }, env: {} },
    { hostHealth: { enabled: false } });
    try {
      const client = new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => TOKEN });
      const receipt = (await client.notificationSendOperation(record.databaseId, record.input.requestId)).data;
      assert.equal(receipt.state, "unknown"); assert.equal(receipt.attempt, null); assert.equal(receipt.reason, null);
      await rejects(client.sendNotification(record.input), "operation_unknown");
      assert.equal(nativeReads, 0); assert.deepEqual(await readFile(store.path), original);
    } finally { await server.close(); }
  } finally { clearTimeout(timer); if (root && root.startsWith(resolve(tmpdir()) + sep + "automatic-notice-")) await rm(root, { recursive: true, force: true }); }
});
