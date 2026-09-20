import "./event-boundaries.node.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ManagementClient, type IncidentChangeRequest } from "@grokbox/client";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { webFixture, INSTALLATION, OWNER, READER } from "../../../apps/web/test/fixture.ts";
import { seedObservations } from "../../../apps/web/test/observation-fixture.ts";

const origin = "https://incident.example.test";
const rejects = (value: Promise<unknown>, code: string) => assert.rejects(value, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code);
async function fixture() {
  const f = await webFixture(origin), seeded = await seedObservations(f);
  await seeded.sample(Date.now(), "temporal");
  const incident = (await f.client().incidents()).data.incidents[0]!;
  const request = (action: "ack" | "snooze" = "ack"): IncidentChangeRequest => ({ incidentRef: incident.incidentRef, requestId: randomUUID(), expectedRevision: incident.revision,
    ...(action === "ack" ? { action } : { action, untilMs: Date.now() + 1000 }) });
  return { ...f, seeded, incident, request, get server() { return f.server; } };
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  assert.ok(process.env.GROKBOX_TEST_CLI_ENTRY);
  const child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, ...args], { cwd: f.root, stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_MANAGEMENT_CREDENTIAL: OWNER,
    GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
  let out = "", err = ""; child.stdout.on("data", bytes => { out += bytes.toString(); }); child.stderr.on("data", bytes => { err += bytes.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const [code, signal] = await once(child, "close"); clearTimeout(timer);
  assert.equal(signal, null); assert.equal(code, 0, err + out); assert.equal(err, "");
  return out.trim().split("\n").map(line => JSON.parse(line));
}

test("incident actions atomically record their historical receipt and do not repair or notify", async () => {
  const f = await fixture();
  try {
    const request = f.request(), before = (await f.client().observation()).data.cursor;
    const result = (await f.client().changeIncident(request)).data;
    assert.equal(result.repaired, false); assert.equal(result.appliedRevision, request.expectedRevision + 1);
    const current = (await f.client().incident(request.incidentRef)).data.incident;
    assert.equal(current.acknowledged, true); assert.equal(current.status, f.incident.status);
    const events = (await f.client().observationEvents({ cursor: before })).data.entries;
    assert.equal(events.filter(e => e.kind === "incident_ack").length, 1);
    assert.equal(events.some(e => e.kind.startsWith("notification")), false);
    const bytes = await readFile(f.observations.path), info = await stat(f.observations.path);
    assert.deepEqual((await f.client().changeIncident(request)).data, result);
    assert.deepEqual((await f.client().incidentOperation(result.databaseId, request.requestId)).data, result);
    assert.deepEqual(await readFile(f.observations.path), bytes); assert.equal((await stat(f.observations.path)).mtimeMs, info.mtimeMs);
    await rejects(f.client().changeIncident({ ...request, requestId: randomUUID() }), "revision_conflict");
    await rejects(f.client().changeIncident({ ...request, action: "snooze", untilMs: Date.now() + 1000 }), "idempotency_conflict");
    assert.equal(f.state.ownershipReads, 0); assert.equal(f.state.reads, 0);
  } finally { await f.close(); }
});

test("expired snooze replays return the original receipt before new-action admission", async () => {
  const f = await fixture();
  try {
    const request = { ...f.request("snooze"), untilMs: Date.now() + 150 } as IncidentChangeRequest;
    const original = (await f.client().changeIncident(request)).data;
    await new Promise(resolve => setTimeout(resolve, 200));
    const bytes = await readFile(f.observations.path);
    assert.deepEqual((await f.client().changeIncident(request)).data, original);
    assert.deepEqual(await readFile(f.observations.path), bytes);
    await rejects(f.client().changeIncident({ ...request, requestId: randomUUID(), expectedRevision: original.appliedRevision }), "invalid_input");
  } finally { await f.close(); }
});

test("receipt keys bind principal, installation, database and original request without a second ledger", async () => {
  const f = await fixture();
  try {
    const input = f.request(), first = (await f.client().changeIncident(input)).data;
    await rejects(f.client(READER).incidentOperation(first.databaseId, input.requestId), "not_found");
    await rejects(f.client(READER).changeIncident(input), "permission_denied");
    const secondToken = "synthetic-other-owner";
    f.state.grants.push({ tokenSha256: createHash("sha256").update(secondToken).digest("hex"), principalId: "other", capabilities: ["incidents.write", "operations.read"] });
    const second = (await f.client(secondToken).changeIncident({ ...input, expectedRevision: first.appliedRevision })).data;
    assert.equal(second.appliedRevision, first.appliedRevision + 1);
    assert.notEqual(second.operationRef, first.operationRef);
    assert.equal((await f.client().incidentOperation(first.databaseId, input.requestId)).data.appliedRevision, first.appliedRevision);
    const foreign = input.incidentRef.replace(INSTALLATION, randomUUID());
    await rejects(f.client().changeIncident({ ...input, incidentRef: foreign }), "wrong_installation");
    const changedDatabase = input.incidentRef.replace(first.databaseId, randomUUID());
    await rejects(f.client().changeIncident({ ...input, incidentRef: changedDatabase }), "source_changed");
    assert.ok(!(await readdir(f.root)).some(name => /operations|ledger/.test(name)));
  } finally { await f.close(); }
});

test("lost commit acknowledgement is recovered after management restart without a second effect", async () => {
  const f = await fixture();
  try {
    const original = f.observations.manage;
    f.observations.manage = async input => { await original(input); throw new BoxRuntimeError("invalid_usage", "monitor_commit_unknown"); };
    const input = f.request();
    const error = await f.client().changeIncident(input).catch(error => error);
    assert.equal(error.code, "operation_unknown"); assert.ok(error.details.lookupPath.includes(input.requestId));
    f.observations.manage = original;
    await f.restart();
    // Cold CLI owns a new HTTP connection after restart, not an undici socket
    // still awaiting the old server's close notification in this test process.
    const [recovered] = await cli(f, ["operation", "get", "--domain", "incident", "--database-id", f.incident.incidentRef.split(":")[2]!, "--request-id", input.requestId]);
    const result = recovered.data;
    assert.equal(result.state, "succeeded");
    assert.equal((await f.client().observationEvents()).data.entries.filter(e => e.kind === "incident_ack").length, 1);
    assert.equal((await f.client().incident(input.incidentRef)).data.incident.revision, result.appliedRevision);
  } finally { await f.close(); }
});

test("malformed incident writes and read-only callers leave database bytes unchanged", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.observations.path), input = f.request();
    for (const extra of [{ expectedRevision: 1.2 }, { requestId: "bad" }, { action: "resolve" }, { untilMs: Date.now() }, { private: true }]) {
      const response = await fetch(`${f.server.url}/v1/incident-changes`, { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "x-grokbox-installation-id": INSTALLATION, "content-type": "application/json" }, body: JSON.stringify({ ...input, ...extra }) });
      assert.equal(response.status, 400);
    }
    await rejects(f.client(READER).changeIncident(input), "permission_denied");
    assert.deepEqual(await readFile(f.observations.path), before);
  } finally { await f.close(); }
});

test("formal CLI incident action, cross-domain receipt lookup and event watch share one Server", async () => {
  const f = await fixture();
  try {
    const input = f.request(), cursor = (await f.client().observation()).data.cursor;
    const [output] = await cli(f, ["incident", "ack", input.incidentRef, "--request-id", input.requestId, "--expect-revision", String(input.expectedRevision)]);
    assert.equal(output.data.state, "succeeded");
    const [lookup] = await cli(f, ["operation", "get", "--domain", "incident", "--database-id", output.data.databaseId, "--request-id", input.requestId]);
    assert.deepEqual(lookup.data, output.data);
    const [detail] = await cli(f, ["incident", "get", input.incidentRef]); assert.equal(detail.data.incident.acknowledged, true);
    const events = await cli(f, ["event", "watch", "--cursor", cursor, "--duration-ms", "20"]);
    assert.equal(events.at(-1).data.kind, "end");
    assert.ok(events.some(frame => frame.data.kind === "page" && frame.data.page.entries.some((e: { kind: string }) => e.kind === "incident_ack")));
  } finally { await f.close(); }
});

for (const reason of ["abort", "revoke", "epoch"] as const) test(`event watch: ${reason} ends only its subscription and preserves the cursor boundary`, async () => {
  const f = await fixture(), cancel = new AbortController();
  try {
    const cursor = (await f.client().observation()).data.cursor;
    const iterator = f.client().watchObservationEvents({ cursor, durationMs: 5000, signal: cancel.signal });
    const first = await iterator.next(); assert.equal(first.value?.data.kind, "page");
    if (reason === "abort") cancel.abort();
    if (reason === "revoke") f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(cap => cap !== "observations.read");
    if (reason === "epoch") { await f.observations.finish(f.seeded.epoch, Date.now()); await f.observations.begin(randomUUID(), Date.now(), [f.state.bots[0]!.id]); }
    await rejects(iterator.next(), reason === "abort" ? "unavailable" : reason === "revoke" ? "permission_denied" : "cursor_gap");
    assert.equal((await f.client().identity()).data.installationId, INSTALLATION);
    assert.equal(f.state.ownershipReads, 0);
  } finally { cancel.abort(); await f.close(); }
});

test("a closed CLI output pipe cancels its subscription without an uncaught EPIPE or collector shutdown", async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const cursor = (await f.client().observation()).data.cursor;
    child = spawn("node", [process.env.GROKBOX_TEST_CLI_ENTRY!, "event", "watch", "--cursor", cursor, "--duration-ms", "5000"], {
      cwd: f.root, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: f.root,
        GROKBOX_CONFIG_DIR: f.root, GROKBOX_BOX_RUNTIME_ROOT: f.root, SYNTHETIC_MANAGEMENT_CREDENTIAL: OWNER } });
    const closed = once(child, "close");
    let stderr = ""; child.stderr!.on("data", bytes => { stderr += bytes.toString(); });
    child.stdout!.once("data", () => child!.stdout!.destroy());
    const deadline = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    const [code, signal] = await closed; clearTimeout(deadline);
    assert.equal(signal, null); assert.equal(code, 74); assert.equal(stderr, "");
    assert.equal((await f.client().identity()).data.installationId, INSTALLATION);
    assert.equal(f.state.ownershipReads, 0);
  } finally { if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "close"); } await f.close(); }
});

test("event watch emits post-snapshot committed changes, a verified end and no native calls", async () => {
  const f = await fixture();
  try {
    const cursor = (await f.client().observation()).data.cursor;
    const iterator = f.client().watchObservationEvents({ cursor, durationMs: 1100 });
    const first = await iterator.next(); assert.equal(first.value?.data.kind, "page");
    await f.client().changeIncident(f.request());
    const frames = []; for await (const item of iterator) frames.push(item.data);
    assert.equal(frames.at(-1)?.kind, "end");
    assert.equal(frames.flatMap(frame => frame.kind === "page" ? frame.page.entries : []).filter(e => e.kind === "incident_ack").length, 1);
    assert.equal(f.state.reads, 0); assert.equal(f.state.ownershipReads, 0);
  } finally { await f.close(); }
});
