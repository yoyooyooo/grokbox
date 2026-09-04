import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzePeriodicSshCoverage } from "../scripts/sandbox-activity-helpers.mjs";

const experiment = join(import.meta.dir, "..", "scripts", "experiment-sandbox-ssh-activity.mjs");

async function fileLineCount(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function fixture(options: {
  states?: string[];
  ssh?: string[];
  stimulusMs?: number;
  withdrawalMs?: number;
  intervalMs?: number;
  observeMs?: number;
  omitClosure?: boolean;
  terminationGraceMs?: number;
  commandTimeoutMs?: number;
  allowShort?: boolean;
  signalAfterFirstCheckpoint?: boolean;
  signalAfterTerminalCheckpoint?: boolean;
  finalizeDelayMs?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "grokbox-ssh-activity-test-"));
  const evidenceDir = join(root, "evidence");
  const binDir = join(root, "bin");
  const productMarker = join(root, "product.calls");
  const sshMarker = join(root, "ssh.calls");
  const tailnetMarker = join(root, "tailnet.calls");
  await mkdir(binDir, { recursive: true });

  const fakeProduct = join(binDir, "grokbox");
  const fakeSsh = join(binDir, "ssh");
  const fakeTailscale = join(binDir, "tailscale");
  await writeFile(fakeProduct, `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.FAKE_PRODUCT_MARKER;
let count = 0;
try { count = fs.readFileSync(marker, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
fs.appendFileSync(marker, String(count) + "\\n");
const states = JSON.parse(process.env.FAKE_STATE_PLAN);
const state = states[Math.min(count, states.length - 1)];
process.stdout.write(JSON.stringify({ok:true,data:{state}}) + "\\n");
`, { mode: 0o700 });
  const fakeSshSource = options.ssh?.length === 1 && options.ssh[0] === "hang"
    ? `#!/bin/sh
printf '0\\n' >> ${JSON.stringify(sshMarker)}
trap '' TERM
while :; do :; done
`
    : `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.env.FAKE_SSH_MARKER;
let count = 0;
try { count = fs.readFileSync(marker, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
fs.appendFileSync(marker, String(count) + "\\n");
const plan = JSON.parse(process.env.FAKE_SSH_PLAN);
const action = plan[Math.min(count, plan.length - 1)];
if (action === "timeout") { process.stderr.write("ssh: connect to host secret-target port 22: Operation timed out\\n"); process.exit(255); }
if (action === "auth") { process.stderr.write("Permission denied for secret-target (publickey)\\n"); process.exit(255); }
process.exit(0);
`;
  await writeFile(fakeSsh, fakeSshSource, { mode: 0o700 });
  await writeFile(fakeTailscale, `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FAKE_TAILNET_MARKER, "x\\n");
process.exit(1);
`, { mode: 0o700 });
  await Promise.all([chmod(fakeProduct, 0o700), chmod(fakeSsh, 0o700), chmod(fakeTailscale, 0o700)]);

  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    GROKBOX_BIN: fakeProduct,
    GROKBOX_SANDBOX_ACTIVITY_MODE: "periodic-exec",
    GROKBOX_SANDBOX_PROFILE: "secret-profile",
    GROKBOX_SANDBOX_EVIDENCE_DIR: evidenceDir,
    GROKBOX_SANDBOX_PEER: "secret-peer",
    GROKBOX_SANDBOX_SSH_TARGET: "secret-target",
    GROKBOX_SANDBOX_STIMULUS_DURATION_MS: String(options.stimulusMs ?? 40),
    GROKBOX_SANDBOX_WITHDRAWAL_DURATION_MS: String(options.withdrawalMs ?? 40),
    GROKBOX_SANDBOX_INTERVAL_MS: String(options.intervalMs ?? 20),
    GROKBOX_SANDBOX_OBSERVE_EVERY_MS: String(options.observeMs ?? 20),
    GROKBOX_SANDBOX_COMMAND_TIMEOUT_MS: String(options.commandTimeoutMs ?? 1000),
    GROKBOX_SANDBOX_TERMINATION_GRACE_MS: String(options.terminationGraceMs ?? 20),
    GROKBOX_SANDBOX_FINALIZE_DELAY_MS: String(options.finalizeDelayMs ?? 0),
    GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED: "1",
    GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED: "1",
    FAKE_PRODUCT_MARKER: productMarker,
    FAKE_SSH_MARKER: sshMarker,
    FAKE_TAILNET_MARKER: tailnetMarker,
    FAKE_STATE_PLAN: JSON.stringify(options.states ?? ["running"]),
    FAKE_SSH_PLAN: JSON.stringify(options.ssh ?? ["reachable"]),
  };
  if (!options.omitClosure) env.GROKBOX_SANDBOX_NONEXPERIMENT_SSH_CLOSED_CONFIRMED = "1";
  if (options.allowShort !== false) env.GROKBOX_SANDBOX_ALLOW_SHORT = "1";

  const child = Bun.spawn([process.execPath, experiment], { env, stdout: "pipe", stderr: "pipe" });
  if (options.signalAfterFirstCheckpoint || options.signalAfterTerminalCheckpoint) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const current = await readdir(evidenceDir).catch(() => [] as string[]);
      let shouldSignal = options.signalAfterFirstCheckpoint && current.some((name) => name.includes(".checkpoint-"));
      if (options.signalAfterTerminalCheckpoint) {
        for (const name of current.filter((entry) => entry.includes(".checkpoint-") && entry.endsWith(".json"))) {
          const value = await readFile(join(evidenceDir, name), "utf8").then(JSON.parse).catch(() => null);
          if (value?.observation?.kind === "terminal") shouldSignal = true;
        }
      }
      if (shouldSignal) {
        child.kill("SIGTERM");
        break;
      }
      await Bun.sleep(10);
    }
  }
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const files = await readdir(evidenceDir).catch(() => [] as string[]);
  const finalName = files.find((name) => name.startsWith("sandbox-ssh-activity-") && name.endsWith(".json") && !name.includes(".checkpoint-"));
  const artifact = finalName ? JSON.parse(await readFile(join(evidenceDir, finalName), "utf8")) : null;
  return {
    root,
    evidenceDir,
    code,
    stdout,
    stderr,
    artifact,
    files,
    productCalls: await fileLineCount(productMarker),
    sshCalls: await fileLineCount(sshMarker),
    tailnetCalls: await fileLineCount(tailnetMarker),
  };
}

describe("Sandbox SSH activity experiment", () => {
  test("coverage analysis rejects missing, late, and non-running periodic samples", () => {
    const valid = [
      { stimulusSequence: 0, scheduledAtMs: 0, observedAtMs: 0, sshStatus: "reachable", state: "running" },
      { stimulusSequence: 1, scheduledAtMs: 100, observedAtMs: 120, sshStatus: "reachable", state: "running" },
      { stimulusSequence: 2, scheduledAtMs: 200, observedAtMs: 210, sshStatus: "reachable", state: "running" },
    ];
    expect(analyzePeriodicSshCoverage(valid, 0, 200, 100, 30)).toEqual({
      expectedTicks: 3,
      observedTicks: 3,
      successfulTicks: 3,
      continuousCoverage: true,
    });
    expect(analyzePeriodicSshCoverage(valid.slice(0, 2), 0, 200, 100, 30).continuousCoverage).toBe(false);
    expect(analyzePeriodicSshCoverage(valid.map((row, index) => index === 1 ? { ...row, observedAtMs: 131 } : row), 0, 200, 100, 30).continuousCoverage).toBe(false);
    expect(analyzePeriodicSshCoverage(valid.map((row, index) => index === 1 ? { ...row, state: "hibernated" } : row), 0, 200, 100, 30).continuousCoverage).toBe(false);
  });

  test("refuses missing closure declaration before filesystem or SSH activity", async () => {
    const result = await fixture({ omitClosure: true });
    expect(result.code).toBe(2);
    expect(result.files).toHaveLength(0);
    expect(result.productCalls).toBe(0);
    expect(result.sshCalls).toBe(0);
    expect(result.stderr).toContain("Close every non-experiment SSH and Mosh session");
  });

  test("refuses qualification windows below two hours and 90 minutes without the development override", async () => {
    const result = await fixture({
      allowShort: false,
      stimulusMs: 1000,
      withdrawalMs: 1000,
      intervalMs: 1000,
      observeMs: 1000,
      commandTimeoutMs: 1000,
      terminationGraceMs: 1000,
    });
    expect(result.code).toBe(2);
    expect(result.files).toHaveLength(0);
    expect(result.productCalls).toBe(0);
    expect(result.sshCalls).toBe(0);
    expect(result.stderr).toContain("at least two hours");
  });

  test("stops before SSH when read-state preflight is unavailable", async () => {
    const result = await fixture({ states: ["unavailable"] });
    expect(result.code).toBe(1);
    expect(result.productCalls).toBe(1);
    expect(result.sshCalls).toBe(0);
    expect(result.tailnetCalls).toBe(0);
    expect(result.artifact).toMatchObject({ outcome: "failed", finding: "inconclusive" });
  });

  test("supports anti-idle only after complete stimulus and two-factor withdrawal freeze", async () => {
    const result = await fixture({
      states: ["running", "running", "running", "hibernated"],
      ssh: ["reachable", "reachable", "reachable", "timeout"],
    });
    expect(result.code).toBe(0);
    expect(result.artifact).toMatchObject({
      outcome: "passed",
      finding: "supports-anti-idle",
      declarations: {
        appClosed: true,
        nonExperimentSshAndMoshClosed: true,
        providerLeaseEvidence: false,
        appFreeWake: false,
        automaticRecovery: false,
      },
      policy: {
        expectedStimulusTicks: 3,
        observedStimulusTicks: 3,
        successfulStimulusTicks: 3,
        continuousStimulusCoverage: true,
        evidenceClass: "development",
        qualificationEligible: false,
        withdrawalPassiveUntilFreezeCandidate: true,
      },
    });
    expect(result.sshCalls).toBe(4);
    expect(result.tailnetCalls).toBe(1);
    const withdrawal = result.artifact.observations.filter((row: any) => row.kind === "withdrawal");
    expect(withdrawal).toHaveLength(0);
    expect(result.artifact.observations).toContainEqual(expect.objectContaining({
      kind: "candidate-confirmation",
      stage: "passive-withdrawal",
      state: "hibernated",
      sshStatus: "network-nonresponse",
    }));
  });

  test("records a confirmed freeze during stimulus as valid negative evidence", async () => {
    const result = await fixture({
      states: ["running", "hibernated"],
      ssh: ["reachable", "reachable", "timeout"],
    });
    expect(result.code).toBe(0);
    expect(result.artifact).toMatchObject({ outcome: "passed", finding: "failed-to-hold" });
    expect(result.artifact.observations).toContainEqual(expect.objectContaining({
      kind: "candidate-confirmation",
      stage: "stimulus-hold",
      sshStatus: "network-nonresponse",
    }));
    expect(result.tailnetCalls).toBe(1);
  });

  test("keeps withdrawal passive while state remains running and reports incomplete", async () => {
    const result = await fixture();
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({ outcome: "failed", finding: "incomplete" });
    expect(result.sshCalls).toBe(3);
    expect(result.tailnetCalls).toBe(0);
    const withdrawal = result.artifact.observations.filter((row: any) => row.kind === "withdrawal");
    expect(withdrawal.length).toBeGreaterThanOrEqual(1);
    for (const row of withdrawal) {
      expect(row.state).toBe("running");
      expect(row).not.toHaveProperty("sshStatus");
      expect(row).not.toHaveProperty("tailnetReachable");
    }
  });

  test("Cursor running plus SSH timeout continues the window instead of aborting", async () => {
    const result = await fixture({
      ssh: ["reachable", "timeout", "reachable"],
    });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      outcome: "failed",
      finding: "incomplete",
      policy: {
        continuousStimulusCoverage: false,
        qualificationEligible: false,
      },
    });
    expect(result.artifact.observations).toContainEqual(expect.objectContaining({
      kind: "stimulus",
      sshStatus: "network-nonresponse",
      state: "running",
    }));
    expect(result.artifact.observations.some((row: { kind: string }) => row.kind === "withdrawal")).toBe(true);
    expect(result.artifact.observations.some((row: { kind: string }) => row.kind === "candidate-confirmation")).toBe(false);
    expect(result.tailnetCalls).toBe(0);
  });

  test("authentication ambiguity is inconclusive and redacted", async () => {
    const result = await fixture({ ssh: ["auth"] });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({ outcome: "failed", finding: "inconclusive" });
    const serialized = JSON.stringify(result.artifact);
    for (const forbidden of ["secret-profile", "secret-peer", "secret-target", "Permission denied", "publickey"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("a withdrawal candidate with authentication failure remains inconclusive", async () => {
    const result = await fixture({
      states: ["running", "running", "running", "hibernated"],
      ssh: ["reachable", "reachable", "reachable", "auth"],
    });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({ outcome: "failed", finding: "inconclusive" });
    expect(result.artifact.observations).toContainEqual(expect.objectContaining({
      kind: "candidate-confirmation",
      stage: "passive-withdrawal",
      sshStatus: "inconclusive",
    }));
  });

  test("writes immutable protected checkpoints, a terminal checkpoint, and a protected final artifact", async () => {
    const result = await fixture();
    expect((await stat(result.evidenceDir)).mode & 0o777).toBe(0o700);
    const checkpoints = result.files.filter((name) => name.includes(".checkpoint-") && name.endsWith(".json"));
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    for (const name of checkpoints) expect((await stat(join(result.evidenceDir, name))).mode & 0o777).toBe(0o600);
    const finalName = result.files.find((name) => name.endsWith(".json") && !name.includes(".checkpoint-"));
    expect(finalName).toBeDefined();
    expect((await stat(join(result.evidenceDir, finalName!))).mode & 0o777).toBe(0o600);
    expect(result.artifact.observations.at(-1)).toMatchObject({
      kind: "terminal",
      outcome: "failed",
      finding: "incomplete",
    });
    expect(result.files).not.toContain(".sandbox-ssh-activity.lock");
  });

  test("settles SIGTERM as aborted evidence and removes the experiment lock", async () => {
    const result = await fixture({
      stimulusMs: 10_000,
      intervalMs: 1000,
      withdrawalMs: 1000,
      observeMs: 1000,
      signalAfterFirstCheckpoint: true,
    });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      outcome: "failed",
      finding: "aborted",
      policy: { receivedSignal: "SIGTERM" },
    });
    expect(result.artifact.observations.at(-1)).toMatchObject({
      kind: "terminal",
      outcome: "failed",
      finding: "aborted",
    });
    expect(result.files).not.toContain(".sandbox-ssh-activity.lock");
  });

  test("downgrades a signal during finalization before committing the final artifact", async () => {
    const result = await fixture({
      states: ["running", "running", "running", "hibernated"],
      ssh: ["reachable", "reachable", "reachable", "timeout"],
      signalAfterTerminalCheckpoint: true,
      finalizeDelayMs: 500,
    });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      outcome: "failed",
      finding: "aborted",
      policy: { receivedSignal: "SIGTERM", qualificationEligible: false },
    });
    const terminals = result.artifact.observations.filter((row: any) => row.kind === "terminal");
    expect(terminals.at(-1)).toMatchObject({ outcome: "failed", finding: "aborted" });
    expect(result.files.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  test("bounds an uncooperative SSH child and cannot turn it into supporting evidence", async () => {
    const result = await fixture({ ssh: ["hang"], commandTimeoutMs: 1000, terminationGraceMs: 100 });
    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      outcome: "failed",
      finding: "inconclusive",
      policy: { childTerminationEscalations: 1, forcedChildSettlements: 0 },
    });
  });
});
