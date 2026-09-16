import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { hostVisibleStreamError } from "../src/internal/host/session.ts";
import { traceAlerts, type AlertObservationEvent } from "@grokbox/runtime-kernel/alerts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOURCE = "b".repeat(64), HOST = "c".repeat(64), NOW = Date.parse("2026-09-16T03:00:00Z");
async function fixture(options: Parameters<typeof openMonitorStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "monitor-durability-review-")), epoch = randomUUID(), store = openMonitorStore(root, options);
  await store.initialize(); await store.begin(epoch, NOW, [AGENT]);
  return { root, epoch, store, close: () => rm(root, { recursive: true, force: true }) };
}
const failure = (step: string, at = NOW) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route", hostGenerationId: HOST, agentId: AGENT, turnId: "turn-a", stepId: step, errorCode: "invalid_stream", stage: "normalize", reason: "terminal-rejected" });
function alertEvents() {
  const events: AlertObservationEvent[] = [];
  const observer = createAlertObserver({ generation: HOST, emit: e => events.push(e), now: () => NOW });
  const manager = { getTrays: () => [], emit: (_v: unknown) => undefined };
  observer.attachManager(manager);
  const error = (step: string) => hostVisibleStreamError({ userVisible: true, code: "invalid_stream", message: "synthetic", failureId: `failure-${step}`, agentId: AGENT, invocationId: step });
  observer.decision(error("step-a"), { agentId: AGENT }, true, () => manager.emit({ type: "pushed", tray: { kind: "error", id: "shared-tray", agentId: AGENT } }));
  observer.decision(error("step-b"), { agentId: AGENT }, true, () => manager.emit({ type: "pushed", tray: { kind: "error", id: "shared-tray", agentId: AGENT } }));
  return [...events, { ...failure("step-a"), failureId: "failure-step-a" }, { ...failure("step-b"), failureId: "failure-step-b" }];
}

test("a failed initial transaction can be retried without deleting a poisoned empty database", async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-init-review-")); let fail = true;
  const store = openMonitorStore(root, { beforePublish: () => { if (fail) throw new Error("injected failure"); } });
  try {
    await expect(store.initialize()).rejects.toThrow(); fail = false;
    expect((await store.initialize()).created).toBe(true);
    expect((await store.snapshot()).storage).toMatchObject({ engine: "sqlite-disk", lifetimeEventLimit: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live collector with an unverifiable recorded start is not silently stolen", async () => {
  const f = await fixture();
  try {
    const db = await openMonitorSqlite(f.store.path, "write");
    try { await db.run("UPDATE meta SET owner_start=NULL WHERE singleton=1"); } finally { await db.close(); }
    await expect(f.store.begin(randomUUID(), NOW + 1, [AGENT])).rejects.toThrow("monitor_already_running_or_recovery_required");
  } finally { await f.close(); }
});

test("facts, incident and source checkpoint commit atomically under an injected rollback", async () => {
  let fail = false; const f = await fixture({ beforePublish() { if (fail) throw new Error("private fault"); } });
  try {
    const batch = { epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "cursor-1", events: [failure("step")], atMs: NOW + 1 };
    fail = true; await expect(f.store.ingestEvidence(batch)).rejects.toThrow();
    expect(await f.store.evidenceCursor(SOURCE)).toBeNull(); expect(await f.store.incidents()).toEqual([]);
    fail = false; await f.store.ingestEvidence(batch);
    const duplicate = await f.store.ingestEvidence(batch);
    expect(duplicate.duplicate).toBe(true); expect(await f.store.incidents()).toHaveLength(1);
    expect((await f.store.evidenceCursor(SOURCE))?.cursor).toBe("cursor-1");
  } finally { await f.close(); }
});

test("journal and monitor use the same complete explicit Tray closure for a STEP query", async () => {
  const f = await fixture();
  try {
    const events = alertEvents(), selector = { agentId: AGENT, stepId: "step-a" };
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "one", events, atMs: NOW + 1 });
    const direct = traceAlerts(events, selector), indexed = await f.store.alertTrace(selector);
    expect(indexed.traces.map(t => t.events.map(e => e.eventId))).toEqual(direct.traces.map(t => t.events.map(e => e.eventId)));
    expect(indexed.traces[0].trays[0].executions).toEqual(direct.traces[0].trays[0].executions);
  } finally { await f.close(); }
});

test("a conflicting source event remains a conflict in persisted traces, not only the ingest receipt", async () => {
  const f = await fixture();
  try {
    const events = alertEvents(), created = events.find(e => e.name === "host_alert_observation" && "kind" in e && e.kind === "tray_created") as AlertObservationEvent;
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "one", events, atMs: NOW + 1 });
    const conflict = { ...created, count: 900 };
    const result = await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: "one", nextCursor: "two", events: [conflict], atMs: NOW + 2 });
    expect(result.conflicts).toBe(1);
    const trace = await f.store.alertTrace({ trayId: "shared-tray" });
    expect(trace.traces[0].integrity).toBe("conflict");
  } finally { await f.close(); }
});

test("automatic retention preserves acknowledged occurrence metadata and its management meaning", async () => {
  const f = await fixture({ retentionMs: 100, eventTarget: 2 });
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "one", events: [failure("step")], atMs: NOW });
    const incident = (await f.store.incidents())[0];
    const request = { requestId: randomUUID(), incidentId: incident.id, expectedRevision: 1, action: "ack" as const, nowMs: NOW + 1 };
    await f.store.manage(request); await f.store.maintain(NOW + 1000);
    expect((await f.store.incidents()).find(i => i.id === incident.id)).toMatchObject({ acknowledged: true, status: "recorded" });
    expect(await f.store.manage(request)).toMatchObject({ duplicate: true, appliedRevision: 2 });
  } finally { await f.close(); }
});

test("maintenance never moves the event cursor backwards when all retained events are removed", async () => {
  const f = await fixture({ retentionMs: 100 });
  try {
    const before = await f.store.snapshot(NOW);
    await f.store.maintain(NOW + 1000);
    const after = await f.store.snapshot(NOW + 1000);
    expect(Number(after.cursor.split(":").at(-1))).toBeGreaterThanOrEqual(Number(before.cursor.split(":").at(-1)));
  } finally { await f.close(); }
});

test("observability reads do not modify the DB or create journal sidecars", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "one", events: alertEvents(), atMs: NOW });
    const before = await readFile(f.store.path), beforeStat = await stat(f.store.path), names = await readdir(join(f.root, "observability"));
    await f.store.alertTrace({ trayId: "shared-tray" }); await f.store.storageHealth(); await f.store.events();
    expect(await readFile(f.store.path)).toEqual(before); expect((await stat(f.store.path)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(join(f.root, "observability"))).toEqual(names);
  } finally { await f.close(); }
});
