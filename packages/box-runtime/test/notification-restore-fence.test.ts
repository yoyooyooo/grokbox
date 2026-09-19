import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createNoticeReplayFence, projectNoticeWorker } from "@grokbox/runtime-kernel/observation";
import { automaticNoticeCycle, startOpsNotificationWorker } from "../src/internal/roots/ops-automatic-notification.runtime.ts";
import { automaticFixture, tick } from "./fixtures/automatic-notice.ts";

async function until<T>(read: () => Promise<T>, check: (v: T) => boolean) {
  const deadline = performance.now() + 5000;
  do { const value = await read(); if (check(value)) return value; await tick(5); } while (performance.now() < deadline);
  throw Error("owned_restore_fence_deadline");
}

test("a same-process database rollback cannot repeat an already accepted notification", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const fence = createNoticeReplayFence(Date.now()); await tick();
    const id = await f.emit(), backup = await readFile(f.store.path);
    const input = { ...f.input, replayFence: fence };
    expect(await automaticNoticeCycle(input, { request: f.request })).toMatchObject({ state: "processed", workId: id, outcome: "native-accepted" });
    expect(f.requests).toHaveLength(2);
    // The copied DB really predates the native effect: its durable attempt is
    // absent after restoration. No mocks replace SQLite or the HTTP transport.
    await writeFile(f.store.path, backup);
    expect(await f.store.notificationDelivery(id)).toMatchObject({ attempt: null });
    const reads = f.reads();
    expect(await automaticNoticeCycle(input, { request: f.request })).toMatchObject({ state: "blocked", reason: "prior_lifetime_attempt" });
    expect(f.requests).toHaveLength(2); expect(f.reads()).toBe(reads);
    expect(await f.store.notificationDelivery(id)).toMatchObject({ state: "unknown", attempt: null });
    await tick(); const fresh = await f.emit();
    expect(await automaticNoticeCycle(input, { request: f.request })).toMatchObject({ state: "processed", workId: fresh, outcome: "native-accepted" });
    expect(f.requests).toHaveLength(3);
  } finally { await f.close(); }
});

test("a new worker after restoring a pre-send backup leaves old work for explicit reconciliation", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const oldWork = await f.emit(), backup = await readFile(f.store.path);
    expect((await automaticNoticeCycle(f.input, { request: f.request })).state).toBe("processed");
    await writeFile(f.store.path, backup); await tick();
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => worker!.status(), s => s.cycles > 1);
    expect(await f.store.notificationDelivery(oldWork)).toMatchObject({ attempt: null });
    expect(f.requests).toHaveLength(2);
    expect(projectNoticeWorker(worker.status()).replayFence).toMatchObject({ restoresExistingWork: false, scope: "automatic_notifications_only" });
    await tick(); const freshWork = await f.emit();
    await until(() => f.store.notificationDelivery(freshWork), s => s.state === "completed");
    expect(f.requests).toHaveLength(3);
  } finally { await worker?.close(); await f.close(); }
});

test("unknown HTTP remains fenced after its attempt is lost from a restored database", async () => {
  const f = await automaticFixture();
  try {
    const seed = await f.seed(); await f.activate(seed.workId);
    const fence = createNoticeReplayFence(Date.now()); await tick();
    await f.emit(); const backup = await readFile(f.store.path);
    f.reply(res => res.destroy());
    expect(await automaticNoticeCycle({ ...f.input, replayFence: fence }, { request: f.request })).toMatchObject({ state: "processed", outcome: "unknown" });
    await writeFile(f.store.path, backup);
    expect(await automaticNoticeCycle({ ...f.input, replayFence: fence }, { request: f.request })).toMatchObject({ state: "blocked", reason: "prior_lifetime_attempt" });
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
});

test("new work IDs for the same occurrence do not bypass the live fence", () => {
  const fence = createNoticeReplayFence(1000, 2), identity = "a".repeat(64);
  const request = { workId: randomUUID(), occurrenceIdentity: identity, occurrenceAtMs: 1001, createdAtMs: 1002, expiresAtMs: 2000, nowMs: 1003 };
  expect(fence.claim(request)).toBeNull();
  expect(fence.claim({ ...request, workId: randomUUID() })).toBe("prior_lifetime_attempt");
});

test("finite fence retires expired guards, continues new work and rejects clock rollback", () => {
  const fence = createNoticeReplayFence(1000, 2);
  for (let i = 0; i < 30; i++) {
    const now = 2000 + i * 1_000_000;
    expect(fence.claim({ workId: randomUUID(), occurrenceIdentity: i.toString(16).padStart(64, "0"),
      createdAtMs: now, occurrenceAtMs: now, nowMs: now, expiresAtMs: now + 50 })).toBeNull();
    expect(fence.status().guardedWork).toBe(1);
  }
  expect(fence.check(2000)).toBe("replay_clock_reversed");
  expect(fence.status().guardedWork).toBe(1);
});

test("reindexing an expired occurrence with a new work ID and expiry never reopens delivery", () => {
  const fence = createNoticeReplayFence(1000);
  const input = { workId: randomUUID(), occurrenceIdentity: "1".repeat(64), createdAtMs: 1002, occurrenceAtMs: 1001, expiresAtMs: 2000, nowMs: 1003 };
  expect(fence.claim(input)).toBeNull();
  expect(fence.check(1_000_000)).toBeNull();
  expect(fence.status().guardedWork).toBe(0);
  expect(fence.claim({ ...input, workId: randomUUID(), createdAtMs: 1_000_000, nowMs: 1_000_000, expiresAtMs: 2_000_000 })).toBe("replay_window_unavailable");
});

test("fence saturation refuses new effects rather than forgetting unknown attempts", () => {
  const fence = createNoticeReplayFence(1000, 1);
  const input = { workId: randomUUID(), occurrenceIdentity: "1".repeat(64), createdAtMs: 1001, occurrenceAtMs: 1001, expiresAtMs: 9000, nowMs: 1002 };
  expect(fence.claim(input)).toBeNull();
  expect(fence.claim({ ...input, workId: randomUUID(), occurrenceIdentity: "2".repeat(64) })).toBe("replay_fence_capacity");
  expect(fence.status().guardedWork).toBe(1);
});
