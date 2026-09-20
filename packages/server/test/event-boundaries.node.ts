import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagementClient } from "@grokbox/client";
import { startInstalledManagementServer } from "../src/server.ts";
import { writeWatchChunk } from "../src/event-watch.ts";
import { MonitorSqlite, openMonitorSqlite } from "../../box-runtime/src/internal/io/monitor-sqlite.node.ts";
import { webFixture, INSTALLATION, OWNER } from "../../../apps/web/test/fixture.ts";
import { seedObservations } from "../../../apps/web/test/observation-fixture.ts";

const origin = "https://event-boundaries.example.test";
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code);
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw Error("event_test_deadline"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture() { const f = await webFixture(origin); await seedObservations(f); return f; }

test("event subscription capacity preserves ordinary API availability and cancellation returns all slots", async () => {
  const f = await fixture(), owners = Array.from({ length: 8 }, () => new AbortController());
  const iterators: ReturnType<ManagementClient["watchObservationEvents"]>[] = [];
  try {
    const cursor = (await f.client().observation()).data.cursor;
    for (const owner of owners) {
      const iterator = f.client().watchObservationEvents({ cursor, durationMs: 5000, signal: owner.signal }); iterators.push(iterator);
      assert.equal((await iterator.next()).value?.data.kind, "page");
    }
    await rejects(f.client().watchObservationEvents({ cursor, durationMs: 10 }).next(), "unavailable");
    assert.equal((await f.client().identity()).data.installationId, INSTALLATION);
    owners.forEach(owner => owner.abort()); await Promise.all(iterators.map(iterator => iterator.return(undefined)));
    await until(() => f.server.status().activeRequests === 0);
    const frames = []; for await (const item of f.client().watchObservationEvents({ cursor, durationMs: 1 })) frames.push(item.data.kind);
    assert.deepEqual(frames, ["page", "end"]);
  } finally { owners.forEach(owner => owner.abort()); await Promise.all(iterators.map(iterator => iterator.return(undefined))); await f.close(); }
});

test("concurrent subscribers share an in-flight cursor read but not cancellation or authorization", async () => {
  const f = await fixture(), first = new AbortController(), second = new AbortController();
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), original = f.observations.events;
  f.observations.events = async (...args) => { reads++; await gate; return original(...args); };
  try {
    const cursor = (await f.client().observation()).data.cursor;
    const a = f.client().watchObservationEvents({ cursor, signal: first.signal }), b = f.client().watchObservationEvents({ cursor, signal: second.signal });
    const nextA = a.next().then(value => value, error => error), nextB = b.next();
    await until(() => f.server.status().activeRequests === 2 && reads === 1);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(reads, 1);
    first.abort(); assert.equal((await nextA).code, "unavailable");
    release(); assert.equal((await nextB).value?.data.kind, "page"); assert.equal(reads, 1);
    second.abort(); await b.return(undefined); await a.return(undefined);
    await until(() => f.server.status().activeRequests === 0);
  } finally { release(); first.abort(); second.abort(); await f.close(); }
});

test("revocation during a blocked observation read releases no data frame", async () => {
  const f = await fixture(); let release!: () => void, entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), original = f.observations.events;
  f.observations.events = async (...args) => { entered = true; await gate; return original(...args); };
  try {
    const cursor = (await f.client().observation()).data.cursor;
    const result = f.client().watchObservationEvents({ cursor }).next();
    await until(() => entered);
    f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(cap => cap !== "observations.read");
    release(); await rejects(result, "permission_denied");
  } finally { release(); await f.close(); }
});

test("Node stream backpressure waits for drain and interrupted drain destroys only the subscribed stream", async () => {
  const source = new PassThrough({ highWaterMark: 1 }), owner = new AbortController();
  let completed = false;
  const pending = writeWatchChunk(source as unknown as ServerResponse, "bounded-frame", owner.signal).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  source.resume(); await pending;
  assert.equal(source.listenerCount("drain"), 0); assert.equal(source.listenerCount("error"), 0); source.destroy();
  const slow = new PassThrough({ highWaterMark: 1 });
  const blocked = writeWatchChunk(slow as unknown as ServerResponse, "bounded-frame", owner.signal);
  owner.abort(); await rejects(blocked, "unavailable");
  assert.equal(slow.destroyed, true); assert.equal(slow.listenerCount("drain"), 0); assert.equal(slow.listenerCount("error"), 0);
});

test("explicit client timeout ends an event window without fabricating a successful terminal frame", async () => {
  const f = await fixture();
  try {
    const cursor = (await f.client().observation()).data.cursor;
    const client = new ManagementClient({ baseUrl: f.server.url, installationId: INSTALLATION, credential: async () => OWNER, timeoutMs: 100 });
    const watch = client.watchObservationEvents({ cursor, durationMs: 5000 });
    assert.equal((await watch.next()).value?.data.kind, "page");
    await rejects(watch.next(), "unavailable");
    await until(() => f.server.status().activeRequests === 0);
  } finally { await f.close(); }
});

test("installed incident writer consults canonical policy for new effects but receipts survive bad configuration", async () => {
  const f = await fixture();
  let installed: Awaited<ReturnType<typeof startInstalledManagementServer>> | undefined;
  try {
    const seeded = await seedConflict(f);
    installed = await startInstalledManagementServer({ root: f.root, discoveryPath: join(f.root, "unused-native-discovery.json"), port: 0 });
    const client = new ManagementClient({ baseUrl: installed.url, installationId: INSTALLATION, credential: async () => OWNER });
    const request = { requestId: randomUUID(), incidentRef: seeded.incidentRef, expectedRevision: seeded.revision, action: "ack" as const };
    const result = (await client.changeIncident(request)).data;
    const before = await readFile(f.observations.path);
    await writeFile(join(f.root, "config.json"), "{invalid-synthetic-configuration", { mode: 0o600 });
    assert.deepEqual((await client.changeIncident(request)).data, result);
    assert.deepEqual((await client.incidentOperation(result.databaseId, request.requestId)).data, result);
    await rejects(client.changeIncident({ ...request, requestId: randomUUID(), expectedRevision: result.appliedRevision }), "source_unavailable");
    assert.deepEqual(await readFile(f.observations.path), before);
  } finally { await installed?.close(); await f.close(); }
});

async function seedConflict(f: Awaited<ReturnType<typeof webFixture>>) {
  const { epoch } = await f.observations.snapshot().then(snapshot => ({ epoch: snapshot.collectorEpoch! }));
  await f.observations.record(epoch, 2, { sampleId: randomUUID(), scopeId: null, gatewayEpoch: null, serverObservedAtMs: null,
    startedAtMs: Date.now(), completedAtMs: Date.now(), failure: "read_unavailable", agents: [] }, "off");
  return (await f.client().incidents()).data.incidents[0]!;
}

test("a lost SQLite COMMIT callback is unknown even before the adapter can mark it committed", async () => {
  const f = await fixture();
  const original = MonitorSqlite.prototype.run;
  try {
    const incident = await seedConflict(f), input = { incidentRef: incident.incidentRef, requestId: randomUUID(), expectedRevision: incident.revision, action: "ack" as const };
    let injected = false;
    MonitorSqlite.prototype.run = async function(sql, params) {
      await original.call(this, sql, params);
      if (sql === "COMMIT" && !injected) { injected = true; throw new Error("synthetic_lost_commit_callback"); }
    };
    await rejects(f.client().changeIncident(input), "operation_unknown");
    MonitorSqlite.prototype.run = original;
    assert.equal(injected, true);
    const lookup = (await f.client().incidentOperation(incident.incidentRef.split(":")[2]!, input.requestId)).data;
    assert.equal(lookup.appliedRevision, input.expectedRevision + 1);
    assert.equal((await f.client().observationEvents()).data.entries.filter(row => row.kind === "incident_ack").length, 1);
  } finally { MonitorSqlite.prototype.run = original; await f.close(); }
});

test("full incident receipt capacity rejects new writes without evicting or blocking completed lookups", async () => {
  const f = await fixture();
  try {
    const incident = await seedConflict(f), input = { incidentRef: incident.incidentRef, requestId: randomUUID(), expectedRevision: incident.revision, action: "ack" as const };
    const result = (await f.client().changeIncident(input)).data;
    // Populate only this test's private table to exercise real writer admission.
    const db = await openMonitorSqlite(f.observations.path, "write");
    try { await db.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<9999)
      INSERT INTO management(request_id,fingerprint,incident_id,revision,action)
      SELECT printf('55555555-5555-4555-8555-%012d',i),?, ?, 2, 'ack' FROM n`, ["a".repeat(64), incident.id]); }
    finally { await db.close(); }
    const before = await readFile(f.observations.path);
    await rejects(f.client().changeIncident({ ...input, requestId: randomUUID(), expectedRevision: result.appliedRevision }), "store_full");
    assert.deepEqual((await f.client().changeIncident(input)).data, result);
    assert.deepEqual((await f.client().incidentOperation(result.databaseId, input.requestId)).data, result);
    assert.deepEqual(await readFile(f.observations.path), before);
  } finally { await f.close(); }
});
