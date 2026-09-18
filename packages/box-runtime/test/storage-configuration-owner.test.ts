import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { defaultConfig, validateConfig, configurationRevisions } from "@grokbox/runtime-kernel/config";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { readStorageConfiguration } from "../src/internal/io/storage-configuration.node.ts";
import { observeProcessLogStorage } from "../src/internal/io/bounded-process-log.node.ts";
import { startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { runMonitor } from "../src/internal/roots/monitor.runtime.ts";
import { runIncidentEvidenceCommand } from "../src/internal/roots/incident-evidence.runtime.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", DAY = 86400000;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "storage-config-owner-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(join(run, "log"), { recursive: true, mode: 0o700 });
  const document = validateConfig({ ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" } },
    storage: { diagnostics: { detailDays: 1, summaryDays: 3 }, retention: { monitor: { maxBytes: 1024 * 1024 }, process: { segmentBytes: 2048, maxBytes: 8192 } } } });
  const path = join(root, "config.json"); await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return { directory, root, run, path, document, close: () => rm(directory, { recursive: true, force: true }) };
}
const failure = (at: number) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route", hostGenerationId: "b".repeat(64),
  agentId: AGENT, turnId: "turn-one", stepId: "step-one", stage: "normalize", reason: "invalid-stream", errorCode: "invalid_stream" });

test("real collector captures configured detail and summary TTL with notifications disabled", async () => {
  const f = await fixture(); try {
    const configuration = await readStorageConfiguration(f.root);
    expect(configuration.monitor).toEqual({ maxDatabaseBytes: 1024 * 1024, retentionMs: DAY, summaryMs: 3 * DAY });
    const store = openMonitorStore(f.root, configuration.monitor); await store.initialize();
    await writeFile(join(f.run, "log/events.ndjson"), JSON.stringify(failure(Date.now())) + "\n", { mode: 0o600 });
    const reports: unknown[] = [];
    await runMonitor({ durableRoot: f.root, runRoot: f.run, agentIds: [AGENT], signal: new AbortController().signal, once: true,
      read: async () => ({ snapshot: ownedOwnershipSnapshot([AGENT]), gateway: { pid: 4242, startedAt: 1700000000000 } }), publish: receipt => reports.push(receipt) });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ notificationMode: "local_only", storagePolicy: { revision: configuration.revision, source: "canonical-config", scope: "monitor", hotReload: false } });
    const incident = (await store.incidents()).find(value => value.rule === "execution_failure")!;
    const report = await store.incidentEvidence(incident.id, 1);
    expect(report).toMatchObject({ state: "available" });
    if (!("capturedAtMs" in report) || !("retention" in report) || !report.retention) throw Error("fixture_missing_manifest");
    expect(report.retention.expiresAtMs - report.capturedAtMs).toBe(DAY);
    expect(report.retention.summaryExpiresAtMs - report.capturedAtMs).toBe(3 * DAY);
    await store.maintain(report.capturedAtMs + DAY + 1);
    expect(await store.incidentEvidence(incident.id, 1)).toMatchObject({ state: "expired", retention: { tier: "summary" } });
    expect(JSON.parse(await readFile(f.path, "utf8")).ops.enabled).toBe(false);
  } finally { await f.close(); }
});

test("explicit capture adopts current storage TTL but ordinary read ignores damaged current configuration", async () => {
  const f = await fixture(); try {
    const store = openMonitorStore(f.root), epoch = randomUUID(), now = Date.now();
    await store.initialize(); await store.begin(epoch, now, [AGENT]);
    await store.ingestEvidence({ epoch, sourceKey: "c".repeat(64), expectedCursor: null, nextCursor: "one", events: [failure(now)], atMs: now });
    const id = (await store.incidents())[0]!.id;
    const original = await store.incidentEvidence(id, 1);
    // Change facts so explicit capture has a new immutable revision.
    await store.ingestEvidence({ epoch, sourceKey: "c".repeat(64), expectedCursor: "one", nextCursor: "two", events: [{ ...failure(now + 1), stepId: "step-two" }], atMs: now + 1 });
    const captured = await runIncidentEvidenceCommand({ durableRoot: f.root, command: { kind: "capture", incidentId: id, confirmed: true } });
    expect(captured).toMatchObject({ revision: 2 });
    const next = await store.incidentEvidence(id, 2);
    if (!("capturedAtMs" in next) || !("retention" in next) || !next.retention) throw Error("fixture_missing_manifest");
    expect(next.retention.expiresAtMs - next.capturedAtMs).toBe(DAY);
    await writeFile(f.path, "{broken-config", { mode: 0o600 });
    const before = await readFile(store.path);
    expect(await runIncidentEvidenceCommand({ durableRoot: f.root, command: { kind: "read", incidentId: id, revision: 1 } })).toEqual(original);
    await expect(runIncidentEvidenceCommand({ durableRoot: f.root, command: { kind: "capture", incidentId: id, confirmed: true } })).rejects.toBeDefined();
    expect(await readFile(store.path)).toEqual(before);
    expect(await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run })).toMatchObject({ storageIntent: { state: "unavailable" }, installationBudgetEnforced: false });
  } finally { await f.close(); }
});

test("actual modeld log writer obeys its configured 8KiB allocation across service generations", async () => {
  const f = await fixture(); try {
    const before = await readFile(f.path);
    for (let n = 0; n < 12; n++) {
      const owner = await startModeldProcess({ durableRoot: f.root, runRoot: f.run, env: {} });
      try { expect(owner.ensure).toMatchObject({ kind: "owned", storagePolicyRevision: configurationRevisions(f.document).storage, processLog: { state: "available" } }); }
      finally { await owner.stop(); }
      const log = await observeProcessLogStorage(f.run); expect(log.state).toBe("available"); expect(log.bytes).toBeLessThanOrEqual(8192); expect(log.segments.length).toBeLessThanOrEqual(4);
    }
    expect(await readFile(f.path)).toEqual(before);
    expect(await readdir(join(f.root, "state")).catch(() => [])).not.toContain("config-consumers");
  } finally { await f.close(); }
}, 15000);

test("invalid config refuses new collector work without initializing or silently enabling a default policy", async () => {
  const f = await fixture(); try {
    await writeFile(f.path, JSON.stringify({ ...f.document, schemaVersion: 3 }), { mode: 0o600 });
    let reads = 0, reports = 0;
    await expect(runMonitor({ durableRoot: f.root, runRoot: f.run, agentIds: [AGENT], signal: new AbortController().signal, once: true,
      read: async () => { reads++; throw Error("unexpected_source"); }, publish: () => { reports++; } })).rejects.toBeDefined();
    expect(reads).toBe(0); expect(reports).toBe(0); expect(await readdir(f.root)).toEqual(["config.json"]);
  } finally { await f.close(); }
});
