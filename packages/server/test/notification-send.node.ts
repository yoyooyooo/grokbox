import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type NotificationSendRequest } from "@grokbox/client";
import { receiverFixture, RECEIVER_INSTALLATION as I, RECEIVER_OWNER as OWNER, RECEIVER_READER as READER, RECEIVER_TESTER as TESTER, RECEIVER_MODEL as MODEL } from "../../../apps/web/test/receiver-fixture.ts";
import { openMonitorStore } from "../../box-runtime/src/internal/io/monitor-store.node.ts";
import { notificationOperationKey } from "../src/notification-management.ts";

const origin = "https://notification-send.example.test";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code);
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function request(f: Awaited<ReturnType<typeof receiverFixture>>): Promise<NotificationSendRequest> {
  return { notificationRef: `notification:${I}:${f.databaseId}:${await f.emit()}`, receiverRef: f.ref,
    requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: MODEL, confirmed: true };
}
async function cli(f: Awaited<ReturnType<typeof receiverFixture>>, args: string[]) {
  assert.ok(process.env.GROKBOX_TEST_CLI_ENTRY);
  const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY, ...args], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root,
    SYNTHETIC_RECEIVER_CREDENTIAL: OWNER, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; if (out.length > 256 * 1024) child.kill("SIGKILL"); });
  child.stderr.on("data", chunk => { err = (err + chunk).slice(-4096); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const [code, signal] = await once(child, "close"); assert.equal(signal, null); assert.equal(err, "");
    assert.ok(!out.includes("PRIVATE_TEST_KEY")); assert.ok(!out.includes(OWNER));
    return { code, value: JSON.parse(out) };
  } finally { clearTimeout(timer); }
}

test("explicit incident delivery uses the original outbox and principal request, without granting future consent", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f), incidentCount = (await f.store.incidents()).length;
    const capsule = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    const result = (await f.client().sendNotification(input)).data;
    assert.equal(result.state, "succeeded"); assert.equal(result.attempt?.state, "native-accepted");
    assert.equal(result.notificationRef, input.notificationRef); assert.equal(result.receiverRef, f.ref);
    assert.equal(result.enablesAutomatic, false); assert.equal(result.botReport, "not_observed"); assert.equal(result.userRead, "not_observed");
    assert.equal(f.requests.length, 1); assert.equal(JSON.parse(f.requests[0]!).workId, input.notificationRef.split(":")[3]);
    assert.equal((await f.store.incidents()).length, incidentCount); assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), capsule);
    assert.equal((await f.client().receiver(f.ref)).data.automatic, null);
    const bytes = await readFile(f.store.path), reads = f.reads();
    assert.deepEqual((await f.client().sendNotification(input)).data, result);
    assert.deepEqual((await f.client().notificationSendOperation(f.databaseId, input.requestId)).data, result);
    assert.equal(f.reads(), reads); assert.deepEqual(await readFile(f.store.path), bytes);
    await rejects(f.client(READER).notificationSendOperation(f.databaseId, input.requestId), "not_found");
    await rejects(f.client().sendNotification({ ...input, expectedModelRevision: "a".repeat(64) }), "idempotency_conflict");
    await rejects(f.client().sendNotification({ ...input, requestId: randomUUID() }), "idempotency_conflict");
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("completed explicit receipt remains historical when config and native sources later disappear", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f), result = (await f.client().sendNotification(input)).data;
    await writeFile(join(f.root, "config.json"), "{");
    f.native.readNotificationReceiver = async () => { throw Error("source-offline"); };
    const reads = f.reads();
    assert.deepEqual((await f.client().notificationSendOperation(f.databaseId, input.requestId)).data, result);
    assert.deepEqual((await f.client().sendNotification(input)).data, result);
    assert.equal(f.reads(), reads); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

for (const status of [401, 500]) test(`native HTTP ${status} retains exact refused/unknown history across service restart without repeating`, async () => {
  const f = await receiverFixture(origin);
  try {
    f.reply(response => { response.writeHead(status); response.end("PRIVATE_UPSTREAM_BODY"); });
    const input = await request(f), code = status === 401 ? "notification_send_refused" : "operation_unknown";
    await rejects(f.client().sendNotification(input), code);
    const original = (await f.client().notificationSendOperation(f.databaseId, input.requestId)).data;
    assert.equal(original.state, status === 401 ? "refused" : "unknown"); assert.equal(f.requests.length, 1);
    await f.restart();
    assert.deepEqual((await f.client().notificationSendOperation(f.databaseId, input.requestId)).data, original);
    await rejects(f.client().sendNotification(input), code);
    assert.equal(f.requests.length, 1); assert.ok(!JSON.stringify(original).includes("PRIVATE"));
  } finally { await f.close(); }
});

test("explicit send is independent from testing/enable and rejects test work, wrong scope and stale approval without a POST", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f), before = await readFile(f.store.path);
    for (const token of [READER, TESTER]) await rejects(f.client(token).sendNotification(input), "permission_denied");
    await rejects(f.client().sendNotification({ ...input, expectedRevision: 2 }), "revision_conflict");
    await rejects(f.client().sendNotification({ ...input, expectedModelRevision: "a".repeat(64) }), "source_unavailable");
    await rejects(f.client().sendNotification({ ...input, receiverRef: f.ref.replace(f.databaseId, randomUUID()) }), "invalid_input");
    assert.deepEqual(await readFile(f.store.path), before); assert.equal(f.requests.length, 0);
    const testRequest = { receiverRef: f.ref, requestId: randomUUID(), expectedRevision: 1, expectedModelRevision: MODEL, confirmed: true as const, action: "test" as const };
    const tested = (await f.client().testReceiver(testRequest)).data;
    await rejects(f.client().sendNotification({ ...input, notificationRef: tested.delivery.notificationRef }), "invalid_input");
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("revocation after durable request claim stops before native reads/reservation and remains a finite refusal", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f);
    f.ports.notification!.sendClaimed = async () => {
      f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(c => c !== "notifications.send");
    };
    await rejects(f.client().sendNotification(input), "notification_send_refused");
    const result = (await f.client().notificationSendOperation(f.databaseId, input.requestId)).data;
    assert.equal(result.reason, "permission-revoked"); assert.equal(result.attempt, null); assert.equal(f.requests.length, 0);
    assert.equal(f.reads(), 1); // Original preflight only; no second native inspect.
    f.state.grants[0]!.capabilities = [...f.state.grants[0]!.capabilities, "notifications.send"];
    await rejects(f.client().sendNotification(input), "notification_send_refused"); assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("an original claim excludes automatic contenders even when its acknowledgement or invocation is lost", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f), workId = input.notificationRef.split(":")[3]!, key = notificationOperationKey(I, "owner", f.databaseId, input.requestId, "send");
    const { canonicalJson, sha256Text } = await import("@grokbox/runtime-kernel/hash");
    const writes = openMonitorStore(f.root, { afterRename: () => { throw Error("lost-claim-ack"); } });
    await assert.rejects(writes.createNotificationSend({ databaseId: f.databaseId, workId, operationId: key,
      requestDigest: sha256Text(canonicalJson(input)), bindingId: f.pairing.bindingId, bindingRevision: 1, modelRevision: MODEL, nowMs: Date.now() }));
    const result = (await f.client().notificationSendOperation(f.databaseId, input.requestId)).data;
    assert.equal(result.state, "unknown"); assert.equal(result.attempt, null);
    assert.equal(await f.store.nextAutomaticNotification(1, Date.now()), null);
    await rejects(f.client().sendNotification(input), "operation_unknown"); assert.equal(f.reads(), 0); assert.equal(f.requests.length, 0);
    await rejects(f.client().sendNotification({ ...input, requestId: randomUUID() }), "idempotency_conflict");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("concurrent identical submissions cannot attribute somebody else's attempt or send more than once", async () => {
  const f = await receiverFixture(origin), claimed = barrier(), release = barrier();
  try {
    const input = await request(f);
    f.ports.notification!.sendClaimed = async () => { claimed.resolve(); await release.promise; };
    const first = f.client().sendNotification(input);
    // Cleanup may close the client while another assertion fails; preserve that
    // assertion instead of replacing it with an unhandled request rejection.
    void first.catch(() => undefined);
    await claimed.promise;
    await rejects(f.client().sendNotification(input), "operation_unknown");
    const current = (await f.client().notificationSendOperation(f.databaseId, input.requestId)).data;
    assert.equal(current.attempt, null); assert.equal(f.requests.length, 0);
    assert.equal((await f.client().notification(input.notificationRef)).data.state, "unknown");
    release.resolve(); const result = (await first).data;
    assert.equal(result.state, "succeeded"); assert.equal(f.requests.length, 1);
  } finally { release.resolve(); await f.close(); }
});

test("disconnecting the requesting client does not cancel the submitted delivery or permit a repeat", async () => {
  const f = await receiverFixture(origin), claimed = barrier(), release = barrier();
  try {
    const input = await request(f), abort = new AbortController();
    f.ports.notification!.sendClaimed = async () => { claimed.resolve(); await release.promise; };
    const pending = f.client().sendNotification(input, abort.signal); const outcome = rejects(pending, "operation_unknown");
    await claimed.promise; abort.abort(); await outcome; release.resolve();
    const deadline = Date.now() + 5000;
    while ((await f.client().notificationSendOperation(f.databaseId, input.requestId)).data.state !== "succeeded") {
      if (Date.now() > deadline) throw Error("original-delivery-did-not-settle"); await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(f.requests.length, 1); assert.equal((await f.client().sendNotification(input)).data.state, "succeeded");
  } finally { release.resolve(); await f.close(); }
});

test("packed CLI sends and queries original receipts while removed ops paths cannot reach a native writer", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = await request(f);
    const sent = await cli(f, ["notification", "send", input.notificationRef, "--receiver", f.ref, "--request-id", input.requestId,
      "--expect-revision", "1", "--expect-model-revision", MODEL, "--confirm"]);
    assert.equal(sent.code, 0); assert.equal(sent.value.data.state, "succeeded");
    const history = await cli(f, ["operation", "get", "--domain", "notification", "--database-id", f.databaseId, "--request-id", input.requestId]);
    assert.equal(history.code, 0); assert.deepEqual(history.value.data, sent.value.data); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});
