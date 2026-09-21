import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNdjsonLine, settleJournalWrites, withEventsLock } from "../src/internal/host/terminal-journal.node.ts";
import { currentJournalWriterHealth } from "../src/internal/host/journal-health.node.ts";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };

test("retiring a root joins its pending original journal and health writes, not just business completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "journal-settle-")), entered = deferred(), release = deferred();
  const blocker = withEventsLock(root, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const write = appendNdjsonLine(root, '{"owned":true}', "host");
  let done = false; const closing = settleJournalWrites(root).then(() => { done = true; });
  try {
    await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false);
    expect(currentJournalWriterHealth(root, "host").pending).toBe(1);
    release.resolve(); await blocker; await closing; await write;
    expect(currentJournalWriterHealth(root, "host")).toMatchObject({ pending: 0, written: 1, failed: 0 });
    expect(await readFile(join(root, "log/events.ndjson"), "utf8")).toContain('{"owned":true}');
    // No retry/deletion loop is needed after all original IO has actually ended.
    await rm(root, { recursive: true });
    await settleJournalWrites(root);
  } finally { release.resolve(); await blocker; await write.catch(() => undefined); await closing; await rm(root, { recursive: true, force: true }); }
});

test("one root's settlement neither waits for a different root nor hides its append failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "journal-settle-fault-")), other = await mkdtemp(join(tmpdir(), "journal-settle-other-"));
  const entered = deferred(), release = deferred();
  const blocker = withEventsLock(other, async () => { entered.resolve(); await release.promise; });
  await entered.promise; const pending = appendNdjsonLine(other, "{}", "host");
  try {
    await mkdir(join(root, "target")); await symlink(join(root, "target"), join(root, "log"));
    const rejected = appendNdjsonLine(root, "{}", "host"); void rejected.catch(() => undefined);
    await settleJournalWrites(root); await expect(rejected).rejects.toThrow();
    expect(currentJournalWriterHealth(root, "host")).toMatchObject({ pending: 0, written: 0, failed: 1 });
    expect(currentJournalWriterHealth(other, "host").pending).toBe(1);
  } finally { release.resolve(); await blocker; await pending; await settleJournalWrites(other); await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
