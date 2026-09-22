import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNdjsonLine, settleJournalWrites, withEventsLock } from "../src/internal/host/terminal-journal.node.ts";
import { currentJournalWriterHealth } from "../src/internal/host/journal-health.node.ts";
import { waitFixtureRows } from "./provider-runtime-fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("visible terminal rows do not settle a fixture while its original journal writer is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-fixture-settlement-"));
  const stepId = "synthetic-owned-step", entered = deferred(), release = deferred(), rowsRead = deferred();
  const path = join(root, "log/events.ndjson");
  for (const name of ["host_normalized_terminal", "model_step_terminal"]) {
    await appendNdjsonLine(root, JSON.stringify({ name, stepId }), "host");
  }
  const blocker = withEventsLock(root, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const write = appendNdjsonLine(root, JSON.stringify({ name: "owned-post-terminal", stepId }), "host");
  void write.catch(() => undefined);
  let reads = 0;
  const fixture = { runRoot: root, async rows() {
    const rows = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    reads++;
    rowsRead.resolve();
    return rows;
  } };
  const waiting = waitFixtureRows(fixture, stepId);
  void waiting.catch(() => undefined);
  try {
    await rowsRead.promise;
    expect(currentJournalWriterHealth(root, "host").pending).toBe(1);
    const state = await Promise.race([
      waiting.then(() => "returned"),
      new Promise<string>(resolve => setImmediate(() => resolve("pending"))),
    ]);
    expect(state).toBe("pending");
    release.resolve(); await blocker; await write;
    const rows = await waiting;
    expect(rows.some(row => row.name === "owned-post-terminal")).toBe(true);
    expect(currentJournalWriterHealth(root, "host").pending).toBe(0);
    expect(reads).toBe(2);
  } finally {
    release.resolve();
    await blocker; await write.catch(() => undefined); await waiting.catch(() => undefined);
    await settleJournalWrites(root); await rm(root, { recursive: true, force: true });
  }
}, 10000);
