import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startOpsNotificationWorker } from "../src/internal/roots/ops-automatic-notification.runtime.ts";
import { automaticFixture, tick } from "./fixtures/automatic-notice.ts";

async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { if (await check()) return; await tick(5); }
  throw Error("notification_restart_deadline");
}

test("idle authorized worker leaves the pairing capsule stable for concurrent management readers", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    await f.activate(); const path = join(f.root, "state/ops-pairing/bindings.json"), before = await readFile(path);
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => worker!.status().cycles >= 3);
    expect(await readFile(path)).toEqual(before); expect(f.requests).toHaveLength(0);
  } finally { await worker?.close(); await f.close(); }
});

test("worker resumes post-consent unsent work across independent lifetimes without replaying accepted work", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    await f.activate();
    const first = await f.emit();
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => (await f.store.notificationDelivery(first)).state === "completed");
    await worker.close(); worker = undefined;
    const second = await f.emit();
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => (await f.store.notificationDelivery(second)).state === "completed");
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0]).toContain(first); expect(f.requests[1]).toContain(second);
    expect(await f.store.notificationDelivery(first)).toMatchObject({ state: "completed", botReport: "not_observed", userRead: "not_observed" });
  } finally { await worker?.close(); await f.close(); }
});

test("revocation before restarted worker prevents old pending effects", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    await f.activate(); const pending = await f.emit();
    const record = (await f.owner.record("default"))!;
    await f.owner.revoke("default", record.revision, "disable", true);
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => worker!.status().cycles >= 2);
    expect(f.requests).toHaveLength(0);
    expect(await f.store.notificationDelivery(pending)).toMatchObject({ attempt: null });
  } finally { await worker?.close(); await f.close(); }
});

test("an old capsule without a checkpoint starts a safe floor; a corrupt checkpoint never restores permission", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    await f.activate(); const pending = await f.emit();
    const path = join(f.root, "state/ops-pairing/bindings.json");
    const old = JSON.parse(await readFile(path, "utf8")); delete old.noticeReplay;
    await writeFile(path, JSON.stringify(old)); await tick();
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => worker!.status().cycles >= 2);
    expect(f.requests).toHaveLength(0); expect(await f.store.notificationDelivery(pending)).toMatchObject({ attempt: null });
    await worker.close(); worker = undefined;
    const damaged = JSON.parse(await readFile(path, "utf8")); damaged.noticeReplay.highWaterMs = 0;
    await writeFile(path, JSON.stringify(damaged)); await f.emit();
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => worker!.status().cycles >= 2);
    expect(worker.status().lastCycle?.state).toBe("unavailable"); expect(f.requests).toHaveLength(0);
  } finally { await worker?.close(); await f.close(); }
});

test("unknown dispatch survives worker restart and restored observation DB while unrelated unsent work continues", async () => {
  const f = await automaticFixture(); let worker: ReturnType<typeof startOpsNotificationWorker> | undefined;
  try {
    await f.activate(); const uncertain = await f.emit(), before = await readFile(f.store.path);
    f.reply(res => res.destroy());
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => {
      const work = await f.store.notificationDelivery(uncertain);
      return "attempt" in work && work.attempt?.result?.state === "unknown" && f.requests.length === 1;
    });
    await worker.close(); worker = undefined;
    await writeFile(f.store.path, before);
    const fresh = await f.emit(); f.reply(res => res.end("owned-receiver"));
    worker = startOpsNotificationWorker(f.input, { request: f.request, idleMs: 5, blockedMs: 10 });
    await until(async () => (await f.store.notificationDelivery(fresh)).state === "completed");
    expect(await f.store.notificationDelivery(uncertain)).toMatchObject({ state: "unknown", attempt: null });
    expect(f.requests).toHaveLength(2); expect(f.requests[1]).toContain(fresh);
  } finally { await worker?.close(); await f.close(); }
});
