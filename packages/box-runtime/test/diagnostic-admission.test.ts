import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { DiagnosticBudgetError, observeDiagnosticAdmission, withDiagnosticAdmission } from "../src/internal/host/diagnostic-budget.node.ts";
import { appendHostJournal } from "../src/internal/host/terminal-journal.node.ts";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
import { openBoundedProcessLog } from "../src/internal/io/bounded-process-log.node.ts";
import { observeRuntimeStorage } from "../src/internal/roots/storage-maintenance.runtime.ts";

const MIB = 1024 * 1024, AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "diagnostic-admission-")), root = join(directory, "durable"), run = join(directory, "run");
  await mkdir(root, { mode: 0o700 }); await mkdir(run, { mode: 0o700 });
  const document = validateConfig({ ...defaultConfig(), daemon: { observation: { runRoot: run, agentIds: [AGENT] } },
    ops: { notifications: { mode: "off" } }, storage: { diagnostics: { targetBytes: 2 * MIB, maxBytes: 8 * MIB, reserveBytes: MIB },
      retention: { monitor: { maxBytes: MIB }, journal: { segmentBytes: 128 * 1024, maxBytes: 256 * 1024 }, process: { segmentBytes: 2048, maxBytes: 8192 } } } });
  const config = join(root, "config.json"); await writeFile(config, JSON.stringify(document), { mode: 0o600 });
  const store = openMonitorStore(root, { maxDatabaseBytes: MIB }); await store.initialize();
  const admission = { configurationRoot: root, sourceRoot: run, writer: "process" as const, maxBytes: 64 * 1024 };
  return { directory, root, run, config, document, store, admission, close: () => rm(directory, { recursive: true, force: true }) };
}
function event() {
  return { name: "host_stream_rejected", schemaVersion: 2, at: new Date().toISOString(), mode: "route", hostGenerationId: "b".repeat(64),
    agentId: AGENT, stepId: randomUUID(), turnId: "fixture-turn", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream" };
}

test("installed diagnostic writers serialize real file effects before their domain locks", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.run, "log"), { mode: 0o700 });
    let active = 0, peak = 0, done = 0;
    await Promise.all(Array.from({ length: 8 }, (_, n) => withDiagnosticAdmission(f.admission, async () => {
      active++; peak = Math.max(peak, active);
      try { await pause(4); await writeFile(join(f.run, "log", `owned-${n}.ndjson`), "FINITE_FIXTURE\n", { mode: 0o600 }); done++; }
      finally { active--; }
    })));
    expect(peak).toBe(1); expect(done).toBe(8);
    expect(await readdir(join(f.root, "state/diagnostic-admission"))).toEqual(["scope.json"]);
    expect(await observeDiagnosticAdmission(f.root)).toMatchObject({ state: "scope_bound", osFilesystemQuota: false, allRunningWritersVerified: false,
      writers: ["monitor", "monitor-initialize", "journal", "process"] });
  } finally { await f.close(); }
}, 10000);

test("joint pressure blocks SQLite, Host journal and process appends without deleting existing bytes", async () => {
  const f = await fixture(); let writer: Awaited<ReturnType<typeof openBoundedProcessLog>> | undefined;
  try {
    writer = await openBoundedProcessLog({ runRoot: f.run, configurationRoot: f.root, generation: randomUUID(), nowMs: Date.now(), policy: f.document.storage!.retention!.process });
    expect(await appendHostJournal(f.run, event(), { configurationRoot: f.root })).toBe("written");
    const backup = join(f.root, "observability/owned-pressure-fixture.bin");
    await writeFile(backup, Buffer.alloc(6 * MIB), { mode: 0o600 });
    const database = await readFile(f.store.path), journal = await readFile(join(f.run, "log/events.ndjson"));
    await expect(f.store.begin(randomUUID(), Date.now(), [AGENT])).rejects.toMatchObject({ message: "monitor_storage_pressure" });
    expect(await appendHostJournal(f.run, event(), { configurationRoot: f.root })).toBe("write_failed");
    expect(await writer.append({ event: "ready", atMs: Date.now() })).toBe("dropped");
    expect(writer.health()).toMatchObject({ state: "available", reason: "storage_pressure" });
    expect(await readFile(f.store.path)).toEqual(database); expect(await readFile(join(f.run, "log/events.ndjson"))).toEqual(journal);
    expect((await readFile(backup)).length).toBe(6 * MIB);
    // Only the test owns this artificial pressure file; no production cleanup
    // primitive receives its path or decides that a measured backup is deletable.
    await unlink(backup);
    expect(await writer.append({ event: "ready", atMs: Date.now() })).toBe("written");
    const epoch = randomUUID(); await f.store.begin(epoch, Date.now(), [AGENT]); await f.store.finish(epoch, Date.now());
  } finally { await writer?.close(); await f.close(); }
});

test("maintenance can use the reserved region while normal database growth is refused", async () => {
  const f = await fixture();
  try {
    const pressure = join(f.root, "observability/owned-reserve-fixture.bin");
    await writeFile(pressure, Buffer.alloc(Math.floor(4.5 * MIB)), { mode: 0o600 });
    await expect(f.store.begin(randomUUID(), Date.now(), [AGENT])).rejects.toMatchObject({ message: "monitor_storage_pressure" });
    expect(await f.store.maintain(Date.now())).toMatchObject({ retention: { mayExpire: true } });
    expect((await readFile(pressure)).length).toBe(4.5 * MIB);
  } finally { await f.close(); }
});

test("removed configuration, changed roots and missing established scope cannot silently regain a new pool", async () => {
  const f = await fixture();
  try {
    let effects = 0;
    await unlink(f.config);
    await expect(withDiagnosticAdmission(f.admission, async () => effects++)).rejects.toMatchObject({ reason: "policy_unavailable" });
    await writeFile(f.config, JSON.stringify({ ...f.document, daemon: { observation: { runRoot: f.root, agentIds: [AGENT] } } }), { mode: 0o600 });
    await expect(withDiagnosticAdmission(f.admission, async () => effects++)).rejects.toMatchObject({ reason: "scope_changed" });
    await writeFile(f.config, JSON.stringify(f.document), { mode: 0o600 });
    await unlink(join(f.root, "state/diagnostic-admission/scope.json"));
    await expect(withDiagnosticAdmission(f.admission, async () => effects++)).rejects.toMatchObject({ reason: "unsafe_state" });
    expect(effects).toBe(0); expect(await readdir(join(f.root, "state/diagnostic-admission"))).toEqual([]);
  } finally { await f.close(); }
});

test("metadata gaps block admission but local queries remain available and never create or repair state", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, "observability/a/b/c/d/e"), { recursive: true, mode: 0o700 });
    const before = await readFile(f.store.path), scope = await readFile(join(f.root, "state/diagnostic-admission/scope.json"));
    await expect(withDiagnosticAdmission(f.admission, async () => true)).rejects.toMatchObject({ reason: "inventory_incomplete" });
    const status = await observeRuntimeStorage({ durableRoot: f.root, runRoot: f.run });
    expect(status).toMatchObject({ diagnosticAdmission: { state: "scope_bound" }, footprint: { state: "partial" }, installationBudgetEnforced: false });
    expect(JSON.stringify(status.diagnosticAdmission)).not.toContain(f.directory);
    expect(await readFile(f.store.path)).toEqual(before); expect(await readFile(join(f.root, "state/diagnostic-admission/scope.json"))).toEqual(scope);
  } finally { await f.close(); }
});

test("a real killed reservation owner releases admission without replaying its callback", async () => {
  const f = await fixture();
  const module = new URL("../src/internal/host/diagnostic-budget.node.ts", import.meta.url).pathname;
  const code = `import {withDiagnosticAdmission} from ${JSON.stringify(module)}; await withDiagnosticAdmission(${JSON.stringify(f.admission)}, async()=>{console.log('OWNED_RESERVED');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--eval", code], { cwd: process.cwd(), env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("owned_reservation_ready_timeout")), 5000);
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; if (output.includes("OWNED_RESERVED")) { clearTimeout(timer); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(Error("owned_reservation_exited_before_ready")); });
    });
    child.kill("SIGKILL"); await exit;
    let effects = 0;
    expect(await withDiagnosticAdmission(f.admission, async () => ++effects)).toBe(1);
    expect(effects).toBe(1); expect(await readdir(join(f.root, "state/diagnostic-admission"))).toEqual(["scope.json"]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exit; await f.close(); }
}, 10000);

test("error codes are finite; invalid admission does not execute a callback", async () => {
  const f = await fixture();
  try {
    let called = false;
    await expect(withDiagnosticAdmission({ ...f.admission, maxBytes: Number.NaN }, async () => { called = true; })).rejects.toBeInstanceOf(DiagnosticBudgetError);
    expect(called).toBe(false);
  } finally { await f.close(); }
});
