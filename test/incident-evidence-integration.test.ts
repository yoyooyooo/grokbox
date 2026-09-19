import { expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { automaticFixture, SUBJECT, SOURCE, tick } from "../packages/box-runtime/test/fixtures/automatic-notice.ts";
import { ownedOwnershipSnapshot } from "../packages/box-runtime/test/ownership-fixture.ts";
import { createRunObserver, type RunObservation } from "../packages/box-runtime/src/internal/host/run-observation.ts";
import { appendHostJournal } from "../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { configureMonitorService } from "../packages/box-runtime/src/internal/io/monitor-installation.node.ts";
import { startMonitorService } from "../packages/box-runtime/src/internal/roots/monitor-service.runtime.ts";
import { startOpsNotificationWorker, automaticNoticeCycle, runAutomaticOpsNotification } from "../packages/box-runtime/src/internal/roots/ops-automatic-notification.runtime.ts";
import { runIncidentEvidenceCommand } from "../packages/box-runtime/src/internal/roots/incident-evidence.runtime.ts";

async function until<T>(read: () => Promise<T>, accepted: (v: T) => boolean) {
  const deadline = performance.now() + 8000;
  do { const result = await read(); if (accepted(result)) return result; await tick(10); } while (performance.now() < deadline);
  throw Error("owned_incident_integration_deadline");
}

/** Owned native boundary + actual production observer/journal/SQLite/collector /
 * persistent authorization/worker/private credential/loopback HTTP path. No raw
 * incident insertion after source ownership transfers to the service. This is
 * offline integration, not a production account or real Bot receipt. */
test("a failed source task becomes one fixed incident and one automatic safe notice, with query and restart preserving identity", async () => {
  const f = await automaticFixture();
  let collector: ReturnType<typeof startMonitorService> | undefined, sender: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    // Existing proven fixture provisions the private receiver and a seed HTTP
    // acceptance. The declaration is a test input, not a fabricated user read.
    const seed = await f.seed(); await f.activate(seed.workId);
    const original = await f.store.snapshot();
    await f.store.finish(original.collectorEpoch!, Date.now());
    const runRoot = join(f.root, "observed-run"); await mkdir(runRoot, { mode: 0o700 });
    const input = { durableRoot: f.root, runRoot, agentIds: [SUBJECT] };
    const plan = await configureMonitorService(input); if (plan.state !== "preview") throw Error("fixture_no_preview");
    await configureMonitorService({ ...input, confirmed: true, operationId: randomUUID(), expectedRevision: plan.expectedRevision });
    const writes: Array<ReturnType<typeof appendHostJournal>> = [];
    const emit = (event: RunObservation) => { writes.push(appendHostJournal(runRoot, event, { configurationRoot: f.root })); };
    const observer = createRunObserver({ generation: SOURCE, instrumented: true, emit });
    const read = async (agentIds: string[]) => ({ snapshot: { ...ownedOwnershipSnapshot(agentIds), runObservation: observer.snapshot(agentIds) },
      gateway: { pid: 4242, startedAt: 1700000000000 } });
    collector = startMonitorService({ durableRoot: f.root, read }, { pollMs: 10 });
    await until(async () => collector!.status(), state => state.collectorEpoch !== null);
    sender = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 10, blockedMs: 10 });
    const nativeError = Error("PRIVATE_UPSTREAM_TASK_ERROR");
    const task = observer.queue(SUBJECT, async () => { throw nativeError; }, { source: "turn" });
    await expect(task.task()).rejects.toBe(nativeError); await Promise.all(writes);
    await until(async () => f.requests, requests => requests.length === 2);
    const work = (await f.store.notificationWork()).find(work => work.id !== seed.workId)!;
    expect(work).toBeDefined();
    const payload = JSON.parse(f.requests[1]!);
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_|PRIVATE_TEST_KEY|bindings\.json/);
    expect(Buffer.byteLength(f.requests[1]!)).toBeLessThanOrEqual(8192);
    const incidentId = String(work.incidentId), revision = Number(work.evidenceRevision);
    expect(Number.isSafeInteger(revision) && revision > 0).toBe(true);
    // The stored work is authoritative for the fixed revision, never a latest
    // capture guessed from live source state after the notice was accepted.
    const notifications = await f.store.notificationNotice(work.id as string);
    expect(notifications).toBeDefined();
    const publicBytes = JSON.stringify(await f.store.notificationWork());
    expect(publicBytes).not.toContain("PRIVATE_UPSTREAM_TASK_ERROR");
    const incident = (await f.store.incidents()).find(row => row.id === incidentId)!;
    expect(incident).toBeDefined();
    const first = await runIncidentEvidenceCommand({ durableRoot: f.root, command: { kind: "read", incidentId: incident.id, revision } });
    expect(first).toMatchObject({ state: "available" });
    expect(JSON.stringify(first)).not.toContain("PRIVATE_UPSTREAM_TASK_ERROR");
    await collector.close(); collector = undefined;
    await sender.close(); sender = undefined;
    collector = startMonitorService({ durableRoot: f.root, read }, { pollMs: 10 });
    sender = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 10, blockedMs: 10 });
    await until(async () => collector!.status(), state => state.sources.length > 0);
    await tick(50);
    expect(f.requests).toHaveLength(2);
    expect(await runIncidentEvidenceCommand({ durableRoot: f.root, command: { kind: "read", incidentId: incident.id, revision } })).toEqual(first);
    await collector.close(); collector = undefined; await sender.close(); sender = undefined;
    const bytes = await readFile(f.store.path); await tick(30); expect(await readFile(f.store.path)).toEqual(bytes);
  } finally { await collector?.close(); await sender?.close(); await f.close(); }
}, 20000);

test("an old failure indexed after authorization cannot become a new automatic wakeup", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const authorization = (await f.owner.record("default"))!.automatic!;
    const epoch = (await f.store.snapshot()).collectorEpoch!;
    await tick(5); const indexedAt = Date.now(), sourceAt = authorization.activatedAtMs - 1000;
    await f.store.ingestEvidence({ epoch, sourceKey: "7".repeat(64), expectedCursor: null, nextCursor: "late-old-failure", atMs: indexedAt,
      events: [{ name: "host_stream_rejected", schemaVersion: 2, at: new Date(sourceAt).toISOString(), mode: "route",
        hostGenerationId: SOURCE, agentId: SUBJECT, stepId: "old-buffered-step", turnId: "old-buffered-turn",
        stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" }] });
    const work = (await f.store.notificationWork()).find(w => w.id !== seed.workId)!;
    expect(work).toBeDefined(); expect(Number(work.createdAtMs)).toBeGreaterThan(authorization.activatedAtMs);
    const beforeReads = f.reads();
    expect(await runAutomaticOpsNotification({ ...f.input, workId: String(work.id), authorization }, { request: f.request }))
      .toMatchObject({ state: "blocked", reason: "work_precedes_authorization" });
    expect(await automaticNoticeCycle(f.input, { request: f.request })).toMatchObject({ state: "idle", reason: "no_fresh_work" });
    expect(f.reads()).toBe(beforeReads); expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});
