import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { defaultConfig, validateConfig, configurationRevisions, type UnifiedConfig } from "@grokbox/runtime-kernel/config";
import { appendHostJournal, appendNdjsonLine, withEventsLock } from "../src/internal/host/terminal-journal.node.ts";
import { readJournalPolicy } from "../src/internal/host/journal-policy.node.ts";
import { inspectJournalSegments } from "../src/internal/host/journal-segments.node.ts";
import { PACKED_SESSION_SYMBOL } from "../src/internal/host/profile.ts";
import { appendEvent, observeEvents } from "../src/internal/io/journal.node.ts";
import { maintainRegisteredJournals } from "../src/internal/io/journal-maintenance.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { readStorageConfiguration } from "../src/internal/io/storage-configuration.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";
import { runMonitor } from "../src/internal/roots/monitor.runtime.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", HOST = "b".repeat(64), KIB = 1024;
const failure = (n: number, at = Date.now()) => ({ name: "host_stream_rejected", schemaVersion: 2, at: new Date(at).toISOString(), mode: "route",
  hostGenerationId: HOST, agentId: AGENT, turnId: `turn-${n}`, stepId: `step-${n}`, stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" });
// Padding is fixed fixture text for the byte-writer test only, not a claim that
// production projectors store arbitrary fields. Host-path tests use real projection.
const padded = (n: number) => JSON.stringify({ ...failure(n), fixturePadding: "x".repeat(16 * KIB) }) + "\n";
async function fixture(segmentBytes = 128 * KIB, maxBytes = 256 * KIB) {
  const directory = await mkdtemp(join(tmpdir(), "journal-policy-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(join(run, "log"), { recursive: true, mode: 0o700 });
  const path = join(root, "config.json"), active = join(run, "log/events.ndjson");
  let document = validateConfig({ ...defaultConfig(), ops: { enabled: false, notifications: { mode: "off" } },
    storage: { retention: { journal: { segmentBytes, maxBytes, maxAgeMs: 60_000 } } } });
  const save = async (next: UnifiedConfig) => { document = validateConfig(next); await writeFile(path, JSON.stringify(document), { mode: 0o600 }); };
  await save(document);
  return { directory, root, run, path, active, save, config: () => document,
    append: (n: number, at = Date.now()) => appendNdjsonLine(run, padded(n), "host", { configurationRoot: root, nowMs: at }),
    close: () => rm(directory, { recursive: true, force: true }) };
}
async function bytes(root: string) {
  const names = (await readdir(join(root, "log"))).sort();
  return Promise.all(names.map(async name => {
    const path = join(root, "log", name);
    return [name, (await lstat(path)).isDirectory() ? (await readdir(path)).sort() : await readFile(path)];
  }));
}

test("the Host storage projection agrees with canonical configuration and never substitutes defaults for corruption", async () => {
  const f = await fixture(); try {
    const expected = await readStorageConfiguration(f.root), before = await readFile(f.path);
    expect(await readJournalPolicy(f.root)).toMatchObject({ source: "canonical-config", storageRevision: expected.revision, policy: expected.policy.retention.journal });
    expect(await readFile(f.path)).toEqual(before);
    for (const value of ["{broken", JSON.stringify({ ...f.config(), schemaVersion: 3 }), JSON.stringify({ ...f.config(), storage: { retention: { erase: true } } })]) {
      await writeFile(f.path, value, { mode: 0o600 });
      await expect(readJournalPolicy(f.root)).rejects.toThrow("journal_storage_config_unavailable");
    }
    await f.save(f.config());
    await mkdir(join(f.root, "state")); await writeFile(join(f.root, "state/config-migration.json"), '{"phase":"publishing"}', { mode: 0o600 });
    await expect(readJournalPolicy(f.root)).rejects.toThrow("journal_storage_config_unavailable");
    const blank = join(f.directory, "missing");
    expect(await readJournalPolicy(blank)).toMatchObject({ source: "default-no-config" });
    expect(await readdir(f.directory)).not.toContain("missing");
  } finally { await f.close(); }
});

test("configured writes obey the smaller journal allocation; config reads cannot manufacture adoption", async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 50; n++) {
      await f.append(n);
      const inventory = await inspectJournalSegments(f.run);
      if (inventory.mode === "segmented") expect(inventory.entries.reduce((size, s) => size + s.bytes, 0)).toBeLessThanOrEqual(256 * KIB);
    }
    const first = await inspectJournalSegments(f.run);
    expect(first.retiredSegments).toBeGreaterThan(0);
    expect(first.writerPolicy).toMatchObject({ storageRevision: configurationRevisions(f.config()).storage, policy: { segmentBytes: 128 * KIB, maxBytes: 256 * KIB } });
    const raw = await readFile(join(f.run, "log/events.segments.json"), "utf8");
    expect(raw).not.toContain(f.root);
    const changed = validateConfig({ ...f.config(), storage: { ...f.config().storage, diagnostics: { detailDays: 2 } } });
    await f.save(changed);
    const prior = await bytes(f.run);
    const status = await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run });
    expect(status.journals.find(j => j.source === "host")).toMatchObject({ matchesRequestedPolicy: false, writerAdoption: "last-write-observed", currentWriterLiveness: "not_checked" });
    expect(await bytes(f.run)).toEqual(prior);
    expect(await appendHostJournal(f.run, failure(100), { configurationRoot: f.root })).toBe("written");
    const next = await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run });
    expect(next.journals.find(j => j.source === "host")).toMatchObject({ matchesRequestedPolicy: true });
    expect(next.installationBudgetEnforced).toBe(false);
  } finally { await f.close(); }
});

test("a confirmed shrink seals a pre-existing oversized active file before reclaiming it and admitting the new failure", async () => {
  const f = await fixture(512 * KIB, 1024 * KIB); try {
    for (let n = 0; n < 24; n++) await f.append(n);
    const old = await readFile(f.active); expect(old.length).toBeGreaterThan(256 * KIB);
    await f.save(validateConfig({ ...f.config(), storage: { retention: { journal: { segmentBytes: 128 * KIB, maxBytes: 256 * KIB } } } }));
    expect(await appendHostJournal(f.run, failure(100), { configurationRoot: f.root })).toBe("written");
    const inventory = await inspectJournalSegments(f.run);
    expect(inventory.entries.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(256 * KIB);
    expect(inventory.retiredBytes).toBe(old.length);
    const query = await observeEvents(f.run, 100, { agentId: AGENT, stepId: "step-100" });
    expect(query.events.some(e => "stepId" in e && e.stepId === "step-100")).toBe(true);
    expect(query.coverage?.segmentCoverage?.retiredSegments).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("an unbound or differently rooted writer cannot override an already adopted policy; damage still leaves evidence readable", async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 10; n++) await f.append(n);
    const before = await bytes(f.run);
    await expect(appendNdjsonLine(f.run, padded(100), "host")).rejects.toThrow("journal_policy_source_required");
    const other = join(f.directory, "other"); await mkdir(other); await writeFile(join(other, "config.json"), JSON.stringify(f.config()), { mode: 0o600 });
    await expect(appendNdjsonLine(f.run, padded(101), "host", { configurationRoot: other })).rejects.toThrow("journal_policy_source_required");
    expect(await bytes(f.run)).toEqual(before);
    await writeFile(f.path, "{PRIVATE_CONFIG_SENTINEL", { mode: 0o600 });
    expect(await appendHostJournal(f.run, failure(102), { configurationRoot: f.root })).toBe("write_failed");
    const read = await observeEvents(f.run, 100, { agentId: AGENT, stepId: "step-9" });
    expect(read.events.some(e => "stepId" in e && e.stepId === "step-9")).toBe(true);
    expect(await bytes(f.run)).toEqual(before);
    expect(JSON.stringify(await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run }))).not.toContain("PRIVATE_CONFIG_SENTINEL");
  } finally { await f.close(); }
});

test("even a small configured journal refuses deleted configuration rather than expanding back to defaults", async () => {
  const f = await fixture(); try {
    expect(await appendHostJournal(f.run, failure(0), { configurationRoot: f.root })).toBe("written");
    expect((await inspectJournalSegments(f.run)).writerPolicy?.source).toBe("canonical-config");
    const before = await bytes(f.run);
    await rm(f.path);
    expect(await appendHostJournal(f.run, failure(1), { configurationRoot: f.root })).toBe("write_failed");
    expect((await maintainRegisteredJournals({ durableRoot: f.root, runRoot: f.run })).roots.find(r => r.source === "host")?.state).toBe("unavailable");
    expect(await bytes(f.run)).toEqual(before);
    expect((await observeEvents(f.run, 100, { agentId: AGENT, stepId: "step-0" })).events.length).toBeGreaterThan(0);
    await f.save(f.config());
    expect(await appendHostJournal(f.run, failure(2), { configurationRoot: f.root })).toBe("written");
  } finally { await f.close(); }
});

test("maintenance uses the current canonical policy but never creates a successful-write witness", async () => {
  const f = await fixture(); try {
    const old = Date.now() - 120_000;
    for (let n = 0; n < 10; n++) await f.append(n, old);
    const original = (await inspectJournalSegments(f.run)).writerPolicy;
    await f.save(validateConfig({ ...f.config(), storage: { ...f.config().storage, diagnostics: { detailDays: 2 } } }));
    const result = await maintainRegisteredJournals({ durableRoot: f.root, runRoot: f.run });
    expect(result.roots.find(r => r.source === "host")).toMatchObject({ state: "maintained" });
    expect(result.roots.find(r => r.source === "host")?.reclaimedBytes).toBeGreaterThan(0);
    expect((await inspectJournalSegments(f.run)).writerPolicy).toEqual(original);
    expect(JSON.parse(await readFile(f.path, "utf8")).ops.enabled).toBe(false);
    expect(await readdir(f.root)).not.toContain("log");
  } finally { await f.close(); }
});

test("an occupied writer lock defers housekeeping immediately without stealing it or blocking other roots", async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 10; n++) await f.append(n);
    await withEventsLock(f.run, async () => {
      const before = await bytes(f.run), started = performance.now();
      const result = await maintainRegisteredJournals({ durableRoot: f.root, runRoot: f.run });
      expect(result.roots.find(r => r.source === "host")).toMatchObject({ state: "busy", reclaimedBytes: 0 });
      expect(performance.now() - started).toBeLessThan(500);
      expect(await bytes(f.run)).toEqual(before);
    });
    expect((await readdir(join(f.run, "log"))).includes("events.lock")).toBe(false);
  } finally { await f.close(); }
});

test("collector's maintenance path reclaims registered journal segments even when notifications are off", async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 10; n++) await f.append(n, Date.now() - 120_000);
    const storage = await readStorageConfiguration(f.root); await openMonitorStore(f.root, storage.monitor).initialize();
    let maintenance: unknown;
    await runMonitor({ durableRoot: f.root, runRoot: f.run, agentIds: [AGENT], once: true, signal: new AbortController().signal,
      read: async () => ({ snapshot: ownedOwnershipSnapshot([AGENT]), gateway: { pid: 4242, startedAt: 1700000000000 } }),
      publish: receipt => { maintenance = receipt.maintenance; } });
    expect(maintenance).toMatchObject({ journals: { roots: [{ source: "control", state: "not_segmented" }, { source: "host", state: "maintained" }] } });
    expect((await inspectJournalSegments(f.run)).retiredSegments).toBeGreaterThan(0);
    expect((await openMonitorStore(f.root).snapshot()).collectorRecordedRunning).toBe(false);
  } finally { await f.close(); }
});

test("the control-plane writer also resolves the canonical storage policy", async () => {
  const f = await fixture(); try {
    await mkdir(join(f.root, "log"), { mode: 0o700 });
    await writeFile(join(f.root, "log/events.ndjson"), padded(0).repeat(10), { mode: 0o600 });
    await appendEvent(f.root, { name: "disk_sha_observed", at: new Date().toISOString(), sha: HOST });
    expect((await inspectJournalSegments(f.root)).writerPolicy?.storageRevision).toBe(configurationRevisions(f.config()).storage);
  } finally { await f.close(); }
});

test("actual packed Host hook writes through the configured root without a model or native service", async () => {
  const f = await fixture(); try {
    await writeFile(f.active, padded(0).repeat(10), { mode: 0o600 });
    await writeFile(join(f.root, "models.json"), '{"version":2,"models":{},"assignments":{"main":null,"agents":{}}}', { mode: 0o600 });
    const entry = ensurePackedCli(), preload = join(entry, "..", "preload.cjs");
    const worker = `const fs=require('node:fs/promises');
const [root,run,symbol,agent]=process.argv.slice(1),api=globalThis[Symbol.for(symbol)];
const original={fixture:true};
const result=api.bindHostSessionHook({mode:'route',durableRoot:root,runRoot:run})({agentId:agent,sessionOptions:{invocationId:'packed-policy-turn'},originalSession:original});
(async()=>{for(let i=0;i<100;i++){let body='';try{body=await fs.readFile(run+'/log/events.ndjson','utf8')}catch{}
if(body.includes('packed-policy-turn')){console.log(JSON.stringify({declined:result===original,observed:true}));return;}
await new Promise(r=>setTimeout(r,10));}process.exitCode=2;})();`;
    const child = spawn("node", ["--require", preload, "-e", worker, f.root, f.run, PACKED_SESSION_SYMBOL, AGENT], {
      cwd: f.directory, env: { PATH: process.env.PATH, HOME: f.directory, GROKBOX_PACKED_SESSION_FACTORY: "1" }, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
    let stdout = "", stderr = ""; child.stdout.on("data", d => stdout += d); child.stderr.on("data", d => stderr += d);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual({ declined: true, observed: true });
    expect((await inspectJournalSegments(f.run)).writerPolicy).toMatchObject({ storageRevision: configurationRevisions(f.config()).storage, policy: { segmentBytes: 128 * KIB } });
    expect(await readdir(f.directory)).toEqual(["durable", "run"]);
  } finally { await f.close(); }
}, 15000);

test("a symlink in the configuration slot cannot redirect policy reads and does not cause cleanup", async () => {
  const f = await fixture(); try {
    for (let n = 0; n < 10; n++) await f.append(n);
    const before = await bytes(f.run), victim = join(f.directory, "private.json");
    await writeFile(victim, '{"private":"SENTINEL"}', { mode: 0o600 }); await rm(f.path); await symlink(victim, f.path);
    expect(await appendHostJournal(f.run, failure(100), { configurationRoot: f.root })).toBe("write_failed");
    expect((await maintainRegisteredJournals({ durableRoot: f.root, runRoot: f.run })).roots.find(r => r.source === "host")?.state).toBe("unavailable");
    expect(await bytes(f.run)).toEqual(before); expect(await readFile(victim, "utf8")).toBe('{"private":"SENTINEL"}');
  } finally { await f.close(); }
});
