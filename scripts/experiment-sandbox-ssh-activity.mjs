#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { analyzePeriodicSshCoverage } from "./sandbox-activity-helpers.mjs";
import { classifySshProbe } from "./sandbox-observer-helpers.mjs";

const TARGET = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const mode = process.env.GROKBOX_SANDBOX_ACTIVITY_MODE;
const profile = process.env.GROKBOX_SANDBOX_PROFILE;
const evidenceDir = process.env.GROKBOX_SANDBOX_EVIDENCE_DIR;
const binary = process.env.GROKBOX_BIN ?? "grokbox";
const peer = process.env.GROKBOX_SANDBOX_PEER;
const sshTarget = process.env.GROKBOX_SANDBOX_SSH_TARGET;
const stimulusDurationMs = Number(process.env.GROKBOX_SANDBOX_STIMULUS_DURATION_MS ?? "0");
const withdrawalDurationMs = Number(process.env.GROKBOX_SANDBOX_WITHDRAWAL_DURATION_MS ?? "0");
const intervalMs = Number(process.env.GROKBOX_SANDBOX_INTERVAL_MS ?? "300000");
const observeEveryMs = Number(process.env.GROKBOX_SANDBOX_OBSERVE_EVERY_MS ?? "300000");
const commandTimeoutMs = Number(process.env.GROKBOX_SANDBOX_COMMAND_TIMEOUT_MS ?? "10000");
const terminationGraceMs = Number(process.env.GROKBOX_SANDBOX_TERMINATION_GRACE_MS ?? "2000");
const finalizeDelayMs = Number(process.env.GROKBOX_SANDBOX_FINALIZE_DELAY_MS ?? "0");
const allowShort = process.env.GROKBOX_SANDBOX_ALLOW_SHORT === "1";

function refuse(message) {
  console.error(message);
  process.exit(2);
}

if (mode !== "periodic-exec") refuse("Set GROKBOX_SANDBOX_ACTIVITY_MODE=periodic-exec.");
if (!profile) refuse("Set GROKBOX_SANDBOX_PROFILE to an existing Profile with read-state authority.");
if (!evidenceDir || !isAbsolute(evidenceDir)) {
  refuse("Set GROKBOX_SANDBOX_EVIDENCE_DIR to an absolute external-runner path.");
}
if (process.env.GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED !== "1") {
  refuse("Set GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED=1 only on the independently scheduled external runner.");
}
if (process.env.GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED !== "1") {
  refuse("Close Grok Bot.app, then set GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED=1.");
}
if (process.env.GROKBOX_SANDBOX_NONEXPERIMENT_SSH_CLOSED_CONFIRMED !== "1") {
  refuse("Close every non-experiment SSH and Mosh session, then confirm that precondition explicitly.");
}
if (!peer || !sshTarget || !TARGET.test(peer) || !TARGET.test(sshTarget)) {
  refuse("Set safe Sandbox peer and SSH target aliases for the external experiment.");
}
for (const [name, value] of [
  ["GROKBOX_SANDBOX_STIMULUS_DURATION_MS", stimulusDurationMs],
  ["GROKBOX_SANDBOX_WITHDRAWAL_DURATION_MS", withdrawalDurationMs],
]) {
  if (!Number.isSafeInteger(value) || value <= 0) refuse(`${name} must be a positive integer.`);
}
const minimumIntervalMs = allowShort ? 10 : 1000;
if (!Number.isSafeInteger(intervalMs) || intervalMs < minimumIntervalMs || intervalMs > 86_400_000) {
  refuse(`GROKBOX_SANDBOX_INTERVAL_MS must be an integer from ${minimumIntervalMs} to 86400000.`);
}
if (stimulusDurationMs % intervalMs !== 0) {
  refuse("GROKBOX_SANDBOX_STIMULUS_DURATION_MS must be an exact multiple of GROKBOX_SANDBOX_INTERVAL_MS.");
}
if (!Number.isSafeInteger(observeEveryMs) || observeEveryMs < minimumIntervalMs || observeEveryMs > 3_600_000) {
  refuse(`GROKBOX_SANDBOX_OBSERVE_EVERY_MS must be an integer from ${minimumIntervalMs} to 3600000.`);
}
if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < (allowShort ? 10 : 1000) || commandTimeoutMs > 60_000) {
  refuse("GROKBOX_SANDBOX_COMMAND_TIMEOUT_MS is outside its bounded range.");
}
if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < (allowShort ? 10 : 1000) || terminationGraceMs > 10_000) {
  refuse("GROKBOX_SANDBOX_TERMINATION_GRACE_MS is outside its bounded range.");
}
if (!Number.isSafeInteger(finalizeDelayMs) || finalizeDelayMs < 0 || finalizeDelayMs > 5000 || (!allowShort && finalizeDelayMs !== 0)) {
  refuse("GROKBOX_SANDBOX_FINALIZE_DELAY_MS is available only for bounded development tests.");
}
if (!allowShort && stimulusDurationMs < 2 * 60 * 60 * 1000) {
  refuse("The SSH activity stimulus must run for at least two hours.");
}
if (!allowShort && withdrawalDurationMs < 90 * 60 * 1000) {
  refuse("The passive withdrawal must run for at least 90 minutes.");
}

const runId = randomUUID();
const startedAtMs = Date.now();
const expectedStimulusTicks = stimulusDurationMs / intervalMs + 1;
const expectedWithdrawalSamples = Math.ceil(withdrawalDurationMs / observeEveryMs) + 1;
const observationCap = Math.min(1024, expectedStimulusTicks + expectedWithdrawalSamples + 8);
if (expectedStimulusTicks + expectedWithdrawalSamples + 2 > observationCap) {
  refuse("The requested experiment exceeds the bounded evidence observation capacity.");
}
const maximumLatenessMs = allowShort
  ? Math.max(250, Math.floor(intervalMs / 2))
  : Math.min(30_000, Math.max(5, Math.floor(intervalMs / 2)));
const shutdown = new AbortController();
let receivedSignal = null;
let completionCommitted = false;
let finalWritten = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (completionCommitted || finalWritten) return;
    receivedSignal = signal;
    shutdown.abort();
  });
}

const evidence = {
  version: 1,
  runId,
  experiment: "sandbox-ssh-activity",
  mode,
  roles: {
    observer: "independently-scheduled-external-runner",
    target: "cursor-sandbox",
  },
  runtime: {
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  },
  declarations: {
    appClosed: true,
    nonExperimentSshAndMoshClosed: true,
    externalRunner: true,
    providerLeaseEvidence: false,
    appFreeWake: false,
    automaticRecovery: false,
    modelTurnCalls: 0,
  },
  policy: {
    stimulusDurationMs,
    withdrawalDurationMs,
    intervalMs,
    observeEveryMs,
    expectedStimulusTicks,
    maximumLatenessMs,
    observationCap,
    evidenceClass: allowShort ? "development" : "qualification",
    qualificationEligible: !allowShort,
    remoteCommand: "fixed-noop",
    withdrawalPassiveUntilFreezeCandidate: true,
    checkpointStrategy: "immutable-per-observation",
    effectiveStartAtMs: null,
    stimulusStoppedAtMs: null,
    observedStimulusTicks: 0,
    successfulStimulusTicks: 0,
    continuousStimulusCoverage: false,
    childTerminationEscalations: 0,
    forcedChildSettlements: 0,
    terminationGraceMs,
  },
  observations: [],
  completedAtMs: null,
  outcome: "running",
  finding: "pending",
};

let lockPath;
let lockHandle;

function wait(ms) {
  if (shutdown.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(true), ms);
    const aborted = () => finish(false);
    const finish = (completed) => {
      clearTimeout(timer);
      shutdown.signal.removeEventListener("abort", aborted);
      resolve(completed);
    };
    shutdown.signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitUntilMonotonic(deadlineMs) {
  while (performance.now() < deadlineMs) {
    if (!(await wait(Math.max(1, deadlineMs - performance.now())))) return false;
  }
  return !shutdown.signal.aborted;
}

function parseJsonLine(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function run(file, args, timeoutMs = commandTimeoutMs) {
  return new Promise((resolve) => {
    if (shutdown.signal.aborted) {
      resolve({ ok: false, stdout: "", stderr: "", unavailable: false, timedOut: false, cancelled: true, escalated: false, forcedSettlement: false });
      return;
    }
    let child;
    try {
      child = spawn(file, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: "", unavailable: error?.code === "ENOENT", timedOut: false, cancelled: false, escalated: false, forcedSettlement: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let terminating = false;
    let escalated = false;
    let forcedSettlement = false;
    let settled = false;
    let killTimer;
    let forceTimer;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      shutdown.signal.removeEventListener("abort", abortChild);
      if (escalated) evidence.policy.childTerminationEscalations += 1;
      if (forcedSettlement) evidence.policy.forcedChildSettlements += 1;
      resolve({
        ok: code === 0 && !error && !overflow && !timedOut && !cancelled,
        stdout,
        stderr,
        unavailable: error?.code === "ENOENT",
        timedOut,
        cancelled,
        escalated,
        forcedSettlement,
      });
    };
    const terminate = (reason) => {
      if (terminating || settled) return;
      terminating = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        escalated = true;
        child.kill("SIGKILL");
      }, terminationGraceMs);
      forceTimer = setTimeout(() => {
        forcedSettlement = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null, new Error("Child process did not settle."));
      }, terminationGraceMs * 2);
    };
    const abortChild = () => terminate("cancelled");
    const deadlineTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    shutdown.signal.addEventListener("abort", abortChild, { once: true });
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes <= 1024 * 1024) stdout += text;
      else {
        overflow = true;
        terminate("overflow");
      }
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text);
      if (stderrBytes <= 64 * 1024) stderr += text;
    });
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code, null));
  });
}

async function productState() {
  const result = await run(binary, ["--profile", profile, "--timeout-ms", "30000", "box", "status"], Math.max(commandTimeoutMs, 45_000));
  const body = parseJsonLine(result.stdout.trim());
  const state = result.ok && body?.ok === true && typeof body.data?.state === "string"
    ? body.data.state
    : "unavailable";
  return { state, observedAtMs: Date.now() };
}

async function sshProbe() {
  const result = await run("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ControlMaster=no",
    sshTarget,
    "true",
  ]);
  return { sshStatus: classifySshProbe(result), observedAtMs: Date.now() };
}

async function tailnetProbe() {
  const result = await run("tailscale", ["ping", "--timeout=5s", "--c=1", peer]);
  return {
    tailnetProbeAvailable: result.unavailable !== true,
    tailnetReachable: result.unavailable === true ? null : result.ok,
    observedAtMs: Date.now(),
  };
}

async function ensureEvidenceDir() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
}

async function acquireLock() {
  await ensureEvidenceDir();
  lockPath = join(evidenceDir, ".sandbox-ssh-activity.lock");
  lockHandle = await open(lockPath, "wx", 0o600);
  await lockHandle.writeFile(`${JSON.stringify({ version: 1, runId, pid: process.pid })}\n`);
}

function pushObservation(value) {
  if (evidence.observations.length >= observationCap) {
    throw new Error("observation-cap-exhausted");
  }
  evidence.observations.push(value);
}

async function writeCheckpoint() {
  await ensureEvidenceDir();
  const sequence = String(evidence.observations.length).padStart(4, "0");
  const stem = `sandbox-ssh-activity-${runId}.checkpoint-${sequence}`;
  const temporaryPath = join(evidenceDir, `.${stem}.${randomUUID()}.tmp`);
  const checkpointPath = join(evidenceDir, `${stem}.json`);
  const checkpoint = {
    version: evidence.version,
    runId: evidence.runId,
    experiment: evidence.experiment,
    mode: evidence.mode,
    declarations: evidence.declarations,
    outcome: evidence.outcome,
    finding: evidence.finding,
    policy: {
      stimulusDurationMs: evidence.policy.stimulusDurationMs,
      withdrawalDurationMs: evidence.policy.withdrawalDurationMs,
      intervalMs: evidence.policy.intervalMs,
      evidenceClass: evidence.policy.evidenceClass,
      qualificationEligible: evidence.policy.qualificationEligible,
      effectiveStartAtMs: evidence.policy.effectiveStartAtMs,
      stimulusStoppedAtMs: evidence.policy.stimulusStoppedAtMs,
      withdrawalPassiveUntilFreezeCandidate: true,
    },
    sequence: evidence.observations.length,
    checkpointedAtMs: Date.now(),
    observation: evidence.observations.at(-1),
  };
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, checkpointPath);
}

async function record(value) {
  pushObservation(value);
  await writeCheckpoint();
}

async function writeFinal() {
  if (finalWritten) return null;
  const path = join(evidenceDir, `sandbox-ssh-activity-${runId}.json`);
  while (true) {
    evidence.completedAtMs = Date.now();
    const temporaryPath = join(evidenceDir, `.sandbox-ssh-activity-${runId}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (finalizeDelayMs > 0) await wait(finalizeDelayMs);
    if (shutdown.signal.aborted && evidence.finding !== "aborted") {
      await rm(temporaryPath, { force: true });
      evidence.outcome = "failed";
      evidence.finding = "aborted";
      evidence.policy.receivedSignal = receivedSignal;
      await record({
        kind: "terminal",
        outcome: evidence.outcome,
        finding: evidence.finding,
        observedAtMs: Date.now(),
      });
      continue;
    }
    completionCommitted = true;
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      completionCommitted = false;
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    finalWritten = true;
    return path;
  }
}

function isFreezeCandidate(state) {
  return state === "hibernated" || state === "absent";
}

async function confirmCandidate(stage, state, stimulusSequence = null, scheduledAtMs = null) {
  const [ssh, tailnet] = await Promise.all([sshProbe(), tailnetProbe()]);
  await record({
    kind: "candidate-confirmation",
    stage,
    state,
    stimulusSequence,
    scheduledAtMs,
    sshStatus: ssh.sshStatus,
    tailnetProbeAvailable: tailnet.tailnetProbeAvailable,
    tailnetReachable: tailnet.tailnetReachable,
    observedAtMs: Date.now(),
  });
  return ssh.sshStatus === "network-nonresponse";
}

async function runExperiment() {
  await acquireLock();

  const initialState = await productState();
  if (initialState.state !== "running") {
    await record({ kind: "preflight", state: initialState.state, sshStatus: null, observedAtMs: Date.now() });
    evidence.outcome = "failed";
    evidence.finding = "inconclusive";
    return;
  }

  const initialSsh = await sshProbe();
  if (initialSsh.sshStatus !== "reachable") {
    await record({
      kind: "preflight",
      state: initialState.state,
      sshStatus: initialSsh.sshStatus,
      observedAtMs: Date.now(),
    });
    evidence.outcome = "failed";
    evidence.finding = "inconclusive";
    return;
  }
  const effectiveStartAtMs = Date.now();
  const effectiveStartMonotonicMs = performance.now();
  evidence.policy.effectiveStartAtMs = effectiveStartAtMs;
  await record({
    kind: "stimulus",
    stage: "stimulus-hold",
    source: "preflight",
    stimulusSequence: 0,
    scheduledAtMs: effectiveStartAtMs,
    state: initialState.state,
    sshStatus: initialSsh.sshStatus,
    observedAtMs: effectiveStartAtMs,
  });

  const stimulusDeadlineAtMs = effectiveStartAtMs + stimulusDurationMs;
  for (let stimulusSequence = 1; stimulusSequence < expectedStimulusTicks; stimulusSequence += 1) {
    const scheduledAtMs = effectiveStartAtMs + stimulusSequence * intervalMs;
    const scheduledMonotonicMs = effectiveStartMonotonicMs + stimulusSequence * intervalMs;
    if (!(await waitUntilMonotonic(scheduledMonotonicMs))) return;
    const ssh = await sshProbe();
    const control = await productState();
    if (isFreezeCandidate(control.state)) {
      evidence.policy.stimulusStoppedAtMs = Date.now();
      const confirmed = await confirmCandidate("stimulus-hold", control.state, stimulusSequence, scheduledAtMs);
      evidence.outcome = confirmed ? "passed" : "failed";
      evidence.finding = confirmed ? "failed-to-hold" : "inconclusive";
      return;
    }
    await record({
      kind: "stimulus",
      stage: "stimulus-hold",
      source: "scheduled",
      stimulusSequence,
      scheduledAtMs,
      state: control.state,
      sshStatus: ssh.sshStatus,
      observedAtMs: Date.now(),
    });
    if (control.state !== "running") {
      evidence.outcome = "failed";
      evidence.finding = "inconclusive";
      return;
    }
    // Cursor running + SSH timeout is not freeze. Record and continue so a
    // transient network-nonresponse cannot abort the qualification window.
    // Auth/local SSH ambiguity remains inconclusive.
    if (ssh.sshStatus === "inconclusive") {
      evidence.outcome = "failed";
      evidence.finding = "inconclusive";
      return;
    }
  }

  const stimulusRecords = evidence.observations.filter((row) => row.kind === "stimulus");
  const coverage = analyzePeriodicSshCoverage(
    stimulusRecords,
    effectiveStartAtMs,
    stimulusDeadlineAtMs,
    intervalMs,
    maximumLatenessMs,
  );
  evidence.policy.observedStimulusTicks = coverage.observedTicks;
  evidence.policy.successfulStimulusTicks = coverage.successfulTicks;
  evidence.policy.continuousStimulusCoverage = coverage.continuousCoverage;
  evidence.policy.stimulusStoppedAtMs = Date.now();
  if (!coverage.continuousCoverage) {
    evidence.policy.qualificationEligible = false;
  }
  await record({
    kind: "stage-transition",
    from: "stimulus-hold",
    to: "passive-withdrawal",
    continuousStimulusCoverage: coverage.continuousCoverage,
    observedAtMs: Date.now(),
  });

  const withdrawalStartedAtMs = evidence.policy.stimulusStoppedAtMs;
  const withdrawalStartedMonotonicMs = performance.now();
  const withdrawalDeadlineMonotonicMs = withdrawalStartedMonotonicMs + withdrawalDurationMs;
  let releaseSequence = 0;
  while (performance.now() <= withdrawalDeadlineMonotonicMs) {
    if (shutdown.signal.aborted) return;
    const scheduledAtMs = withdrawalStartedAtMs + releaseSequence * observeEveryMs;
    const scheduledMonotonicMs = withdrawalStartedMonotonicMs + releaseSequence * observeEveryMs;
    if (!(await waitUntilMonotonic(Math.min(scheduledMonotonicMs, withdrawalDeadlineMonotonicMs)))) return;
    const control = await productState();
    if (isFreezeCandidate(control.state)) {
      const confirmed = await confirmCandidate("passive-withdrawal", control.state);
      const held = confirmed && evidence.policy.continuousStimulusCoverage;
      evidence.outcome = held ? "passed" : "failed";
      evidence.finding = confirmed
        ? (evidence.policy.continuousStimulusCoverage ? "supports-anti-idle" : "inconclusive")
        : "inconclusive";
      return;
    }
    await record({
      kind: "withdrawal",
      stage: "passive-withdrawal",
      releaseSequence,
      scheduledAtMs,
      state: control.state,
      observedAtMs: Date.now(),
    });
    if (control.state !== "running") {
      evidence.outcome = "failed";
      evidence.finding = "inconclusive";
      return;
    }
    releaseSequence += 1;
    if (performance.now() >= withdrawalDeadlineMonotonicMs) break;
  }
  evidence.outcome = "failed";
  evidence.finding = "incomplete";
}

let finalPath = null;
try {
  await runExperiment();
} catch (error) {
  evidence.outcome = "failed";
  evidence.finding = error?.message === "observation-cap-exhausted" ? "inconclusive" : "inconclusive";
} finally {
  if (shutdown.signal.aborted) {
    evidence.outcome = "failed";
    evidence.finding = "aborted";
    evidence.policy.receivedSignal = receivedSignal;
  }
  try {
    if (lockHandle) {
      await record({
        kind: "terminal",
        outcome: evidence.outcome,
        finding: evidence.finding,
        observedAtMs: Date.now(),
      });
      await lockHandle.close();
      try {
        finalPath = await writeFinal();
      } finally {
        if (lockPath) await rm(lockPath, { force: true });
      }
    }
  } catch {
    evidence.outcome = "failed";
    evidence.finding = "inconclusive";
    if (lockPath) await rm(lockPath, { force: true }).catch(() => {});
  }
}

console.log(JSON.stringify({
  ok: evidence.outcome === "passed",
  runId,
  finding: evidence.finding,
  ...(finalPath ? { evidence: finalPath } : {}),
}));
if (evidence.outcome !== "passed") process.exitCode = 1;
