import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, configurationRevisions, validateConfig } from "@grokbox/runtime-kernel/config";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { modeldStorageMaintenance } from "../src/internal/roots/storage-lifetime.runtime.ts";
import { maintainObservationStorage } from "../src/internal/io/storage-maintenance.node.ts";
import { createStorageMaintenanceRecorder, observeStorageMaintenance } from "../src/internal/io/storage-maintenance-receipt.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { readStorageConfiguration } from "../src/internal/io/storage-configuration.node.ts";
import { openBoundedProcessLog, observeProcessLogStorage } from "../src/internal/io/bounded-process-log.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";
import { launchPackedRuntime, processDeadline, closePackedRuntime } from "./fixtures/packed-runtime-process.ts";

const DAY = 86400000, AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, predicate: (v: T) => boolean, budget = 3000): Promise<T> {
  const deadline = performance.now() + budget;
  do { const value = await read(); if (predicate(value)) return value; await delay(10); } while (performance.now() < deadline);
  throw new Error("owned_maintenance_deadline");
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "storage-lifetime-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const doc = validateConfig({ ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" } },
    storage: { diagnostics: { detailDays: 1, summaryDays: 3 } } });
  const config = join(root, "config.json"), receipt = join(run, "log/storage-maintenance.json");
  await writeFile(config, JSON.stringify(doc), { mode: 0o600 });
  const input = { durableRoot: root, runRoot: run };
  return { directory, root, run, config, doc, receipt, input, close: () => rm(directory, { recursive: true, force: true }) };
}
async function expiredEvidence(f: Awaited<ReturnType<typeof fixture>>) {
  const policy = await readStorageConfiguration(f.root), store = openMonitorStore(f.root, policy.monitor), epoch = randomUUID(), at = Date.now() - 2 * DAY;
  await store.initialize(); await store.begin(epoch, at, [AGENT]);
  const event = { name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route", hostGenerationId: "b".repeat(64),
    agentId: AGENT, turnId: "expired-turn", stepId: "expired-step", stage: "normalize", reason: "invalid-stream", errorCode: "invalid_stream" };
  await store.ingestEvidence({ epoch, sourceKey: "c".repeat(64), expectedCursor: null, nextCursor: "once", events: [event], atMs: at });
  const id = (await store.incidents())[0]!.id; await store.finish(epoch, at + 1);
  return { store, id };
}

test("actual modeld runs maintenance without a collector or enabled notifications; borrower cannot restart it", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    const { store, id } = await expiredEvidence(f), config = await readFile(f.config);
    owner = await startModeldProcess({ ...f.input, env: {} });
    const witness = await until(() => observeStorageMaintenance(f.input), v => v.state === "running");
    expect(witness).toMatchObject({ source: "modeld-owned-housekeeping", sequence: 1,
      lastCycle: { policyRevision: configurationRevisions(f.doc).storage, monitor: { state: "maintained", expiredSnapshots: 1 } }, installationBudgetEnforced: false });
    expect(await store.incidentEvidence(id, 1)).toMatchObject({ state: "expired", retention: { tier: "summary" } });
    const before = await readFile(f.receipt);
    const borrowed = await startModeldProcess({ ...f.input, env: {} });
    expect(borrowed.ensure.kind).toBe("borrowed"); await borrowed.stop();
    expect(await readFile(f.receipt)).toEqual(before);
    await owner.stop(); owner = undefined;
    expect(await observeStorageMaintenance(f.input)).toMatchObject({ state: "stopped", sequence: 1 });
    const stopped = await readFile(f.receipt); await delay(40); expect(await readFile(f.receipt)).toEqual(stopped);
    expect(await readFile(f.config)).toEqual(config);
  } finally { await owner?.stop(); await f.close(); }
}, 10000);

test("missing stores stay missing while housekeeping and read-only status report the uninitialized scope", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    owner = await startModeldProcess({ ...f.input, env: {} });
    await until(() => observeStorageMaintenance(f.input), v => v.state === "running");
    const before = await readFile(f.receipt);
    expect(await observeRuntimeStorage(f.input)).toMatchObject({ state: "not_initialized", maintenance: { state: "running", lastCycle: { monitor: { state: "not_initialized" } } } });
    expect(await readdir(f.root)).toEqual(["config.json"]);
    expect(await readFile(f.receipt)).toEqual(before);
    expect(await readdir(join(f.run, "log"))).not.toContain("storage-maintenance.next.json");
  } finally { await owner?.stop(); await f.close(); }
});

test("broken canonical config preserves data and does not prevent service ownership or start default GC", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    const { store } = await expiredEvidence(f), before = await readFile(store.path);
    await writeFile(f.config, "{PRIVATE_BROKEN_CONFIG", { mode: 0o600 });
    owner = await startModeldProcess({ ...f.input, env: {} }); expect(owner.ensure.kind).toBe("owned");
    const witness = await until(() => observeStorageMaintenance(f.input), v => v.state === "running");
    expect(witness).toMatchObject({ lastCycle: { state: "configuration_unavailable", monitor: { state: "not_checked" } } });
    expect(await readFile(store.path)).toEqual(before);
    expect(await readFile(f.receipt, "utf8")).not.toContain("PRIVATE_BROKEN_CONFIG");
  } finally { await owner?.stop(); await f.close(); }
});

test("idle cleanup uses the held writer and never removes or reopens its active segment", async () => {
  const f = await fixture();
  const policy = { segmentBytes: 2048, maxBytes: 8192, maxAgeMs: 60000 }, now = Date.now();
  let writer: Awaited<ReturnType<typeof openBoundedProcessLog>> | undefined;
  try {
    writer = await openBoundedProcessLog({ runRoot: f.run, generation: randomUUID(), nowMs: now - 50000, policy });
    await writer.append({ event: "ready", atMs: now - 50000 }); await writer.close();
    writer = await openBoundedProcessLog({ runRoot: f.run, generation: randomUUID(), nowMs: now, policy });
    await writer.append({ event: "ready", atMs: now });
    const names = await readdir(join(f.run, "log/process")); expect(names).toHaveLength(2);
    const active = join(f.run, "log/process", names[1]!), identity = await stat(active), bytes = await readFile(active);
    const cleaned = await writer.maintain(now + 20000); expect(cleaned.state).toBe("maintained"); expect(cleaned.reclaimedBytes).toBeGreaterThan(0);
    expect((await observeProcessLogStorage(f.run)).segments).toHaveLength(1);
    expect((await stat(active)).ino).toBe(identity.ino); expect(await readFile(active)).toEqual(bytes);
    expect(await writer.append({ event: "shutdown_requested", atMs: now + 20001 })).toBe("written");
  } finally { await writer?.close(); await f.close(); }
});

test("maintenance does not repair an unsafe receipt path and source failures remain independent", async () => {
  const f = await fixture(); let owner: Awaited<ReturnType<typeof startModeldProcess>> | undefined;
  try {
    await mkdir(join(f.run, "log"), { mode: 0o700 });
    const victim = join(f.directory, "user.txt"); await writeFile(victim, "KEEP_USER_BYTES", { mode: 0o600 }); await symlink(victim, f.receipt);
    owner = await startModeldProcess({ ...f.input, env: {} }); expect(owner.ensure.kind).toBe("owned");
    await delay(60); expect(await observeStorageMaintenance(f.input)).toMatchObject({ state: "unavailable" });
    await owner.stop(); owner = undefined;
    expect(await readFile(victim, "utf8")).toBe("KEEP_USER_BYTES");
  } finally { await owner?.stop(); await f.close(); }
});

test("one scheduled pass must settle before interruption and recorder close; no overlapping or late write", async () => {
  const f = await fixture();
  try {
    let begun!: () => void, finish!: () => void;
    const started = new Promise<void>(r => begun = r), release = new Promise<void>(r => finish = r), actions: string[] = [];
    let active = 0, peak = 0;
    const fiber = Effect.runFork(modeldStorageMaintenance({ ...f.input, serviceEpoch: randomUUID() }, {
      intervalMs: 1, recorder: async () => ({ record: async () => { actions.push("record"); }, stop: async () => { actions.push("stop"); } }),
      cycle: async () => { active++; peak = Math.max(peak, active); actions.push("begin"); begun(); await release;
        const result = await maintainObservationStorage(f.input); actions.push("settled"); active--; return result; },
    }));
    await started;
    let stopped = false; const shutdown = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { stopped = true; });
    await delay(30); expect(stopped).toBe(false); expect(actions).toEqual(["begin"]);
    finish(); await shutdown;
    expect(peak).toBe(1); expect(actions).toEqual(["begin", "settled", "record", "stop"]);
    await delay(10); expect(active).toBe(0); expect(actions).toHaveLength(4);
  } finally { await f.close(); }
});

test("failed pass and failed publication do not end future maintenance or create a fast retry loop", async () => {
  const f = await fixture();
  try {
    const signal = new AbortController(), times: number[] = []; let closed = 0;
    const lifetime = Effect.runPromiseExit(modeldStorageMaintenance({ ...f.input, serviceEpoch: randomUUID() }, {
      intervalMs: 10, recorder: async () => ({ record: async () => { throw Error("PRIVATE_SINK_ERROR"); }, stop: async () => { closed++; } }),
      cycle: async () => { times.push(performance.now()); if (times.length === 1) throw Error("PRIVATE_GC_ERROR"); return maintainObservationStorage(f.input); },
    }), { signal: signal.signal });
    try { await until(async () => times.length, n => n >= 3); } finally { signal.abort(); await lifetime; }
    expect(closed).toBe(1); expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(8); expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(8);
  } finally { await f.close(); }
});

test("receipt volume is fixed and stale/foreign observations cannot become a successful applied claim", async () => {
  const f = await fixture();
  try {
    const writer = await createStorageMaintenanceRecorder({ ...f.input, serviceEpoch: randomUUID() });
    const result = await maintainObservationStorage(f.input);
    for (let n = 0; n < 30; n++) await writer.record(result);
    const before = await readFile(f.receipt); expect(before.length).toBeLessThan(16 * 1024);
    expect(await readdir(join(f.run, "log"))).toEqual(["storage-maintenance.json"]);
    expect(await observeStorageMaintenance({ ...f.input, nowMs: Date.now() + 90000 })).toMatchObject({ state: "stale", sequence: 30 });
    expect(await observeStorageMaintenance({ durableRoot: join(f.directory, "foreign"), runRoot: f.run })).toMatchObject({ state: "unavailable" });
    expect(await readFile(f.receipt)).toEqual(before); await writer.stop();
    expect(await observeStorageMaintenance(f.input)).toMatchObject({ state: "stopped", installationBudgetEnforced: false });
  } finally { await f.close(); }
});

test("packed Node owner publishes housekeeping, and SIGKILL is observed as interrupted without reader repair", async () => {
  const f = await fixture(); const process = launchPackedRuntime(f.directory, ["modeld", "run"], f.root);
  try {
    await processDeadline(process.ready);
    await until(() => observeStorageMaintenance(f.input), v => v.state === "running");
    process.child.kill("SIGKILL"); await processDeadline(process.exit);
    const before = await readFile(f.receipt);
    expect(await observeStorageMaintenance(f.input)).toMatchObject({ state: "interrupted", ownerIdentity: "absent" });
    expect(await readFile(f.receipt)).toEqual(before);
  } finally { await closePackedRuntime(process); await f.close(); }
}, 10000);
