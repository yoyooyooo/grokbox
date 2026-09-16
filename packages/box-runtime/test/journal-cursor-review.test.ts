import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournalBatch } from "../src/internal/io/journal-cursor.node.ts";

const event = (sequence: number) => ({ name: "host_alert_observation", schemaVersion: 1, kind: "observer_started", eventId: `event-${sequence}`, sourceInstanceId: "source-a", sourceSequence: sequence, hostGenerationId: "host-a", at: "2026-09-16T00:00:00.000Z", observedAt: "2026-09-16T00:00:00.000Z" });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "journal-cursor-review-")); await mkdir(join(root, "log")); return { root, path: join(root, "log/events.ndjson"), close: () => rm(root, { recursive: true, force: true }) }; }

test("an unavailable initial source never poisons a later valid cursor", async () => {
  const f = await fixture();
  try {
    const absent = await readJournalBatch(f.root, null);
    expect(absent.gap).toBe("missing");
    await writeFile(f.path, JSON.stringify(event(0)) + "\n");
    // This is the exact checkpoint representation used by the collector when
    // no inode/offset could yet be observed.
    const available = await readJournalBatch(f.root, absent.nextCursor ?? "null");
    expect(available.events).toHaveLength(1);
    expect(available.gap).toBeUndefined();
  } finally { await f.close(); }
});

test("a partial line is not acknowledged, and completed UTF-8 is read exactly once", async () => {
  const f = await fixture();
  try {
    const line = JSON.stringify(event(0));
    await writeFile(f.path, line.slice(0, 90));
    const first = await readJournalBatch(f.root, null);
    expect(first.events).toEqual([]);
    expect(JSON.parse(first.nextCursor!).offset).toBe(0);
    await appendFile(f.path, line.slice(90) + "\n");
    const next = await readJournalBatch(f.root, first.nextCursor);
    expect(next.events).toHaveLength(1);
    const exhausted = await readJournalBatch(f.root, next.nextCursor);
    expect(exhausted.events).toEqual([]);
  } finally { await f.close(); }
});

test("rotation discloses the gap and does not treat another file's offset as current", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify(event(0)) + "\n");
    const first = await readJournalBatch(f.root, null);
    await rename(f.path, f.path + ".old");
    await writeFile(f.path, JSON.stringify(event(1)) + "\n");
    const next = await readJournalBatch(f.root, first.nextCursor);
    expect(next.gap).toContain("rotated"); expect(next.events).toHaveLength(1);
  } finally { await f.close(); }
});

test("oversized and malformed records advance without hiding the following valid event", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, "x".repeat(300_000) + "\nnot-json\n" + JSON.stringify(event(0)) + "\n");
    let cursor: string | null = null, matches = 0, cycles = 0;
    do {
      const batch = await readJournalBatch(f.root, cursor); cursor = batch.nextCursor; matches += batch.events.length; cycles++;
      expect(batch.readBytes).toBeLessThanOrEqual(256 * 1024);
      if (!batch.hasMore) break;
    } while (cycles < 10);
    expect(matches).toBe(1); expect(cycles).toBeLessThan(10);
  } finally { await f.close(); }
});
