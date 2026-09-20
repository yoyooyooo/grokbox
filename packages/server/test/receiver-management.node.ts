import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type ReceiverChangeRequest } from "@grokbox/client";
import { validateNotificationBody } from "@grokbox/runtime-kernel/observation";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { receiverFixture, RECEIVER_INSTALLATION as I, RECEIVER_OWNER as OWNER, RECEIVER_READER as READER, RECEIVER_TESTER as TESTER, RECEIVER_MODEL as MODEL } from "../../../apps/web/test/receiver-fixture.ts";

const origin = "https://receivers.example.test";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 5000; while (!await check()) { if (Date.now() > deadline) throw Error("receiver_test_deadline"); await delay(5); } }
function request(ref: string, revision = 1, action: "enable" | "disable" | "unbind" | "test" = "enable"): ReceiverChangeRequest {
  return { receiverRef: ref, expectedRevision: revision, requestId: randomUUID(), confirmed: true,
    ...(action === "enable" || action === "test" ? { action, expectedModelRevision: MODEL } : { action }) };
}
async function cli(f: Awaited<ReturnType<typeof receiverFixture>>, args: string[]) {
  const entry = process.env.GROKBOX_TEST_CLI_ENTRY; assert.ok(entry);
  const child = spawn("node", [entry, ...args], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root,
    SYNTHETIC_RECEIVER_CREDENTIAL: OWNER, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 256 * 1024) child.kill("SIGKILL"); });
  child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4096); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const [code, signal] = await once(child, "close"); clearTimeout(timer);
  assert.equal(signal, null); assert.equal(errors, "");
  assert.ok(!output.includes(OWNER)); assert.ok(!output.includes("PRIVATE_TEST_KEY"));
  return { code, value: output ? JSON.parse(output) : null };
}

test("fresh receiver can enable without any test, incident or HTTP delivery; consent does not fabricate receipt evidence", async () => {
  const f = await receiverFixture(origin);
  try {
    assert.deepEqual(await f.store.incidents(), []); assert.deepEqual(await f.store.notificationWork(), []);
    const before = await readFile(f.store.path), roster = (await f.client().receivers()).data;
    assert.equal(roster.receivers.length, 1); assert.equal(roster.receivers[0]!.receiverRef, f.ref);
    assert.equal(roster.receivers[0]!.automatic, null); assert.equal(roster.receivers[0]!.testRequired, false);
    const verified = (await f.client().verifyReceiver(f.ref)).data;
    assert.equal(verified.state, "ready"); assert.equal(verified.modelRevision, MODEL); assert.equal(verified.grantsPermission, false);
    const result = (await f.client().changeReceiver(request(f.ref))).data;
    assert.equal(result.action, "enable"); assert.equal(result.notificationSent, false); assert.equal(result.testRequired, false);
    assert.equal((await f.owner.record("default"))!.automatic!.version, 2);
    assert.equal((await f.client().receiver(f.ref)).data.automatic!.authorizationId, result.authorizationId);
    assert.equal(f.requests.length, 0); assert.deepEqual(await readFile(f.store.path), before);
    assert.equal(f.state.unexpectedReads, 0);
  } finally { await f.close(); }
});

test("an independent pre-enable test shares the real outbox without creating an incident, granting consent or repeating", async () => {
  const f = await receiverFixture(origin);
  try {
    const before = (await f.store.events()).entries, capsule = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    const input = request(f.ref, 1, "test"), tested = (await f.client().testReceiver(input)).data;
    assert.equal(tested.state, "succeeded"); assert.equal(tested.delivery.purpose, "test"); assert.equal(tested.delivery.incidentRef, null);
    assert.equal(tested.delivery.evidenceRevision, null); assert.equal(tested.delivery.attempt?.state, "native-accepted");
    assert.equal(tested.enablesAutomatic, false); assert.equal(tested.delivery.userRead, "not_observed");
    assert.equal(f.requests.length, 1); const envelope = JSON.parse(f.requests[0]!);
    assert.equal(envelope.notice.kind, "grokbox.ops.notification-test"); assert.equal(envelope.notice.testId, tested.delivery.workId);
    assert.deepEqual(envelope.notice.commands, []); assert.equal(envelope.notice.incidentId, undefined);
    const db = await openMonitorSqlite(f.store.path, "read");
    try {
      const row = await db.first("SELECT receipt_json FROM notification_attempts WHERE work_id=?", [tested.delivery.workId]);
      const frozen = JSON.parse(String(row!.receipt_json)).frozen;
      assert.deepEqual(validateNotificationBody(f.requests[0]!, frozen.envelopeDigest, frozen.binding, frozen.target, Date.now()), envelope);
      for (const patch of [{ summary: "arbitrary tool instructions" }, { commands: [{ argv: ["dangerous"] }] }, { incidentId: randomUUID() }, { behavior: "run-tools" }]) {
        const substituted = canonicalJson({ ...envelope, notice: { ...envelope.notice, ...patch } });
        assert.throws(() => validateNotificationBody(substituted, createHash("sha256").update(substituted).digest("hex"), frozen.binding, frozen.target, Date.now()));
      }
    } finally { await db.close(); }
    assert.deepEqual(await f.store.incidents(), []); assert.deepEqual(await f.store.notificationWork(), []);
    assert.deepEqual((await f.store.events()).entries, before); assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), capsule);
    const bytes = await readFile(f.store.path);
    assert.deepEqual((await f.client().testReceiver(input)).data, tested);
    assert.deepEqual((await f.client().notificationTestOperation(f.databaseId, input.requestId)).data, tested);
    assert.deepEqual((await f.client().notification(tested.delivery.notificationRef)).data, tested.delivery);
    assert.deepEqual(await readFile(f.store.path), bytes); assert.equal(f.requests.length, 1);
    const list = (await f.client().notifications({ limit: 1 })).data;
    assert.equal(list.notifications[0]!.notificationRef, tested.delivery.notificationRef); assert.equal(list.nextCursor, null);
    await rejects(f.client(READER).notificationTestOperation(f.databaseId, input.requestId), "not_found");
    assert.ok(!JSON.stringify(list).includes("PRIVATE")); assert.ok(!JSON.stringify(list).includes(envelope.notice.summary));
  } finally { await f.close(); }
});

test("unknown optional test remains unknown across restart, but never becomes an enable prerequisite", async () => {
  const f = await receiverFixture(origin);
  try {
    f.reply(response => { response.writeHead(500); response.end("PRIVATE_UNVERIFIED_BODY"); });
    const input = request(f.ref, 1, "test"); await rejects(f.client().testReceiver(input), "operation_unknown");
    const tested = (await f.client().notificationTestOperation(f.databaseId, input.requestId)).data;
    assert.equal(tested.state, "unknown"); assert.equal(tested.delivery.attempt?.state, "unknown"); assert.equal(f.requests.length, 1);
    const enabled = (await f.client().changeReceiver(request(f.ref))).data;
    assert.equal(enabled.state, "succeeded"); assert.equal(f.requests.length, 1);
    await f.restart(); await delay(10);
    assert.equal((await f.client().notificationTestOperation(f.databaseId, input.requestId)).data.state, "unknown");
    await rejects(f.client().testReceiver(input), "operation_unknown");
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.store.incidents(), []);
  } finally { await f.close(); }
});

test("historical receiver receipts survive revoke, re-enable and unbind without reviving consent", async () => {
  const f = await receiverFixture(origin);
  try {
    const enable = request(f.ref), enabled = (await f.client().changeReceiver(enable)).data;
    const disable = request(f.ref, enabled.appliedRevision, "disable"), disabled = (await f.client().changeReceiver(disable)).data;
    assert.equal((await f.client().receiver(f.ref)).data.automatic, null);
    const bytes = await readFile(join(f.root, "state/ops-pairing/bindings.json")), reads = f.reads();
    assert.deepEqual((await f.client().changeReceiver(enable)).data, enabled);
    assert.deepEqual((await f.client().receiverOperation(f.databaseId, enable.requestId)).data, enabled);
    assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), bytes); assert.equal(f.reads(), reads);
    const reenabled = (await f.client().changeReceiver(request(f.ref, disabled.appliedRevision))).data;
    assert.notEqual(reenabled.authorizationId, enabled.authorizationId);
    const unbind = request(f.ref, reenabled.appliedRevision, "unbind"), unbound = (await f.client().changeReceiver(unbind)).data;
    const current = (await f.client().receiver(f.ref)).data;
    assert.equal(current.state, "unbound"); assert.equal(current.credentialStored, false); assert.equal(current.automatic, null);
    assert.deepEqual((await f.client().changeReceiver(disable)).data, disabled);
    assert.deepEqual((await f.client().changeReceiver(unbind)).data, unbound);
    assert.equal((await f.client().receiver(f.ref)).data.revision, unbound.appliedRevision);
    await rejects(f.client().changeReceiver({ ...enable, action: "disable" } as ReceiverChangeRequest), "invalid_input");
    await rejects(f.client().changeReceiver({ ...request(f.ref, unbound.appliedRevision), requestId: enable.requestId }), "idempotency_conflict");
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("a definitely rejected test returns a refused receipt and nonzero CLI exit without becoming an enable gate", async () => {
  const f = await receiverFixture(origin);
  try {
    f.reply(response => { response.writeHead(401); response.end("PRIVATE_REJECTION"); });
    const input = request(f.ref, 1, "test");
    const result = await cli(f, ["notification", "receiver", "test", f.ref, "--request-id", input.requestId, "--expect-revision", "1", "--expect-model-revision", MODEL, "--confirm"]);
    assert.equal(result.code, 5); assert.equal(result.value.error.code, "notification_test_refused");
    const receipt = (await f.client().notificationTestOperation(f.databaseId, input.requestId)).data;
    assert.equal(receipt.state, "refused"); assert.equal(receipt.delivery.attempt?.state, "definitely-not-accepted");
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.store.incidents(), []);
    assert.equal((await f.client().changeReceiver(request(f.ref))).data.state, "succeeded");
    await rejects(f.client().testReceiver(input), "notification_test_refused"); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("receiver, test, read and operation permissions remain independent, including same UUID on different principals", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = request(f.ref); const before = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    await rejects(f.client(READER).changeReceiver(input), "permission_denied");
    await rejects(f.client(TESTER).changeReceiver(input), "permission_denied");
    await rejects(f.client(READER).testReceiver({ ...input, action: "test", expectedModelRevision: MODEL }), "permission_denied");
    assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), before);
    const tested = (await f.client(TESTER).testReceiver({ ...input, action: "test", expectedModelRevision: MODEL })).data;
    await rejects(f.client().notificationTestOperation(f.databaseId, input.requestId), "not_found");
    const enabled = (await f.client().changeReceiver(input)).data;
    assert.notEqual(enabled.operationRef, tested.operationRef);
    await rejects(f.client(TESTER).receiverOperation(f.databaseId, input.requestId), "not_found");
    f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(cap => cap !== "notifications.read");
    await rejects(f.client().receivers(), "permission_denied");
    assert.equal((await f.client().receiverOperation(f.databaseId, input.requestId)).data.state, "succeeded");
  } finally { await f.close(); }
});

test("test payload, malformed/foreign input and scope replacement are rejected before effects", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = request(f.ref, 1, "test"), before = await readFile(f.store.path);
    for (const patch of [{ body: "arbitrary" }, { url: "https://other.invalid" }, { fromWorkId: randomUUID() }, { confirmed: false }, { expectedRevision: 1.5 }]) {
      const response = await fetch(`${f.server.url}/v1/notification-tests`, { method: "POST", headers: { "authorization": `Bearer ${OWNER}`, "x-grokbox-installation-id": I, "content-type": "application/json" }, body: JSON.stringify({ ...input, ...patch }) });
      assert.equal(response.status, 400);
    }
    await rejects(f.client().testReceiver({ ...input, receiverRef: f.ref.replace(I, randomUUID()) }), "wrong_installation");
    await rejects(f.client().testReceiver({ ...input, receiverRef: f.ref.replace(f.databaseId, randomUUID()) }), "source_changed");
    assert.equal(f.reads(), 0); assert.equal(f.requests.length, 0); assert.deepEqual(await readFile(f.store.path), before);
    const response = await fetch(`${f.server.url}/v1/notification-receiver-changes`, { method: "POST", headers: { "authorization": `Bearer ${OWNER}`, "x-grokbox-installation-id": I, "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 400); assert.deepEqual(await readFile(f.store.path), before);
  } finally { await f.close(); }
});

test("concurrent test submissions keep one work and one POST, while test attempts share the real wake budget", async () => {
  const f = await receiverFixture(origin, 1);
  try {
    const input = request(f.ref, 1, "test");
    const results = await Promise.allSettled([f.client().testReceiver(input), f.client().testReceiver(input)]);
    assert.ok(results.some(result => result.status === "fulfilled"));
    assert.equal(f.requests.length, 1);
    const tested = (await f.client().notificationTestOperation(f.databaseId, input.requestId)).data;
    assert.equal(tested.delivery.attempt?.state, "native-accepted");
    const nextRequest = request(f.ref, 1, "test");
    await rejects(f.client().testReceiver(nextRequest), "notification_test_refused");
    const blocked = (await f.client().notificationTestOperation(f.databaseId, nextRequest.requestId)).data;
    assert.equal(blocked.state, "refused"); assert.equal(blocked.delivery.state, "blocked"); assert.equal(blocked.delivery.attempt, null);
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.store.incidents(), []);
    const listing = (await f.client().notifications({ limit: 1 })).data;
    assert.ok(listing.nextCursor); const next = (await f.client().notifications({ limit: 1, cursor: listing.nextCursor! })).data;
    assert.equal(next.notifications.length, 1); assert.notEqual(next.notifications[0]!.workId, listing.notifications[0]!.workId); assert.equal(next.nextCursor, null);
  } finally { await f.close(); }
});

test("unknown receiver commit is recoverable without current configuration or receiver source", async () => {
  const f = await receiverFixture(origin);
  try {
    const input = request(f.ref), api = f.client(); let submissions = 0;
    const lost = new ManagementClient({ baseUrl: f.server.url, installationId: I, credential: async () => OWNER,
      fetch: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
        submissions++; const response = await fetch(url, init); assert.equal(response.status, 200); await response.text(); throw Error("synthetic_lost_response");
      }, { preconnect: () => undefined }) as typeof fetch });
    await rejects(lost.changeReceiver(input), "operation_unknown");
    const result = (await api.receiverOperation(f.databaseId, input.requestId)).data; assert.equal(submissions, 1);
    // Losing a client response does not erase the atomically published capsule.
    await writeFile(f.configPath, "{invalid-private-configuration", { mode: 0o600 });
    f.native.readNotificationReceiver = async () => { throw Error("private-source-error"); };
    const bytes = await readFile(join(f.root, "state/ops-pairing/bindings.json"));
    assert.deepEqual((await api.changeReceiver(input)).data, result);
    assert.deepEqual((await api.receiverOperation(f.databaseId, input.requestId)).data, result);
    assert.deepEqual(await readFile(join(f.root, "state/ops-pairing/bindings.json")), bytes);
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

test("management shutdown settles a hanging independent test and never repeats its unknown attempt", async () => {
  const f = await receiverFixture(origin);
  try {
    f.reply(() => undefined);
    const input = request(f.ref, 1, "test");
    const pending = f.client().testReceiver(input).then(result => result, error => error);
    await until(async () => f.requests.length === 1);
    await f.server.close(); await pending;
    await f.restart(); await delay(10);
    const receipt = (await f.client().notificationTestOperation(f.databaseId, input.requestId)).data;
    assert.equal(receipt.state, "unknown"); assert.equal(receipt.delivery.attempt?.state, "unknown");
    const bytes = await readFile(f.store.path); await delay(30); assert.deepEqual(await readFile(f.store.path), bytes);
    await rejects(f.client().testReceiver(input), "operation_unknown"); assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("formal CLI enables without old seed flags and shares receiver, test and delivery receipts", async () => {
  const f = await receiverFixture(origin);
  try {
    const list = await cli(f, ["notification", "receiver", "list"]); assert.equal(list.code, 0); assert.equal(list.value.data.receivers[0].receiverRef, f.ref);
    const verify = await cli(f, ["notification", "receiver", "verify", f.ref]); assert.equal(verify.code, 0); assert.equal(verify.value.data.modelRevision, MODEL);
    const input = request(f.ref);
    const enabled = await cli(f, ["notification", "receiver", "enable", f.ref, "--request-id", input.requestId, "--expect-revision", "1", "--expect-model-revision", MODEL, "--confirm"]);
    assert.equal(enabled.code, 0); assert.equal(f.requests.length, 0);
    const read = await cli(f, ["operation", "get", "--domain", "receiver", "--database-id", f.databaseId, "--request-id", input.requestId]);
    assert.equal(read.code, 0); assert.deepEqual(read.value.data, enabled.value.data);
    const requestId = randomUUID();
    const tested = await cli(f, ["notification", "receiver", "test", f.ref, "--request-id", requestId, "--expect-revision", "2", "--expect-model-revision", MODEL, "--confirm"]);
    assert.equal(tested.code, 0); assert.equal(tested.value.data.delivery.purpose, "test"); assert.equal(f.requests.length, 1);
    const lookup = await cli(f, ["operation", "get", "--domain", "notification-test", "--database-id", f.databaseId, "--request-id", requestId]);
    assert.equal(lookup.code, 0); assert.deepEqual(lookup.value.data, tested.value.data);
    const delivery = await cli(f, ["notification", "get", tested.value.data.delivery.notificationRef]);
    assert.equal(delivery.code, 0); assert.deepEqual(delivery.value.data, tested.value.data.delivery);
  } finally { await f.close(); }
});

test("schema-three upgrade is explicit and preserves database, incident, acknowledgement and attempt identity", async () => {
  const f = await receiverFixture(origin);
  try {
    const seed = await f.seed(), incident = (await f.store.incidents())[0]!;
    const ack = { requestId: randomUUID(), incidentId: incident.id, expectedRevision: incident.revision, action: "ack" as const, nowMs: Date.now() };
    await f.store.manage(ack); const attempt = await f.store.notificationDelivery(seed.workId);
    await f.server.close(); await f.store.finish((await f.store.snapshot()).collectorEpoch!, Date.now());
    const db = await openMonitorSqlite(f.store.path, "write");
    try { await db.run("DROP TABLE notification_tests; UPDATE meta SET version=3; PRAGMA user_version=3;"); } finally { await db.close(); }
    const before = await readFile(f.store.path), old = await f.store.snapshot(); assert.equal(old.schemaVersion, 3);
    assert.deepEqual(await readFile(f.store.path), before);
    await assert.rejects(f.store.createNotificationTest({ databaseId: f.databaseId, workId: randomUUID(), operationId: "a".repeat(64), requestDigest: "b".repeat(64), alias: "default", bindingId: f.pairing.bindingId, bindingRevision: 1, modelRevision: MODEL, nowMs: Date.now() }));
    assert.deepEqual(await readFile(f.store.path), before);
    const migrated = await f.store.initialize(); assert.equal(migrated.migrated, true); assert.equal(migrated.databaseId, old.databaseId);
    assert.equal((await f.store.snapshot()).schemaVersion, 4); assert.equal((await f.store.snapshot()).collectorEpoch, null);
    assert.equal((await f.store.incidents())[0]!.id, incident.id); assert.equal((await f.store.incidents())[0]!.acknowledged, true);
    assert.equal((await f.store.manage(ack)).duplicate, true); assert.deepEqual(await f.store.notificationDelivery(seed.workId), attempt);
    const after = await readFile(f.store.path); assert.equal((await f.store.initialize()).migrated, false); assert.deepEqual(await readFile(f.store.path), after);
  } finally { await f.close(); }
});
