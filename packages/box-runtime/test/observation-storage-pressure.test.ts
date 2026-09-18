import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openMonitorSqlite } from "../src/internal/io/monitor-sqlite.node.ts";
import { capMonitorDatabase } from "../src/internal/io/monitor-storage.node.ts";
import { DAY_MS } from "@grokbox/runtime-kernel/observation";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", SOURCE = "c".repeat(64), HOST = "d".repeat(64);
const BASE = Date.now();
function failure(n: number, at = BASE + n) {
  return { name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route", hostGenerationId: HOST,
    agentId: AGENT, turnId: `turn-${n}`, stepId: `step-${n}`, failureId: `failure-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream",
    diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool" } };
}
async function fixture(maxDatabaseBytes = 1024 * 1024) {
  const root = await mkdtemp(join(tmpdir(), "observation-capacity-")), epoch = randomUUID();
  const store = openMonitorStore(root, { maxDatabaseBytes, retentionMs: 1000, eventTarget: 10 });
  await store.initialize(); await store.begin(epoch, BASE, [AGENT]);
  return { root, epoch, store, close: () => rm(root, { recursive: true, force: true }) };
}

test("a small diagnostic database stays bounded, commits pressure gaps, and resumes after retention without restart", async () => {
  const cap = 512 * 1024, f = await fixture(cap);
  try {
    let inserted = 0, dropped = 0;
    for (let n = 0; n < 120; n++) {
      const result = await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: n ? String(n - 1) : null,
        nextCursor: String(n), events: [failure(n)], atMs: BASE + n });
      inserted += result.inserted; dropped += result.droppedEvents;
      expect((await stat(f.store.path)).size).toBeLessThanOrEqual(cap);
    }
    expect(inserted).toBeGreaterThan(0); expect(dropped).toBeGreaterThan(0);
    expect((await f.store.evidenceCursor(SOURCE))?.cursor).toBe("119");
    const health = await f.store.storageHealth();
    expect(health.health?.pressure_state).toBe("storage_pressure"); expect(health.health?.dropped_events).toBe(dropped);
    const retry = await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: "118", nextCursor: "119", events: [failure(119)], atMs: BASE + 119 });
    expect(retry.duplicate).toBe(true); expect((await f.store.storageHealth()).health?.dropped_events).toBe(dropped);
    // Progress the injected wall clock in trusted-size increments, rather than
    // bypassing the forward-jump protection with a single multi-month jump.
    for (let day = 1; day <= 32; day++) await f.store.maintain(BASE + day * DAY_MS);
    const result = await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: "119", nextCursor: "fresh",
      events: [failure(1000, BASE + 32 * DAY_MS + 1)], atMs: BASE + 32 * DAY_MS + 1 });
    expect(result.inserted).toBe(1); expect(result.droppedEvents).toBe(0);
    expect((await f.store.snapshot()).collectorRecordedRunning).toBe(true);
    expect((await stat(f.store.path)).size).toBeLessThanOrEqual(cap);
  } finally { await f.close(); }
}, 15_000);

test("the SQLite file cap refuses physical growth, not merely a row-count target", async () => {
  const cap = 512 * 1024, f = await fixture(cap);
  try {
    const db = await openMonitorSqlite(f.store.path, "write");
    try {
      expect(await capMonitorDatabase(db, cap)).toMatchObject({ requestedBytes: cap, effectiveBytes: cap, existingOversize: false });
      await db.run("CREATE TABLE owned_pressure_fixture(payload BLOB)");
      await expect(db.run("INSERT INTO owned_pressure_fixture VALUES(zeroblob(1048576))")).rejects.toMatchObject({ code: "SQLITE_FULL" });
    } finally { await db.close(); }
    expect((await stat(f.store.path)).size).toBeLessThanOrEqual(cap);
    expect((await f.store.snapshot()).collectorRecordedRunning).toBe(true);
  } finally { await f.close(); }
});

test("repeated protection requests reuse one reservation and cannot renew after clock reversal", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "one", events: [failure(0)], atMs: BASE });
    const incidentId = (await f.store.incidents())[0]!.id;
    const first = await f.store.evidenceLease({ incidentId, revision: 1, nowMs: BASE + 1, durationMs: 5000 });
    for (let i = 2; i < 40; i++) expect((await f.store.evidenceLease({ incidentId, revision: 1, nowMs: BASE + i, durationMs: 5000 })).leaseId).toBe(first.leaseId);
    const db = await openMonitorSqlite(f.store.path, "read");
    try { expect((await db.first("SELECT COUNT(*) AS n FROM evidence_leases"))?.n).toBe(1); }
    finally { await db.close(); }
    await f.store.maintain(BASE + 100);
    const before = await readFile(f.store.path);
    await expect(f.store.evidenceLease({ incidentId, revision: 1, nowMs: BASE + 10, durationMs: 5000 })).rejects.toThrow("monitor_evidence_clock_unavailable");
    expect(await readFile(f.store.path)).toEqual(before);
  } finally { await f.close(); }
});

test("a historical journal failure can be inspected but is not turned into a fresh Bot wake", async () => {
  const f = await fixture();
  try {
    await f.store.ingestEvidence({ epoch: f.epoch, sourceKey: SOURCE, expectedCursor: null, nextCursor: "history", events: [failure(0, BASE - DAY_MS)], atMs: BASE });
    expect((await f.store.incidents()).some(i => i.rule === "execution_failure")).toBe(true);
    expect(await f.store.notificationWork()).toEqual([]);
    expect(await f.store.incidentEvidence((await f.store.incidents())[0]!.id, 1)).toMatchObject({ state: "available" });
  } finally { await f.close(); }
});
