import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig, effectiveOps, portableConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { configureMonitorService, readMonitorServiceConfiguration } from "../src/internal/io/monitor-installation.node.ts";
import { startMonitorService } from "../src/internal/roots/monitor-service.runtime.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { appendNdjsonLine } from "../src/internal/host/terminal-journal.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, maxMs = 5000): Promise<T> {
  const deadline = performance.now() + maxMs;
  do { const value = await read(); if (done(value)) return value; await delay(10); } while (performance.now() < deadline);
  throw Error("owned_monitor_test_deadline");
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "monitor-service-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const config = join(root, "config.json");
  const document = { ...defaultConfig(), ops: { notifications: { mode: "off" } } };
  await writeFile(config, JSON.stringify(document), { mode: 0o600 });
  const install = async () => {
    const input = { durableRoot: root, runRoot: run, agentIds: [AGENT] };
    const preview = await configureMonitorService(input);
    if (preview.state !== "preview") throw Error("fixture_missing_preview");
    return configureMonitorService({ ...input, expectedRevision: preview.expectedRevision, confirmed: true, operationId: randomUUID() });
  };
  let reads = 0;
  const read = async (ids: string[]) => { reads++; return { snapshot: ownedOwnershipSnapshot(ids), gateway: { pid: 4242, startedAt: 1700000000000 } }; };
  const event = (stepId: string) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date().toISOString(), mode: "route",
    hostGenerationId: "d".repeat(64), agentId: AGENT, turnId: `turn-${stepId}`, stepId, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" });
  const append = (path: string, step: string) => appendNdjsonLine(path, JSON.stringify(event(step)), "host", { configurationRoot: root });
  return { directory, root, run, config, document, install, read, reads: () => reads, append, close: () => rm(directory, { recursive: true, force: true }) };
}

test("install preview is read-only; exact config CAS publishes only collector intent without turning on notifications", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.config), initialNames = await readdir(f.root);
    const input = { durableRoot: f.root, runRoot: f.run, agentIds: [AGENT] };
    const preview = await configureMonitorService(input); expect(preview.state).toBe("preview");
    expect(await readFile(f.config)).toEqual(before); expect(await readdir(f.root)).toEqual(initialNames);
    if (preview.state !== "preview") throw Error("fixture_preview");
    await expect(configureMonitorService({ ...input, confirmed: true, operationId: "stale", expectedRevision: "f".repeat(64) })).rejects.toMatchObject({ code: "config_conflict" });
    expect(await readdir(f.root)).toEqual(initialNames);
    const confirmed = { ...input, confirmed: true, operationId: "install-once", expectedRevision: preview.expectedRevision };
    const installed = await configureMonitorService(confirmed); expect(installed).toMatchObject({ state: "configured", serviceStarted: false, currentMatches: true });
    const again = await configureMonitorService(confirmed); expect(again).toMatchObject({ state: "configured", currentMatches: true });
    const current = JSON.parse(await readFile(f.config, "utf8"));
    expect(current.ops.notifications.mode).toBe("off"); expect(current.daemon.observation).toEqual({ runRoot: f.run, agentIds: [AGENT] });
    expect(portableConfig(validateConfig(current)).daemon).toBeUndefined();
    expect((await openMonitorStore(f.root).snapshot()).collectorRecordedRunning).toBe(false);
  } finally { await f.close(); }
});

test("a replayed install never recreates a lost evidence database, and mismatched operation input cannot initialize it", async () => {
  const f = await fixture();
  try {
    const input = { durableRoot: f.root, runRoot: f.run, agentIds: [AGENT] };
    const plan = await configureMonitorService(input); if (plan.state !== "preview") throw Error("fixture_preview");
    const command = { ...input, confirmed: true, expectedRevision: plan.expectedRevision, operationId: "install-no-replay" };
    await configureMonitorService(command);
    await rm(join(f.root, "observability"), { recursive: true, force: true });
    const before = await readdir(f.root);
    await expect(configureMonitorService({ ...command, agentIds: [AGENT2] })).rejects.toMatchObject({ code: "config_conflict" });
    expect(await readdir(f.root)).toEqual(before);
    expect(await configureMonitorService(command)).toMatchObject({ database: { state: "not_reinitialized" } });
    expect(await readdir(f.root)).toEqual(before);
  } finally { await f.close(); }
});

test("unconfigured daemon child is inert and bad/disabled configuration never initializes a database or calls native sources", async () => {
  const f = await fixture(); const service = startMonitorService({ durableRoot: f.root, read: f.read }, { pollMs: 10 });
  try {
    await delay(35); expect(service.status().state).toBe("not_configured"); expect(f.reads()).toBe(0);
    await writeFile(f.config, "{PRIVATE_BAD_CONFIGURATION", { mode: 0o600 });
    await until(async () => service.status(), s => s.state === "blocked");
    expect(JSON.stringify(service.status())).not.toContain("PRIVATE_BAD"); expect(f.reads()).toBe(0);
    await writeFile(f.config, JSON.stringify({ ...f.document, daemon: { observation: { runRoot: f.run, agentIds: [AGENT] } }, ops: { monitor: { enabled: false } } }), { mode: 0o600 });
    await until(async () => service.status(), s => s.state === "disabled");
    expect(await readdir(f.root)).toEqual(["config.json"]);
  } finally { await service.close(); await f.close(); }
});

test("real collector drains control and Host writers while notifications remain off, then reopens without evidence replay", async () => {
  const f = await fixture(); let service: ReturnType<typeof startMonitorService> | undefined;
  try {
    await f.install(); await f.append(f.run, "host-failure"); await f.append(f.root, "control-failure");
    service = startMonitorService({ durableRoot: f.root, read: f.read }, { pollMs: 10 });
    const store = openMonitorStore(f.root);
    await until(() => store.incidents(), incidents => incidents.filter(i => i.rule === "execution_failure").length === 2)
      .catch(async () => { throw Error(JSON.stringify({ service: service!.status(), incidents: await store.incidents() })); });
    await until(async () => service!.status(), s => s.sources.length === 2)
      .catch(() => { throw Error(JSON.stringify(service!.status())); });
    expect(service.status().sources.map(s => s.source).sort()).toEqual(["control", "host"]);
    expect(service.status().sources.every(s => s.producerLiveness === "not_checked")).toBe(true);
    const ids = (await store.incidents()).map(i => i.id).sort();
    const oldEpoch = (await store.snapshot()).collectorEpoch;
    await service.close(); expect((await store.snapshot()).collectorRecordedRunning).toBe(false);
    service = startMonitorService({ durableRoot: f.root, read: f.read }, { pollMs: 10 });
    await until(() => store.snapshot(), s => s.collectorEpoch !== oldEpoch && s.collectorRecordedRunning);
    await until(async () => service!.status(), s => s.sources.length === 2)
      .catch(() => { throw Error(JSON.stringify(service!.status())); });
    expect((await store.incidents()).map(i => i.id).sort()).toEqual(ids);
    expect((effectiveOps(JSON.parse(await readFile(f.config, "utf8")).ops).notifications as Record<string, unknown>).mode).toBe("off");
    await service.close(); service = undefined;
    const data = await readFile(store.path); await delay(40); expect(await readFile(store.path)).toEqual(data);
  } finally { await service?.close(); await f.close(); }
}, 15000);

test("two services never collect concurrently; config target replacement settles before the next owner begins", async () => {
  const f = await fixture(); let first: ReturnType<typeof startMonitorService> | undefined, second: ReturnType<typeof startMonitorService> | undefined;
  try {
    await f.install(); await f.append(f.run, "once");
    first = startMonitorService({ durableRoot: f.root, read: f.read }, { pollMs: 10 });
    await until(async () => first!.status(), s => s.collectorEpoch !== null);
    second = startMonitorService({ durableRoot: f.root, read: f.read }, { pollMs: 10 });
    await until(async () => second!.status(), s => s.reason === "monitor_already_running_or_recovery_required");
    await second.close(); second = undefined;
    const epoch = first.status().collectorEpoch;
    const document = JSON.parse(await readFile(f.config, "utf8")); document.daemon.observation.agentIds = [AGENT2];
    await writeFile(f.config, JSON.stringify(document), { mode: 0o600 });
    await until(async () => first!.status(), s => s.collectorEpoch !== null && s.collectorEpoch !== epoch);
    const snapshot = await openMonitorStore(f.root).snapshot(); expect(snapshot.agents.map(a => a.agentId)).toEqual([AGENT2]);
    expect(first.status().replacements).toBe(2);
  } finally { await second?.close(); await first?.close(); await f.close(); }
}, 10000);

test("unsafe source and too many targets cannot be installed, and no missing-source directory is created", async () => {
  const f = await fixture();
  try {
    const link = join(f.directory, "linked-run"); await symlink(f.run, link);
    await expect(configureMonitorService({ durableRoot: f.root, runRoot: link, agentIds: [AGENT] })).rejects.toBeDefined();
    await expect(configureMonitorService({ durableRoot: f.root, runRoot: join(f.directory, "absent"), agentIds: [AGENT] })).rejects.toBeDefined();
    expect(() => validateConfig({ ...f.document, daemon: { observation: { runRoot: f.run, agentIds: Array.from({ length: 33 }, () => randomUUID()) } } })).toThrow();
    expect(await readMonitorServiceConfiguration(f.root)).toBeNull();
    expect(await readdir(f.root)).toEqual(["config.json"]);
  } finally { await f.close(); }
});
