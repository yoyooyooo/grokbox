import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, effectiveStorage } from "@grokbox/runtime-kernel/config";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { inspectJournalSegments } from "../src/internal/host/journal-segments.node.ts";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { openBoundedProcessLog, observeProcessLogStorage } from "../src/internal/io/bounded-process-log.node.ts";
import { observeDiagnosticFootprint } from "../src/internal/io/storage-footprint.node.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST = "b".repeat(64);
const DB_BYTES = 1024 * 1024, LOG_BYTES = 8192, PERIOD = 60_000;
const policy = { segmentBytes: 2048, maxBytes: LOG_BYTES, maxAgeMs: 3 * PERIOD };

/** Real bounded writers/readers and SQLite. Only the wall clock and small
 * capacities are injected. No system clock changes, native account, network,
 * business ledger deletion or inference from a row count to physical bytes. */
test("twenty-four fill/retire cycles keep registered diagnostic stores bounded while leased evidence and user files survive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observation-soak-"));
  const root = join(directory, "durable"), run = join(directory, "run");
  let processLog: Awaited<ReturnType<typeof openBoundedProcessLog>> | undefined;
  try {
    await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
    const config = { ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" } } };
    await writeFile(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    const protectedPath = join(root, "user-export.json"), userBytes = "USER_EXPORT_AND_RECOVERY_ARE_NOT_DIAGNOSTIC_GC";
    await writeFile(protectedPath, userBytes, { mode: 0o600 });
    const base = Date.now(), epoch = randomUUID();
    const store = openMonitorStore(root, { maxDatabaseBytes: DB_BYTES, retentionMs: 2 * PERIOD, summaryMs: 3 * PERIOD, eventTarget: 40 });
    await store.initialize(); await store.begin(epoch, base, [AGENT]);
    const roots = [run, root], cursors = new Map<string, string | null>(), seenSteps = new Set<string>();
    let retained: { id: string; value: Awaited<ReturnType<typeof store.incidentEvidence>>; expiresAt: number } | undefined;
    const samples: Array<{ database: number; journal: number; process: number; snapshots: number; total: number }> = [];
    let retiredSegments = 0, retiredSnapshots = 0;
    for (let cycle = 0; cycle < 24; cycle++) {
      const now = base + cycle * PERIOD;
      processLog = await openBoundedProcessLog({ runRoot: run, generation: randomUUID(), nowMs: now, policy });
      expect(await processLog.append({ event: "ready", atMs: now })).toBe("written");
      for (const sourceRoot of roots) {
        const sourceKey = sha256Text(sourceRoot), sourceName = sourceRoot === run ? "host" : "control";
        for (let event = 0; event < 8; event++) {
          const stepId = `${sourceName}-${cycle}-${event}`;
          expect(await appendHostJournal(sourceRoot, { name: "host_stream_rejected", schemaVersion: 2,
            at: new Date(now).toISOString(), mode: "route", hostGenerationId: HOST, agentId: AGENT,
            turnId: `turn-${stepId}`, stepId, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream",
            raw: "PRIVATE_PROMPT_SOAK_SENTINEL" }, { policy, nowMs: now })).toBe("written");
        }
        for (let batchNumber = 0; batchNumber < 32; batchNumber++) {
          const cursor = cursors.get(sourceKey) ?? null, batch = await readJournalBatch(sourceRoot, cursor);
          for (const event of batch.events) {
            const step = (event as { stepId?: string }).stepId;
            if (step) { expect(seenSteps.has(step)).toBe(false); seenSteps.add(step); }
          }
          const next = batch.nextCursor ?? "null";
          const ingested = await store.ingestEvidence({ epoch, sourceKey, expectedCursor: cursor, nextCursor: next,
            atMs: now, events: batch.events, gap: batch.gap, notifications: "off" });
          expect(ingested.storagePressure).toBe(false);
          cursors.set(sourceKey, next);
          if (!batch.hasMore) break;
          if (batchNumber === 31) throw Error("soak_drain_not_settled");
        }
      }
      if (cycle === 0) {
        const id = (await store.incidents())[0]!.id;
        const lease = await store.evidenceLease({ incidentId: id, revision: 1, nowMs: now, durationMs: 3 * PERIOD });
        retained = { id, expiresAt: lease.reservedUntil, value: await store.incidentEvidence(id, 1) };
      }
      const maintenance = await store.maintain(now);
      retiredSnapshots += maintenance.retention.expiredSnapshots;
      if (retained && now < retained.expiresAt) expect(await store.incidentEvidence(retained.id, 1)).toEqual(retained.value);
      await processLog.maintain(now);
      await processLog.close(); processLog = undefined;
      const logs = await observeProcessLogStorage(run);
      expect(logs.state).toBe("available"); expect(logs.bytes).toBeLessThanOrEqual(LOG_BYTES);
      let journalBytes = 0;
      for (const sourceRoot of roots) {
        const segments = await inspectJournalSegments(sourceRoot);
        const bytes = segments.mode === "legacy" ? (await stat(join(sourceRoot, "log/events.ndjson"))).size
          : segments.entries.reduce((sum, entry) => sum + entry.bytes, 0);
        journalBytes += bytes;
        expect(bytes).toBeLessThanOrEqual(LOG_BYTES);
        retiredSegments = Math.max(retiredSegments, segments.retiredSegments);
      }
      const database = (await stat(store.path)).size;
      expect(database).toBeLessThanOrEqual(DB_BYTES);
      const db = await openMonitorSqlite(store.path, "read");
      let snapshots: number;
      try {
        snapshots = Number((await db.first("SELECT COUNT(*) AS n FROM incident_snapshots"))!.n);
        expect(Number((await db.first("SELECT COUNT(*) AS n FROM notification_work"))!.n)).toBe(0);
        expect(Number((await db.first("SELECT COUNT(*) AS n FROM evidence_leases"))!.n)).toBeLessThanOrEqual(1);
      } finally { await db.close(); }
      const footprint = await observeDiagnosticFootprint({ durableRoot: root, runRoot: run });
      expect(footprint.state).toBe("measured");
      expect(footprint.installationBudgetEnforced).toBe(false);
      samples.push({ database, journal: journalBytes, process: logs.bytes, snapshots, total: footprint.fileBytes });
      expect(await readFile(protectedPath, "utf8")).toBe(userBytes);
      expect((await store.snapshot(now)).collectorRecordedRunning).toBe(true);
    }
    expect(seenSteps.size).toBe(24 * 2 * 8);
    expect(retiredSegments).toBeGreaterThan(0); expect(retiredSnapshots).toBeGreaterThan(0);
    // The 3-minute summary window has at most three cycles plus one conservative
    // transition cycle; this assertion is independent of physical allocation.
    for (const sample of samples.slice(6)) expect(sample.snapshots).toBeLessThanOrEqual(4 * 16);
    const stable = samples.slice(12).map(sample => sample.total);
    expect(Math.max(...stable) - Math.min(...stable)).toBeLessThanOrEqual(256 * 1024);
    expect(await readdir(root)).toContain("user-export.json");
    await store.finish(epoch, base + 24 * PERIOD);
    const before = await readFile(store.path);
    await store.storageHealth(); await store.snapshot(base + 24 * PERIOD);
    expect(await readFile(store.path)).toEqual(before);
  } finally { await processLog?.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);

test("default-budget writer smoke uses the production allocation and remains separate from installation-wide reservation proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "observation-default-budget-"));
  try {
    const policy = effectiveStorage();
    const store = openMonitorStore(root); await store.initialize();
    const health = await store.storageHealth();
    expect(health.growthGuard.maxDatabaseBytes).toBe(policy.retention.monitor.maxBytes);
    expect(health.fileBytes).toBeLessThanOrEqual(policy.retention.monitor.maxBytes);
    expect(health.installationBudgetEnforced).toBe(false);
    const writer = await openBoundedProcessLog({ runRoot: root, generation: randomUUID(), nowMs: Date.now() });
    try { expect(await writer.append({ event: "ready", atMs: Date.now() })).toBe("written"); }
    finally { await writer.close(); }
    expect((await observeProcessLogStorage(root)).bytes).toBeLessThanOrEqual(policy.retention.process.maxBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
