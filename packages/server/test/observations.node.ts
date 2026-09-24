import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { configureMonitorService, openMonitorStore } from "@grokbox/box-runtime/runtime";
import { startManagementServer } from "../src/server.ts";
import { appendNdjsonLine } from "../../box-runtime/src/internal/host/terminal-journal.node.ts";
import { webFixture, FIRST, SECOND, INSTALLATION, OWNER, READER } from "../../../apps/web/test/fixture.ts";
import { seedObservations } from "../../../apps/web/test/observation-fixture.ts";

const origin = "https://observation.example.test";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, timeoutMs = 8000) {
  const end = performance.now() + timeoutMs;
  do { if (await check()) return; await delay(20); } while (performance.now() < end);
  throw new Error("management_collector_test_deadline");
}
async function configureCollector(f: Awaited<ReturnType<typeof webFixture>>) {
  const input = { durableRoot: f.root, runRoot: f.root, agentIds: [FIRST] };
  const preview = await configureMonitorService(input); assert.equal(preview.state, "preview");
  if (preview.state !== "preview") throw new Error("missing_fixture_preview");
  await configureMonitorService({ ...input, confirmed: true, expectedRevision: preview.expectedRevision, operationId: randomUUID() });
}
async function appendFailure(f: Awaited<ReturnType<typeof webFixture>>) {
  await appendNdjsonLine(f.root, JSON.stringify({ name: "host_stream_rejected", schemaVersion: 2, at: new Date().toISOString(), mode: "route",
    hostGenerationId: "d".repeat(64), agentId: FIRST, turnId: "synthetic-observation-turn", stepId: "synthetic-observation-step",
    stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }), "host", { configurationRoot: f.root });
}
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => {
  assert.ok(error && typeof error === "object" && "code" in error); assert.equal(error.code, code); return true;
});

test("missing observation database stays missing through all authenticated reads", async () => {
  const f = await webFixture(origin);
  try {
    const before = await readdir(f.root);
    await rejects(f.client().observation(), "source_unavailable");
    await rejects(f.client().incidents(), "source_unavailable");
    await rejects(f.client().observationEvents(), "source_unavailable");
    assert.deepEqual(await readdir(f.root), before); assert.equal(f.state.reads, 0); assert.equal(f.state.ownershipReads, 0);
    await assert.rejects(stat(join(f.root, "observability")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("real SQLite snapshot, incident pages and event continuation are public read-only projections", async () => {
  const f = await webFixture(origin);
  try {
    const seeded = await seedObservations(f);
    const snapshot = (await f.client().observation()).data;
    assert.equal(snapshot.admissionAuthority, false); assert.equal(snapshot.collector.liveness, "not-probed");
    assert.equal(snapshot.agents.length, 2); assert.ok(snapshot.agents.every(row => row.freshness === "fresh"));
    assert.equal(snapshot.agents[0]!.botRef, `bot:${INSTALLATION}:${FIRST}`);
    await seeded.sample(seeded.at + 2, "temporal");
    const bytes = await readFile(f.observations.path), before = await stat(f.observations.path);
    const names = await readdir(join(f.root, "observability"));
    const changes = (await f.client().observationEvents({ cursor: snapshot.cursor })).data;
    assert.ok(changes.entries.some(row => row.kind === "ownership_changed"));
    assert.ok(changes.entries.every(row => row.seq > Number(snapshot.cursor.split(":").at(-1))));
    assert.equal(changes.gap, null);
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = (await f.client().incidents({ cursor, limit: 1 })).data;
      assert.ok(page.incidents.length <= 1);
      ids.push(...page.incidents.map(row => row.id));
      for (const incident of page.incidents) {
        assert.equal(incident.status, "open"); assert.equal(incident.acknowledged, false);
        assert.equal(incident.incidentRef, `incident:${INSTALLATION}:${snapshot.databaseId}:${incident.id}`);
        for (const forbidden of ["diagnosis", "summary_json", "notification", "raw", "path"]) assert.ok(!(forbidden in incident));
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.ok(ids.length >= 2); assert.equal(ids.length, new Set(ids).size);
    assert.deepEqual(await readFile(f.observations.path), bytes); assert.equal((await stat(f.observations.path)).mtimeMs, before.mtimeMs);
    assert.deepEqual(await readdir(join(f.root, "observability")), names); assert.equal(f.state.reads, 0); assert.equal(f.state.ownershipReads, 0);
  } finally { await f.close(); }
});

for (const surface of ["snapshot", "events"] as const) test(`public ${surface} retains pressure loss after collection resumes without mutating reads`, async () => {
  const f = await webFixture(origin);
  try {
    const seeded = await seedObservations(f), sourceKey = "c".repeat(64);
    const before = (await f.client().observation()).data;
    const writer = openMonitorStore(f.root, { maxDatabaseBytes: 512 * 1024 });
    const failures = Array.from({ length: 128 }, (_, n) => ({ name: "host_stream_rejected", schemaVersion: 2,
      at: new Date(seeded.at).toISOString(), mode: "route", hostGenerationId: "d".repeat(64), agentId: FIRST,
      turnId: `synthetic-pressure-turn-${n}`, stepId: `synthetic-pressure-step-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }));
    const dropped = await writer.ingestEvidence({ epoch: seeded.epoch, sourceKey, expectedCursor: null,
      nextCursor: "dropped", events: failures, atMs: seeded.at + 2, notifications: "off" });
    assert.equal(dropped.storagePressure, true); assert.equal(dropped.droppedEvents, failures.length);
    const pressured = surface === "snapshot" ? (await f.client().observation()).data
      : (await f.client().observationEvents({ cursor: before.cursor })).data;
    assert.deepEqual(pressured.observationHealth, { pressureState: "storage_pressure", droppedEvents: failures.length, rejectedBatches: 1 });
    const resumed = await writer.ingestEvidence({ epoch: seeded.epoch, sourceKey, expectedCursor: "dropped",
      nextCursor: "resumed", events: [], atMs: seeded.at + 3, notifications: "off" });
    assert.equal(resumed.storagePressure, false);
    assert.equal((await writer.evidenceCursor(sourceKey))?.gap, null);
    const raw = await writer.snapshot();
    assert.equal(raw.observationHealth?.pressure_state, "normal");
    assert.equal(raw.observationHealth?.dropped_events, failures.length);
    const bytes = await readFile(writer.path), metadata = await stat(writer.path);
    const result = surface === "snapshot" ? (await f.client().observation()).data
      : (await f.client().observationEvents({ cursor: before.cursor })).data;
    assert.deepEqual(result.observationHealth,
      { pressureState: "normal", droppedEvents: failures.length, rejectedBatches: 1 });
    assert.deepEqual(await readFile(writer.path), bytes);
    assert.equal((await stat(writer.path)).mtimeMs, metadata.mtimeMs);
    assert.equal(f.state.reads, 0); assert.equal(f.state.ownershipReads, 0);
  } finally { await f.close(); }
});

test("observation permission is checked before the store and is never inherited from model permission", async () => {
  const f = await webFixture(origin);
  try {
    let opened = 0;
    const original = f.observations.snapshot;
    f.observations.snapshot = (...args) => { opened++; return original(...args); };
    await rejects(f.client(READER).observation(), "permission_denied");
    await rejects(f.client(READER).incidents(), "permission_denied");
    assert.equal(opened, 0); assert.equal(f.state.reads, 0);
    await seedObservations(f);
    assert.ok((await f.client().observation()).data);
    f.state.grants[0]!.capabilities = f.state.grants[0]!.capabilities.filter(capability => capability !== "observations.read");
    await rejects(f.client().observation(), "permission_denied"); assert.equal(opened, 1);
  } finally { await f.close(); }
});

test("collector restart invalidates both event and incident cursors without modifying source identity", async () => {
  const f = await webFixture(origin);
  try {
    const seeded = await seedObservations(f); await seeded.sample(seeded.at + 2, "temporal");
    const snapshot = (await f.client().observation()).data;
    const page = (await f.client().incidents({ limit: 1 })).data; assert.ok(page.nextCursor);
    await f.observations.finish(seeded.epoch, seeded.at + 3);
    await f.observations.begin(randomUUID(), seeded.at + 4, [FIRST, SECOND]);
    await rejects(f.client().observationEvents({ cursor: snapshot.cursor }), "cursor_gap");
    await rejects(f.client().incidents({ cursor: page.nextCursor }), "cursor_gap");
    const next = (await f.client().observation()).data;
    assert.equal(next.databaseId, snapshot.databaseId); assert.notEqual(next.collectorEpoch, snapshot.collectorEpoch);
    assert.equal(f.state.reads, 0);
  } finally { await f.close(); }
});

test("old observations remain stale and stopped collectors do not become healthy on read", async () => {
  const f = await webFixture(origin);
  try {
    const seeded = await seedObservations(f, Date.now() - MONITOR_POLICY.staleAfterMs - 1000);
    const stale = (await f.client().observation()).data;
    assert.ok(stale.agents.every(row => row.freshness === "stale" && row.lastKnown?.state === "confirmed_box"));
    await f.observations.finish(seeded.epoch, Date.now());
    const stopped = (await f.client().observation()).data;
    assert.equal(stopped.collector.recordedRunning, false);
    assert.ok(stopped.agents.every(row => row.freshness === "unavailable" && row.lastKnown !== null));
  } finally { await f.close(); }
});

test("retention after an empty history returns a resumable cursor and an explicit coverage gap", async () => {
  const f = await webFixture(origin);
  try {
    const seeded = await seedObservations(f);
    const initial = (await f.client().observationEvents({ limit: 1 })).data;
    await f.observations.finish(seeded.epoch, seeded.at + 3);
    await f.observations.maintain(seeded.at + MONITOR_POLICY.retentionMs + 10_000);
    const page = (await f.client().observationEvents()).data;
    assert.equal(page.entries.length, 0); assert.ok(page.retentionFloor > 0); assert.equal(page.gap, "history-truncated");
    assert.ok(Number(page.cursor.split(":").at(-1)) >= page.retentionFloor);
    assert.equal((await f.client().observationEvents({ cursor: page.cursor })).data.gap, null);
    await rejects(f.client().observationEvents({ cursor: initial.cursor }), "cursor_gap");
  } finally { await f.close(); }
});

test("strict query limits, duplicate parameters and malformed cursors refuse without upstream work", async () => {
  const f = await webFixture(origin);
  try {
    for (const path of ["/v1/observation?limit=1", "/v1/incidents?limit=0", "/v1/incidents?limit=101", "/v1/incidents?limit=1&limit=2", "/v1/observation-events?root=/private", "/v1/observation-events?cursor="]) {
      const response = await fetch(`${f.server.url}${path}`, { headers: { authorization: `Bearer ${OWNER}`, "x-grokbox-installation-id": INSTALLATION } });
      assert.equal(response.status, 400);
      const body = await response.json() as { error: { code: string } }; assert.equal(body.error.code, "invalid_input");
    }
    assert.equal(f.state.reads, 0);
  } finally { await f.close(); }
});

test("management status is independently authorized and an unconfigured worker is inert", async () => {
  const f = await webFixture(origin);
  try {
    const before = await readdir(f.root), status = (await f.client().service()).data;
    assert.equal(status.component, "server"); assert.equal(status.state, "running");
    assert.equal(status.observation.owner, "management-server"); assert.equal(status.observation.state, "not_configured");
    assert.equal(status.observation.createsDatabase, false); assert.equal(status.observation.bootInstalled, false);
    assert.deepEqual(status.workers?.map(worker => worker.name), ["monitor", "notification-outbox", "protection"]);
    assert.equal(status.workers?.find(worker => worker.name === "monitor")?.started, false);
    assert.equal(status.workers?.find(worker => worker.name === "notification-outbox")?.sideEffects, "guarded-notification");
    assert.equal(status.workers?.find(worker => worker.name === "protection")?.sideEffects, "guarded-protection");
    assert.equal(status.effectivePolicy?.observation.enabled, false);
    assert.equal(status.effectivePolicy?.storage.installationBudgetEnforced, false);
    await rejects(f.client(READER).service(), "permission_denied");
    assert.deepEqual(await readdir(f.root), before); assert.equal(f.state.ownershipReads, 0);
  } finally { await f.close(); }
});

test("management Scope owns configured collection, settles on close and resumes without duplicate incidents", async () => {
  const f = await webFixture(origin);
  try {
    await configureCollector(f); await appendFailure(f); await f.restart();
    await until(async () => (await f.client().incidents()).data.incidents.some(row => row.rule === "execution_failure"));
    await until(async () => f.server.status().observation!.sources.length > 0);
    const status = (await f.client().service()).data, ids = (await f.client().incidents()).data.incidents.map(row => row.id).sort();
    assert.equal(status.observation.owner, "management-server"); assert.ok(status.observation.collectorEpoch);
    assert.ok(f.state.ownershipReads > 0);
    assert.equal(JSON.parse(await readFile(join(f.root, "config.json"), "utf8")).ops?.notifications?.mode ?? "off", "off");
    await f.server.close();
    assert.equal(f.server.status().observation!.state, "stopped");
    assert.equal((await f.observations.snapshot()).collectorRecordedRunning, false);
    const settled = await readFile(f.observations.path); await delay(50);
    assert.deepEqual(await readFile(f.observations.path), settled);
    await f.restart();
    await until(async () => {
      const worker = f.server.status().observation!;
      return worker.collectorEpoch !== null && worker.collectorEpoch !== status.observation.collectorEpoch && worker.sources.length > 0;
    });
    assert.deepEqual((await f.client().incidents()).data.incidents.map(row => row.id).sort(), ids);
  } finally { await f.close(); }
});

test("fresh direct clients can read the same retained domain after repeated same-port fixture restarts", async () => {
  const f=await webFixture(origin);
  try {
    const seeded=await seedObservations(f);await seeded.sample(seeded.at+2,"temporal");
    const expected=(await f.client().incidents()).data.incidents.map(r=>r.id).sort();assert.ok(expected.length>0);
    for(let i=0;i<12;i++){
      await f.restart();assert.deepEqual((await f.client().incidents()).data.incidents.map(r=>r.id).sort(),expected);
    }
  }finally{await f.close();}
});

test("a competing management worker remains blocked without disrupting the first owner or API", async () => {
  const f = await webFixture(origin); let other: Awaited<ReturnType<typeof startManagementServer>> | undefined;
  try {
    await configureCollector(f); await f.restart();
    await until(async () => f.server.status().observation!.collectorEpoch !== null);
    const epoch = f.server.status().observation!.collectorEpoch;
    other = await startManagementServer({ store: f.store, observations: f.observations, installationId: INSTALLATION,
      native: f.native, env: {}, readGrants: async () => f.state.grants });
    await until(async () => other!.status().observation!.reason === "monitor_already_running_or_recovery_required");
    assert.equal(other.status().state, "running"); assert.equal(f.server.status().observation!.collectorEpoch, epoch);
    assert.ok((await f.client().models()).data.models.length > 0);
    await other.close(); other = undefined;
    assert.equal((await f.observations.snapshot()).collectorRecordedRunning, true);
  } finally { await other?.close(); await f.close(); }
});

test("management shutdown cancels a pending native observation and produces no late writes", async () => {
  const f = await webFixture(origin); let called = false, cancelled = false;
  try {
    await configureCollector(f);
    f.native.ownershipRead = async (_ids, signal) => {
      called = true;
      return new Promise((_resolve, reject) => {
        const abort = () => { cancelled = true; reject(new Error("synthetic_observation_cancelled")); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
    };
    await f.restart(); await until(async () => called);
    await f.server.close(); assert.equal(cancelled, true);
    const bytes = await readFile(f.observations.path); await delay(50);
    assert.deepEqual(await readFile(f.observations.path), bytes);
    assert.equal((await f.observations.snapshot()).collectorRecordedRunning, false);
    assert.equal(f.server.status().observation!.state, "stopped");
  } finally { await f.close(); }
});

test("a corrupt observation database remains unchanged and is not projected as empty", async () => {
  const f = await webFixture(origin);
  try {
    await seedObservations(f);
    const broken = Buffer.from("synthetic broken sqlite\n"); await writeFile(f.observations.path, broken);
    await rejects(f.client().observation(), "source_unavailable");
    await rejects(f.client().incidents(), "source_unavailable");
    assert.deepEqual(await readFile(f.observations.path), broken);
  } finally { await f.close(); }
});
