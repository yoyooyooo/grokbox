import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { createAlertObserver } from "../src/internal/host/alert-observation.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST = "a".repeat(64), NOW = Date.now();
const failure = (step = "step-a", at = NOW) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route", hostGenerationId: HOST, agentId: AGENT, turnId: "turn-a", stepId: step, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", failureId: "failure-one", diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", prompt: "PRIVATE_SENTINEL" } });
async function fixture(options: Parameters<typeof openMonitorStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), "incident-evidence-")), run = join(root, "run"), store = openMonitorStore(root, options), epoch = randomUUID();
  await mkdir(join(run, "log"), { recursive: true }); await store.initialize(); await store.begin(epoch, NOW, [AGENT]);
  return { root, run, store, epoch, sourceKey: sha256Text(run), close: () => rm(root, { recursive: true, force: true }) };
}

test("native unknown tray and failed queue without STEP are persisted and produce ready evidence notices", async () => {
  const f = await fixture();
  try {
    const events: unknown[] = [];
    const observer = createAlertObserver({ generation: HOST, now: () => NOW, emit: event => events.push(event) });
    const manager = { getTrays: () => [], emit: (_v: unknown) => undefined };
    observer.attachManager(manager);
    manager.emit({ type: "pushed", tray: { id: "tray-unknown", kind: "error", agentId: AGENT, detail: "PRIVATE_SENTINEL" } });
    events.push({ name: "host_run_observation", at: new Date(NOW).toISOString(), hostGenerationId: HOST, agentId: AGENT, dispatchId: "dispatch-a", state: "failed", source: "turn" });
    for (const event of events) expect(await appendHostJournal(f.run, event)).toBe("written");
    const batch = await readJournalBatch(f.run, null);
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: batch.nextCursor!, events: batch.events, atMs: NOW });
    const incidents = await f.store.incidents(); expect(incidents.map(i => i.rule).sort()).toEqual(["native_alert", "native_run_failure"]);
    const work = await f.store.notificationWork(); expect(work).toHaveLength(2); expect(work.every(w => w.state === "ready")).toBe(true);
    for (const item of work) {
      const notice = await f.store.notificationNotice(String(item.id));
      expect(notice.behavior).toBe("notify_then_end"); expect(notice.automaticIssue).toBe(false);
      expect(notice.commands[0]?.argv).toContain(String(item.incidentId));
      expect(JSON.stringify(notice)).not.toContain("PRIVATE_SENTINEL");
      const report = await f.store.incidentEvidence(String(item.incidentId), Number(item.evidenceRevision));
      expect(report).toMatchObject({ state: "available", replayAuthorized: false });
      expect(JSON.stringify(report)).not.toContain("PRIVATE_SENTINEL");
    }
  } finally { await f.close(); }
});

test("snapshot queries are byte-for-byte read-only; restart and later facts do not rewrite a revision", async () => {
  const f = await fixture();
  try {
    const input = { epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: "one", events: [failure()], atMs: NOW };
    await f.store.ingestEvidence(input);
    const id = (await f.store.incidents())[0]!.id;
    const report = await f.store.incidentEvidence(id, 1), before = await readFile(f.store.path), mtime = (await stat(f.store.path)).mtimeMs;
    expect(await openMonitorStore(f.root).incidentEvidence(id, 1)).toEqual(report);
    await f.store.incidentEvidence(id, 1, "public-summary");
    expect(await readFile(f.store.path)).toEqual(before); expect((await stat(f.store.path)).mtimeMs).toBe(mtime);
    expect((await f.store.ingestEvidence(input)).duplicate).toBe(true); expect(await f.store.notificationWork()).toHaveLength(1);
    await f.store.ingestEvidence({ ...input, expectedCursor: "one", nextCursor: "two", events: [{ ...failure("step-b", NOW + 1), failureId: "failure-two" }], atMs: NOW + 1 });
    expect((await f.store.captureIncident(id, NOW + 2)).revision).toBe(2);
    expect(await f.store.incidentEvidence(id, 1)).toEqual(report);
  } finally { await f.close(); }
});

test("ack preserves management without permanently pinning detail; active lease protects a fixed revision", async () => {
  const f = await fixture({ retentionMs: 100, eventTarget: 2 });
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: "one", events: [failure()], atMs: NOW });
    const id = (await f.store.incidents())[0]!.id;
    const request = { requestId: randomUUID(), incidentId: id, expectedRevision: 1, action: "ack" as const, nowMs: NOW + 1 };
    await f.store.manage(request);
    await f.store.evidenceLease({ incidentId: id, revision: 1, durationMs: 500, nowMs: NOW + 10 });
    await f.store.maintain(NOW + 200);
    expect(await f.store.incidentEvidence(id, 1)).toMatchObject({ state: "available", retention: { tier: "detail" } });
    await f.store.maintain(NOW + 1000);
    expect(await f.store.incidentEvidence(id, 1)).toMatchObject({ state: "expired", retention: { tier: "summary" }, facts: [] });
    expect((await f.store.manage(request)).duplicate).toBe(true);
    expect((await f.store.incidents())[0]?.acknowledged).toBe(true);
    const replay = await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: "one", nextCursor: "rotated", events: [failure()], atMs: NOW + 1001 });
    expect(replay.inserted).toBe(0); expect(replay.retirementSkipped).toBe(1);
  } finally { await f.close(); }
});

test("unsupported source shape produces a coverage incident without persisting unknown payload", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: "one", events: [{ name: "future_event", prompt: "PRIVATE_SENTINEL" }], atMs: NOW });
    expect((await f.store.incidents())[0]?.rule).toBe("source_gap");
    expect(await f.store.notificationWork()).toHaveLength(1);
    expect((await readFile(f.store.path)).includes(Buffer.from("PRIVATE_SENTINEL"))).toBe(false);
  } finally { await f.close(); }
});

async function fixtureAsVersionTwo(f: Awaited<ReturnType<typeof fixture>>) {
  // This fixture owns its temporary database. Remove only this increment's DDL
  // to reconstruct the preceding disk schema with its original incident rows.
  const db=await openMonitorSqlite(f.store.path,"write");
  try{await db.run(`BEGIN IMMEDIATE;
    DROP TABLE snapshot_links; DROP TABLE evidence_leases; DROP TABLE incident_snapshots;
    DROP TABLE notification_attempts; DROP TABLE notification_work; DROP TABLE notification_tests; DROP TABLE open_executions;
    DROP TABLE evidence_retirement; DROP TABLE observation_maintenance; DROP TABLE incident_evidence_history;
    DROP INDEX evidence_turn; DROP INDEX evidence_dispatch;
    UPDATE meta SET version=2; PRAGMA user_version=2; COMMIT;`);
  }finally{await db.close();}
}
test("explicit disk v2 migration preserves historical acknowledgement without manufacturing snapshots or notifications",async()=>{
  const f=await fixture();
  try{
    await f.store.ingestEvidence({epoch:f.epoch,sourceKey:f.sourceKey,expectedCursor:null,nextCursor:"one",events:[failure()],atMs:NOW});
    const id=(await f.store.incidents())[0]!.id;
    const ack={requestId:randomUUID(),incidentId:id,expectedRevision:1,action:"ack" as const,nowMs:NOW+1};
    await f.store.manage(ack);await f.store.finish(f.epoch,NOW+2);await fixtureAsVersionTwo(f);
    expect((await f.store.snapshot()).storage.migrationRequired).toBe(true);
    const before=await readFile(f.store.path);
    await expect(f.store.incidentEvidence(id,1)).rejects.toThrow("monitor_migration_required");
    expect(await readFile(f.store.path)).toEqual(before);
    expect(await f.store.initialize()).toMatchObject({migrated:true,created:false});
    expect((await f.store.snapshot()).schemaVersion).toBe(4);
    expect((await f.store.incidents())[0]).toMatchObject({id,acknowledged:true});
    expect((await f.store.manage(ack)).duplicate).toBe(true);
    expect(await f.store.incidentEvidence(id,1)).toMatchObject({state:"not_checked",reason:"snapshot_not_captured"});
    expect(await f.store.notificationWork()).toEqual([]);
  }finally{await f.close();}
});
test("a still-live v2 collector blocks schema migration instead of being silently replaced",async()=>{
  const f=await fixture();
  try{await fixtureAsVersionTwo(f);await expect(f.store.initialize()).rejects.toThrow("monitor_migration_requires_stop");expect((await f.store.snapshot()).schemaVersion).toBe(2);}
  finally{await f.close();}
});

test("snapshot revisions are bounded, never renumbered, and eviction is not reported as never captured", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: "0", events: [failure()], atMs: NOW });
    const id = (await f.store.incidents())[0]!.id, first = await f.store.incidentEvidence(id, 1);
    for (let n = 1; n <= 10; n++) {
      await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: String(n - 1), nextCursor: String(n),
        events: [{ ...failure("step-a", NOW + n), diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", wireSequence: n } }], atMs: NOW + n });
      expect((await f.store.captureIncident(id, NOW + n)).revision).toBe(n + 1);
    }
    const db = await openMonitorSqlite(f.store.path, "read");
    try { expect(Number((await db.first("SELECT COUNT(*) AS n FROM incident_snapshots WHERE incident_id=?", [id]))?.n)).toBe(3); }
    finally { await db.close(); }
    // The live notification still points to the original, protected revision.
    expect(await f.store.incidentEvidence(id, 1)).toEqual(first);
    expect(await f.store.incidentEvidence(id, 2)).toMatchObject({ state: "expired", reason: "snapshot_revision_retired", facts: [] });
    expect(await f.store.incidentEvidence(id, 100)).toMatchObject({ state: "not_checked", reason: "snapshot_not_captured" });
    expect((await f.store.notificationWork())[0]?.evidenceRevision).toBe(1);
  } finally { await f.close(); }
});

test("a full set of protected revisions blocks a new capture without changing or deleting prior evidence", async () => {
  const f = await fixture();
  try {
    let id = "";
    for (let n = 0; n <= 3; n++) {
      await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: n ? String(n - 1) : null, nextCursor: String(n),
        events: [{ ...failure("step-a", NOW + n), diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", wireSequence: n } }], atMs: NOW + n });
      if (!n) id = (await f.store.incidents())[0]!.id;
      if (n === 3) {
        const before = await readFile(f.store.path);
        await expect(f.store.captureIncident(id, NOW + n)).rejects.toThrow("monitor_evidence_revisions_protected");
        expect(await readFile(f.store.path)).toEqual(before);
      } else {
        if (n) await f.store.captureIncident(id, NOW + n);
        await f.store.evidenceLease({ incidentId: id, revision: n + 1, durationMs: 60_000, nowMs: NOW + n });
      }
    }
  } finally { await f.close(); }
});

test("clock reversal refuses destructive TTL work, and no-source silence cannot be declared a stall", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: f.sourceKey, expectedCursor: null, nextCursor: "one", events: [{ name: "host_run_observation", at: new Date(NOW).toISOString(), hostGenerationId: HOST, agentId: AGENT, dispatchId: "dispatch-a", state: "started", source: "turn" }], atMs: NOW });
    expect(await f.store.detectUnsettled({ nowMs: NOW + 600_000, sourceLiveness: new Map() })).toMatchObject({ suspected: 0, unqualified: 1 });
    expect(await f.store.detectUnsettled({ nowMs: NOW + 600_000, sourceLiveness: new Map([[f.sourceKey, NOW + 600_000]]) })).toMatchObject({ suspected: 1 });
    await f.store.maintain(NOW + 600_000);
    expect((await f.store.maintain(NOW)).retention).toMatchObject({ mayExpire: false, state: "clock_reversed" });
  } finally { await f.close(); }
});
