import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNdjsonLine } from "../src/internal/host/terminal-journal.node.ts";
import { inspectJournalSegments, type RotationStage } from "../src/internal/host/journal-segments.node.ts";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";
import { observeEvents, compactEvents } from "../src/internal/io/journal.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST = "b".repeat(64), NOW = Date.now();
const policy = { segmentBytes: 2048, maxBytes: 16 * 1024, maxAgeMs: 3 * 86_400_000 };
const event = (n: number) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date(NOW).toISOString(), mode: "route", hostGenerationId: HOST,
  agentId: AGENT, turnId: `turn-${n}`, stepId: `step-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "journal-segments-"));
  const path = join(root, "log/events.ndjson");
  const append = (n: number, afterStage?: (stage: RotationStage) => void, cap = policy.maxBytes) => appendNdjsonLine(root, JSON.stringify(event(n)), "host", { policy: { ...policy, maxBytes: cap }, nowMs: NOW, afterStage });
  return { root, path, append, close: () => rm(root, { recursive: true, force: true }) };
}
async function drain(root: string, start: string | null = null) {
  let cursor = start; const events: unknown[] = [], gaps: string[] = [];
  for (let n = 0; n < 200; n++) {
    const batch = await readJournalBatch(root, cursor); cursor = batch.nextCursor;
    events.push(...batch.events); if (batch.gap) gaps.push(batch.gap);
    if (!batch.hasMore) return { events, gaps, cursor };
  }
  throw Error("fixture_drain_did_not_settle");
}
const steps = (events: unknown[]) => events.map(e => (e as { stepId?: string }).stepId).filter(Boolean);
async function snapshotFiles(root: string) {
  const names = (await readdir(join(root, "log"))).sort();
  return Promise.all(names.map(async name => [name, await readFile(join(root, "log", name))]));
}

test("legacy byte cursor follows its inode into a sealed segment without replay or missing records", async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 3; i++) await f.append(i);
    const first = await drain(f.root); expect(steps(first.events)).toEqual(["step-0", "step-1", "step-2"]);
    expect(JSON.parse(first.cursor!).version).toBe(1);
    for (let i = 3; i < 25; i++) await f.append(i);
    const remaining = await drain(f.root, first.cursor);
    expect(steps(remaining.events)).toEqual(Array.from({ length: 22 }, (_, i) => `step-${i + 3}`));
    expect(remaining.gaps).toEqual([]); expect(JSON.parse(remaining.cursor!).version).toBe(2);
    expect((await drain(f.root, remaining.cursor)).events).toEqual([]);
    const before = await snapshotFiles(f.root);
    const query = await observeEvents(f.root, 4096, { agentId: AGENT, stepId: "step-0" });
    expect(query.events.some(e => "stepId" in e && e.stepId === "step-0")).toBe(true);
    expect(query.coverage?.segmentCoverage?.segments.length).toBeGreaterThan(1);
    expect(await snapshotFiles(f.root)).toEqual(before);
    await compactEvents(f.root);
    expect(steps((await drain(f.root)).events)).toEqual(Array.from({ length: 25 }, (_, i) => `step-${i}`));
  } finally { await f.close(); }
});

test("competing append callers share one rotation identity and never lose a successfully written record", async () => {
  const f = await fixture(); try {
    await Promise.all(Array.from({ length: 30 }, (_, i) => f.append(i)));
    const result = await drain(f.root);
    expect(new Set(steps(result.events))).toEqual(new Set(Array.from({ length: 30 }, (_, i) => `step-${i}`)));
    expect(result.events).toHaveLength(30); expect(result.gaps).toEqual([]);
    expect((await inspectJournalSegments(f.root)).pending).toBe(false);
  } finally { await f.close(); }
});

test("capacity retires only owned closed segments and a lagged cursor reports the actual loss", async () => {
  const f = await fixture(); try {
    await f.append(0); const first = await drain(f.root);
    for (let i = 1; i < 150; i++) {
      await f.append(i, undefined, 8192);
      const inventory = await inspectJournalSegments(f.root);
      const bytes = inventory.mode === "segmented" ? inventory.entries.reduce((n, s) => n + s.bytes, 0) : (await stat(f.path)).size;
      expect(bytes).toBeLessThanOrEqual(8192);
    }
    const inventory = await inspectJournalSegments(f.root);
    expect(inventory.retiredSegments).toBeGreaterThan(0); expect(inventory.retiredBytes).toBeGreaterThan(0);
    const lost = await drain(f.root, first.cursor);
    expect(lost.gaps.join(",")).toContain("retired_segment"); expect(steps(lost.events)).toContain("step-149");
    expect(new Set(steps(lost.events)).size).toBe(steps(lost.events).length);
    for (let i = 150; i < 200; i++) await f.append(i, undefined, 8192);
    const secondLoss = await drain(f.root, lost.cursor);
    expect(secondLoss.gaps.join(",")).toContain("retired_segment");
    expect(steps(secondLoss.events)).toContain("step-199");
    expect(steps(secondLoss.events).some(step => steps(lost.events).includes(step))).toBe(false);
    const query = await observeEvents(f.root, 4096, { agentId: AGENT, stepId: "step-0" });
    expect(query.events.some(e => "stepId" in e && e.stepId === "step-0")).toBe(false);
    expect(query.coverage?.prefixOmitted).toBe(true);
    expect(query.coverage?.segmentCoverage?.retiredSegments).toBeGreaterThan(0);
  } finally { await f.close(); }
});

for (const failureStage of ["intent", "renamed", "created", "committed"] as const) {
  test(`rotation interruption after ${failureStage} resumes the protocol without replaying the uncommitted append`, async () => {
    const f = await fixture(); try {
      let n = 0; await f.append(n++);
      while ((await stat(f.path)).size + Buffer.byteLength(JSON.stringify(event(999)) + "\n") <= policy.segmentBytes) await f.append(n++);
      let hit = false;
      await expect(f.append(999, stage => { if (stage === failureStage) { hit = true; throw Error("owned_interruption"); } })).rejects.toThrow("owned_interruption");
      expect(hit).toBe(true);
      // GET during an interrupted rotation cannot perform recovery writes.
      const before = await snapshotFiles(f.root);
      if (failureStage !== "committed") {
        const pending = await readJournalBatch(f.root, null);
        expect(pending).toMatchObject({ events: [], nextCursor: null, deferred: "rotation_in_progress" });
        expect(pending.gap).toBeUndefined();
      }
      await drain(f.root); expect(await snapshotFiles(f.root)).toEqual(before);
      await f.append(1000);
      const all = await drain(f.root);
      expect(steps(all.events)).toEqual([...Array.from({ length: n }, (_, i) => `step-${i}`), "step-1000"]);
      expect((await inspectJournalSegments(f.root)).pending).toBe(false);
    } finally { await f.close(); }
  });
}

test("a crashed partial tail is sealed, disclosed and never joined to the next complete event", async () => {
  const f = await fixture(); try {
    await f.append(0); const old = await drain(f.root);
    await appendFile(f.path, '{"incomplete":');
    await f.append(1);
    const result = await drain(f.root, old.cursor);
    expect(steps(result.events)).toEqual(["step-1"]); expect(result.gaps.join(",")).toContain("sealed_partial_line");
    expect((await inspectJournalSegments(f.root)).entries[0]?.sealed).toBe(true);
  } finally { await f.close(); }
});

test("a fixed monitor revision survives source segment eviction and new-process-style cursor reopening", async () => {
  const f = await fixture(); try {
    const root = join(f.root, "durable"), store = openMonitorStore(root), epoch = randomUUID();
    await store.initialize(); await store.begin(epoch, NOW, [AGENT]);
    await f.append(0); const first = await readJournalBatch(f.root, null);
    await store.ingestEvidence({ epoch, sourceKey: "c".repeat(64), expectedCursor: null, nextCursor: first.nextCursor!, events: first.events, atMs: NOW });
    const id = (await store.incidents())[0]!.id, fixed = await store.incidentEvidence(id, 1);
    for (let i = 1; i < 80; i++) await f.append(i, undefined, 8192);
    expect((await inspectJournalSegments(f.root)).retiredSegments).toBeGreaterThan(0);
    expect(await openMonitorStore(root).incidentEvidence(id, 1)).toEqual(fixed);
    await store.finish(epoch, NOW + 1);
  } finally { await f.close(); }
});

test("retirement interruption is resumed before new data is admitted and cannot replay the failed append", async () => {
  const f = await fixture(); try {
    let failedAt = -1;
    for (let i = 0; i < 100; i++) {
      try { await f.append(i, stage => { if (stage === "retired") throw Error("owned_retirement_interruption"); }, 8192); }
      catch (e) { expect(String(e)).toContain("owned_retirement_interruption"); failedAt = i; break; }
    }
    expect(failedAt).toBeGreaterThan(0);
    const before = await snapshotFiles(f.root); await drain(f.root); expect(await snapshotFiles(f.root)).toEqual(before);
    await f.append(1000, undefined, 8192);
    const result = await drain(f.root); expect(steps(result.events)).not.toContain(`step-${failedAt}`); expect(steps(result.events)).toContain("step-1000");
    const inventory = await inspectJournalSegments(f.root); expect(inventory.pending).toBe(false);
    expect(inventory.entries.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(8192);
  } finally { await f.close(); }
});

test("actual packed Node incident reads a retained closed segment and leaves the journal unchanged", async () => {
  const f = await fixture(); try {
    for (let i = 0; i < 25; i++) await f.append(i);
    const before = await snapshotFiles(f.root);
    const child = spawn("node", [ensurePackedCli(), "runtime", "incident", "step-0", "--agent", AGENT, "--json"], {
      cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, GROKBOX_CONFIG_DIR: join(f.root, "config"),
        GROKBOX_BOX_RUNTIME_ROOT: join(f.root, "durable"), GROKBOX_RUN_ROOT: f.root }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    let stdout = "", stderr = ""; child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout).data; expect(stdout).toContain("step-0"); expect(result.evidence.runtimeCoverage.segmentCoverage.segments.length).toBeGreaterThan(1);
    expect(await snapshotFiles(f.root)).toEqual(before);
  } finally { await f.close(); }
}, 15000);

test("manifest and directory symlinks cannot redirect writes or cleanup to user data", async () => {
  const f = await fixture(); const victim = await mkdtemp(join(tmpdir(), "journal-victim-"));
  try {
    const target = join(victim, "private.txt"); await writeFile(target, "USER_DATA");
    await mkdir(join(f.root, "log")); await symlink(target, join(f.root, "log/events.segments.json"));
    await expect(f.append(0)).rejects.toBeDefined(); expect(await readFile(target, "utf8")).toBe("USER_DATA");
    expect((await readJournalBatch(f.root, null)).gap).toBe("segment_index_unavailable");
    await rm(join(f.root, "log"), { recursive: true }); await symlink(victim, join(f.root, "log"));
    await expect(f.append(0)).rejects.toBeDefined(); expect(await readdir(victim)).toEqual(["private.txt"]);
  } finally { await f.close(); await rm(victim, { recursive: true, force: true }); }
});
