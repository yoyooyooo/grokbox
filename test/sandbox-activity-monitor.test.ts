import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const monitor = join(import.meta.dir, "..", "scripts", "monitor-sandbox-ssh-activity.mjs");

async function writeCheckpoint(
  evidenceDir: string,
  sequence: number,
  observation: Record<string, unknown>,
  runId = "11111111-1111-4111-8111-111111111111",
  qualificationEligible = true,
) {
  const value = {
    version: 1,
    runId,
    experiment: "sandbox-ssh-activity",
    sequence,
    policy: { qualificationEligible },
    observation,
  };
  const name = `sandbox-ssh-activity-${runId}.checkpoint-${String(sequence).padStart(4, "0")}.json`;
  await writeFile(join(evidenceDir, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function runMonitor(options: {
  checkpoints?: Array<Record<string, unknown>>;
  malformed?: boolean;
  failFirstHook?: boolean;
  omitFinal?: boolean;
  mismatchFinal?: boolean;
  qualificationEligible?: boolean;
  durationMs?: number;
  stallMs?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-ssh-monitor-test-"));
  const evidenceDir = join(root, "evidence");
  const hook = join(root, "notify-hook.cjs");
  const hookLog = join(root, "hook.log");
  const hookAttempts = join(root, "hook.attempts");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  for (const [index, observation] of (options.checkpoints ?? []).entries()) {
    await writeCheckpoint(
      evidenceDir,
      index + 1,
      observation,
      "11111111-1111-4111-8111-111111111111",
      options.qualificationEligible ?? true,
    );
  }
  const terminal = (options.checkpoints ?? []).find((observation) => observation.kind === "terminal");
  if (terminal && !options.omitFinal) {
    await writeFile(
      join(evidenceDir, "sandbox-ssh-activity-11111111-1111-4111-8111-111111111111.json"),
      `${JSON.stringify({
        version: 1,
        runId: "11111111-1111-4111-8111-111111111111",
        experiment: "sandbox-ssh-activity",
        outcome: terminal.outcome,
        finding: options.mismatchFinal ? "inconclusive" : terminal.finding,
        policy: { qualificationEligible: options.qualificationEligible ?? true },
      })}\n`,
      { mode: 0o600 },
    );
  }
  if (options.malformed) {
    await writeFile(join(evidenceDir, "sandbox-ssh-activity-bad.checkpoint-9999.json"), "not-json\n", { mode: 0o600 });
  }
  await writeFile(hook, `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let attempts = 0;
  try { attempts = Number(fs.readFileSync(process.env.HOOK_ATTEMPTS, "utf8")); } catch {}
  fs.writeFileSync(process.env.HOOK_ATTEMPTS, String(attempts + 1));
  if (process.env.FAIL_FIRST_HOOK === "1" && attempts === 0) process.exit(1);
  const value = JSON.parse(input);
  fs.appendFileSync(process.env.HOOK_LOG, JSON.stringify({ argv: process.argv.slice(2), value }) + "\\n");
});
`, { mode: 0o700 });
  await chmod(hook, 0o700);
  const child = Bun.spawn([process.execPath, monitor], {
    env: {
      ...process.env,
      GROKBOX_SANDBOX_EVIDENCE_DIR: evidenceDir,
      GROKBOX_SANDBOX_NOTIFY_HOOK: hook,
      GROKBOX_SANDBOX_MONITOR_DURATION_MS: String(options.durationMs ?? 500),
      GROKBOX_SANDBOX_MONITOR_INTERVAL_MS: "10",
      GROKBOX_SANDBOX_MONITOR_STALL_MS: String(options.stallMs ?? 100),
      GROKBOX_SANDBOX_MONITOR_ALLOW_SHORT: "1",
      HOOK_LOG: hookLog,
      HOOK_ATTEMPTS: hookAttempts,
      FAIL_FIRST_HOOK: options.failFirstHook ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const files = await readdir(evidenceDir);
  const summaryName = files.find((name) => name.startsWith("sandbox-ssh-activity-monitor-") && name.endsWith(".json"));
  const summary = summaryName ? JSON.parse(await readFile(join(evidenceDir, summaryName), "utf8")) : null;
  const notifications = (await readFile(hookLog, "utf8").catch(() => ""))
    .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { code, stdout, stderr, evidenceDir, files, summaryName, summary, notifications };
}

const successfulCheckpoints = [
  { kind: "stimulus", stimulusSequence: 0 },
  { kind: "stage-transition", to: "passive-withdrawal" },
  { kind: "candidate-confirmation", stage: "passive-withdrawal" },
  { kind: "terminal", outcome: "passed", finding: "supports-anti-idle", observedAtMs: 100 },
];

describe("Sandbox SSH activity notification monitor", () => {
  test("projects fixed terminal notifications through stdin and writes a protected summary", async () => {
    const result = await runMonitor({ checkpoints: successfulCheckpoints });
    expect(result.code).toBe(0);
    const events = result.notifications.map((row) => row.value.event);
    expect(events).toEqual([
      "stimulus-started",
      "stimulus-complete",
      "freeze-candidate",
      "freeze-passed",
      "manual-app-recovery-required",
      "window-complete",
    ]);
    for (const row of result.notifications) {
      expect(row.argv).toEqual([]);
      expect(row.value).toEqual({
        version: 1,
        event: expect.any(String),
        title: expect.any(String),
        body: expect.any(String),
      });
    }
    expect(result.summary).toMatchObject({
      experiment: "sandbox-ssh-activity-notifications",
      runObserved: true,
      malformedEvidenceObserved: false,
      aborted: false,
      terminal: { outcome: "passed", finding: "supports-anti-idle", qualificationEligible: true },
      finalArtifactObserved: true,
      notifications: { delivered: events, pending: [] },
    });
    expect((await stat(result.evidenceDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(result.evidenceDir, result.summaryName!))).mode & 0o777).toBe(0o600);
    expect(result.files).not.toContain(".sandbox-ssh-activity-monitor.lock");
    expect(JSON.stringify(result.summary)).not.toContain(result.evidenceDir);
    expect(JSON.stringify(result.summary)).not.toContain("notify-hook");
  });

  test("does not announce stimulus start when SSH preflight failed", async () => {
    const preflightFailure = [
      { kind: "preflight", state: "running", sshStatus: "inconclusive" },
      { kind: "terminal", outcome: "failed", finding: "inconclusive", observedAtMs: 100 },
    ];
    const result = await runMonitor({ checkpoints: preflightFailure, qualificationEligible: false });
    expect(result.code).toBe(0);
    const events = result.notifications.map((row) => row.value.event);
    expect(events).toContain("experiment-inconclusive");
    expect(events).toContain("window-complete");
    expect(events).not.toContain("stimulus-started");
    expect(events).not.toContain("development-complete");
  });

  test("never emits qualification-success events for a development-only final artifact", async () => {
    const result = await runMonitor({ checkpoints: successfulCheckpoints, qualificationEligible: false });
    expect(result.code).toBe(0);
    expect(result.summary.terminal).toMatchObject({
      finding: "supports-anti-idle",
      qualificationEligible: false,
    });
    const events = result.notifications.map((row) => row.value.event);
    expect(events).toContain("development-complete");
    expect(events).toContain("window-complete");
    expect(events).not.toContain("freeze-passed");
    expect(events).not.toContain("manual-app-recovery-required");
  });

  test("retries a failed notification without blocking terminal settlement", async () => {
    const result = await runMonitor({ checkpoints: successfulCheckpoints, failFirstHook: true });
    expect(result.code).toBe(0);
    expect(result.summary.notifications.pending).toEqual([]);
    expect(result.summary.notifications.delivered).toContain("stimulus-started");
    expect(result.notifications.map((row) => row.value.event)).toContain("window-complete");
  });

  test("does not announce completion from a terminal checkpoint without its matching final artifact", async () => {
    const result = await runMonitor({ checkpoints: successfulCheckpoints, omitFinal: true, durationMs: 80 });
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({
      terminal: { finding: "supports-anti-idle" },
      finalArtifactObserved: false,
      malformedEvidenceObserved: true,
    });
    const events = result.notifications.map((row) => row.value.event);
    expect(events).toContain("evidence-malformed");
    expect(events).not.toContain("freeze-passed");
    expect(events).not.toContain("window-complete");
  });

  test("rejects an invalid terminal outcome/finding combination without a success notification", async () => {
    const invalid = [
      { kind: "stimulus", stimulusSequence: 0 },
      { kind: "terminal", outcome: "failed", finding: "supports-anti-idle", observedAtMs: 100 },
    ];
    const result = await runMonitor({ checkpoints: invalid, durationMs: 80 });
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({
      terminal: null,
      finalArtifactObserved: false,
      malformedEvidenceObserved: true,
    });
    const events = result.notifications.map((row) => row.value.event);
    expect(events).toContain("evidence-malformed");
    expect(events).not.toContain("freeze-passed");
  });

  test("reports malformed evidence and refuses a healthy monitor result", async () => {
    const result = await runMonitor({ checkpoints: successfulCheckpoints, malformed: true });
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ malformedEvidenceObserved: true });
    expect(result.summary.notifications.delivered).toContain("evidence-malformed");
  });

  test("reports a stalled run without inventing a terminal lifecycle result", async () => {
    const result = await runMonitor({ durationMs: 80, stallMs: 20 });
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ runObserved: false, terminal: null });
    expect(result.summary.notifications.delivered).toContain("observer-stalled");
    expect(result.summary.notifications.delivered).not.toContain("window-complete");
  });
});
