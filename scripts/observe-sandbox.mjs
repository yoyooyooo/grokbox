#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  analyzeLeaseCoverage,
  classifySshProbe,
  projectSandboxFailure,
} from "./sandbox-observer-helpers.mjs";

const PHASES = new Set(["reachability", "lease", "stop-observe", "wake-recover"]);
const EXTERNAL_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const phase = process.env.GROKBOX_SANDBOX_PHASE;
const profile = process.env.GROKBOX_SANDBOX_PROFILE;
const evidenceDir = process.env.GROKBOX_SANDBOX_EVIDENCE_DIR;
const binary = process.env.GROKBOX_BIN ?? "grokbox";
const durationMs = Number(process.env.GROKBOX_SANDBOX_DURATION_MS ?? "0");
const intervalMs = Number(process.env.GROKBOX_SANDBOX_INTERVAL_MS ?? "600000");
const observeEveryMs = Number(process.env.GROKBOX_SANDBOX_OBSERVE_EVERY_MS ?? "60000");
const peer = process.env.GROKBOX_SANDBOX_PEER;
const sshTarget = process.env.GROKBOX_SANDBOX_SSH_TARGET;
const expectedSsh = process.env.GROKBOX_SANDBOX_EXPECT_SSH;
const allowShort = process.env.GROKBOX_SANDBOX_ALLOW_SHORT === "1";
const needsProduct = phase !== "reachability";
const needsReachability = phase === "reachability" || phase === "stop-observe" || phase === "wake-recover";

function refuse(message) {
  console.error(message);
  process.exit(2);
}

if (!phase || !PHASES.has(phase)) {
  refuse("Set GROKBOX_SANDBOX_PHASE to reachability, lease, stop-observe, or wake-recover.");
}
if (needsProduct && !profile) refuse("Set GROKBOX_SANDBOX_PROFILE to an existing Profile with sandbox.access_token_ref.");
if (!evidenceDir || !isAbsolute(evidenceDir)) refuse("Set GROKBOX_SANDBOX_EVIDENCE_DIR to an absolute external-runner path.");
if (process.env.GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED !== "1") {
  refuse("Set GROKBOX_SANDBOX_EXTERNAL_RUNNER_CONFIRMED=1 only on the independently scheduled external runner.");
}
if (needsProduct && process.env.GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED !== "1") {
  refuse("Close Grok Bot.app, then set GROKBOX_SANDBOX_APP_CLOSED_CONFIRMED=1.");
}
if (!Number.isSafeInteger(durationMs) || durationMs <= 0) refuse("Set a positive integer GROKBOX_SANDBOX_DURATION_MS.");
if (!allowShort && phase === "lease" && durationMs < 2 * 60 * 60 * 1000) {
  refuse("The lease qualification phase must run for at least two hours.");
}
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86_400_000) {
  refuse("GROKBOX_SANDBOX_INTERVAL_MS must be an integer from 1000 to 86400000.");
}
if (!Number.isSafeInteger(observeEveryMs) || observeEveryMs < 1000 || observeEveryMs > 3_600_000) {
  refuse("GROKBOX_SANDBOX_OBSERVE_EVERY_MS must be an integer from 1000 to 3600000.");
}
if (needsReachability && (!peer || !sshTarget)) {
  refuse("Set GROKBOX_SANDBOX_PEER and GROKBOX_SANDBOX_SSH_TARGET for external reachability observations.");
}
if (needsReachability && (!EXTERNAL_TARGET.test(peer) || !EXTERNAL_TARGET.test(sshTarget))) {
  refuse("Sandbox peer and SSH target must be safe host names, user@host values, or configured aliases.");
}
if (phase === "reachability" && expectedSsh !== "reachable" && expectedSsh !== "unreachable") {
  refuse("Set GROKBOX_SANDBOX_EXPECT_SSH to reachable or unreachable for the reachability phase.");
}

const runId = randomUUID();
const startedAtMs = Date.now();
const maxObservations = Math.min(1024, Math.ceil(durationMs / observeEveryMs) + 8);
const expectedMinimumTicks = phase === "lease"
  ? Math.max(1, Math.ceil(durationMs / Math.round(intervalMs * 1.1)))
  : 0;
if (expectedMinimumTicks > maxObservations) {
  refuse("The requested lease interval exceeds the bounded evidence observation capacity.");
}
const evidence = {
  version: 3,
  runId,
  phase,
  roles: {
    observer: "independently-scheduled-external-runner",
    target: "cursor-sandbox",
  },
  runtime: {
    platform: process.platform,
    nodeMajor: Number(process.versions.node.split(".")[0]),
  },
  declarations: {
    appClosed: needsProduct ? true : null,
    externalRunner: true,
    modelTurnKeeperCalls: 0,
  },
  policy: {
    requestedDurationMs: durationMs,
    keeperIntervalMs: phase === "lease" ? intervalMs : null,
    expectedMinimumTicks: phase === "lease" ? expectedMinimumTicks : null,
    expectedSsh: phase === "reachability" ? expectedSsh : null,
    observationCap: maxObservations,
    passiveUntilFreezeCandidate: phase === "stop-observe" ? true : null,
    checkpointStrategy: phase === "stop-observe" ? "immutable-per-sample" : null,
  },
  observations: [],
  completedAtMs: null,
  outcome: "running",
};

function boundedPush(value) {
  if (evidence.observations.length < maxObservations) evidence.observations.push(value);
}

function parseJsonLine(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function run(file, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        ok: false,
        stdout: "",
        stderr: "",
        unavailable: error?.code === "ENOENT",
        timedOut: false,
        exitCode: null,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let terminating = false;
    let settled = false;
    let killTimer;
    let forceTimer;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      resolve({
        ok: code === 0 && !error && !overflow && !timedOut,
        stdout,
        stderr,
        unavailable: error?.code === "ENOENT",
        timedOut,
        exitCode: Number.isInteger(code) ? code : null,
      });
    };
    const terminate = (forTimeout) => {
      if (terminating || settled) return;
      terminating = true;
      timedOut = forTimeout;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finish(null, new Error("Child process did not close after SIGKILL."));
      }, 4_000);
    };
    const deadlineTimer = setTimeout(() => terminate(true), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes <= 1024 * 1024) stdout += text;
      else {
        overflow = true;
        terminate(false);
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

async function product(args, timeoutMs) {
  return await run(binary, ["--profile", profile, ...args], timeoutMs);
}

async function tailnetReachability() {
  const result = await run("tailscale", ["ping", "--timeout=5s", "--c=1", peer], 10_000);
  return {
    tailnetProbeAvailable: result.unavailable !== true,
    tailnetReachable: result.unavailable === true ? null : result.ok,
  };
}

async function sshReachability() {
  const result = await run("ssh", [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=yes",
    sshTarget,
    "true",
  ], 10_000);
  const status = classifySshProbe(result);
  return { sshStatus: status, sshReachable: status === "reachable" };
}

async function observeReachability() {
  const [tailnet, ssh] = await Promise.all([tailnetReachability(), sshReachability()]);
  return { ...tailnet, ...ssh, observedAtMs: Date.now() };
}

async function observeControlState() {
  const status = await product(["--timeout-ms", "30000", "box", "status"], 45_000);
  const body = parseJsonLine(status.stdout.trim());
  const state = status.ok && body?.ok === true && typeof body.data?.state === "string"
    ? body.data.state
    : "unavailable";
  return { state, observedAtMs: Date.now() };
}

async function ensureEvidenceDir() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
}

async function writeCheckpoint() {
  await ensureEvidenceDir();
  const sequence = String(evidence.observations.length).padStart(4, "0");
  const stem = `sandbox-${phase}-${runId}.checkpoint-${sequence}`;
  const temporaryPath = join(evidenceDir, `.${stem}.${randomUUID()}.tmp`);
  const checkpointPath = join(evidenceDir, `${stem}.json`);
  const checkpoint = {
    version: evidence.version,
    runId: evidence.runId,
    phase: evidence.phase,
    roles: evidence.roles,
    runtime: evidence.runtime,
    declarations: evidence.declarations,
    outcome: evidence.outcome,
    policy: {
      passiveUntilFreezeCandidate: evidence.policy.passiveUntilFreezeCandidate,
      checkpointStrategy: evidence.policy.checkpointStrategy,
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

async function writeEvidence() {
  await ensureEvidenceDir();
  const path = join(evidenceDir, `sandbox-${phase}-${runId}.json`);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  console.log(JSON.stringify({ ok: evidence.outcome === "passed", evidence: path, runId }));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNextObservation(deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= observeEveryMs) return false;
  await wait(observeEveryMs);
  return true;
}

function childSettlement(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ code: null, signal: null, spawnError: true }));
    child.once("close", (code, signal) => finish({ code, signal, spawnError: false }));
  });
}

async function terminateChild(child, settled) {
  child.kill("SIGTERM");
  const afterTerm = await Promise.race([settled, wait(2_000).then(() => null)]);
  if (afterTerm) return { ...afterTerm, escalated: false, forcedSettlement: false };
  child.kill("SIGKILL");
  const afterKill = await Promise.race([settled, wait(2_000).then(() => null)]);
  if (afterKill) return { ...afterKill, escalated: true, forcedSettlement: false };
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return { code: null, signal: "SIGKILL", spawnError: false, escalated: true, forcedSettlement: true };
}

async function runLease() {
  let child;
  try {
    child = spawn(binary, [
      "--profile", profile,
      "--timeout-ms", "30000",
      "box", "keepalive", "run",
      "--interval-ms", String(intervalMs),
    ], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    evidence.outcome = "failed";
    return;
  }
  const settled = childSettlement(child);
  let buffer = "";
  let outputOverflow = false;
  let triggerOverflow;
  const overflow = new Promise((resolve) => { triggerOverflow = resolve; });
  let stderrBytes = 0;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      outputOverflow = true;
      buffer = "";
      triggerOverflow({ overflow: true });
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = parseJsonLine(line);
      const state = parsed?.ok === true && parsed.data && typeof parsed.data === "object" ? parsed.data : null;
      if (!state || (state.status !== "healthy" && state.status !== "degraded" && state.status !== "stopped")) continue;
      boundedPush({
        kind: "keeper",
        status: state.status,
        tickCount: Number.isSafeInteger(state.tickCount) ? state.tickCount : null,
        failure: projectSandboxFailure(state.lastFailure),
        descriptorRotated: typeof state.descriptorRotated === "boolean" ? state.descriptorRotated : null,
        observedAtMs: Date.now(),
      });
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderrBytes = Math.min(stderrBytes + Buffer.byteLength(chunk), 1024 * 1024);
  });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ deadline: true }), durationMs);
  });
  const first = await Promise.race([
    settled.then((result) => ({ deadline: false, child: result })),
    deadline,
    overflow,
  ]);
  let result;
  if (first.deadline === true || first.overflow === true) {
    result = await terminateChild(child, settled);
  } else {
    clearTimeout(timer);
    result = { ...first.child, escalated: false, forcedSettlement: false };
  }
  clearTimeout(timer);
  evidence.policy.stderrObservedBytes = stderrBytes;
  const tickRecords = evidence.observations.filter((row) =>
    row.kind === "keeper" && (row.status === "healthy" || row.status === "degraded"));
  const maximumTickGapMs = Math.max(Math.round(intervalMs * 1.5), 120_000);
  const coverage = analyzeLeaseCoverage(tickRecords, startedAtMs, Date.now(), maximumTickGapMs);
  evidence.policy.observedTicks = coverage.observedTicks;
  evidence.policy.healthyTicks = coverage.healthyTicks;
  evidence.policy.maximumTickGapMs = maximumTickGapMs;
  evidence.policy.continuousCoverage = coverage.continuousCoverage;
  evidence.policy.tickSequenceValid = coverage.sequenceValid;
  evidence.policy.terminationEscalated = result.escalated;
  evidence.policy.forcedSettlement = result.forcedSettlement;
  evidence.outcome = first.deadline === true && !outputOverflow && coverage.continuousCoverage &&
    coverage.observedTicks >= evidence.policy.expectedMinimumTicks &&
    coverage.healthyTicks >= evidence.policy.expectedMinimumTicks &&
    result.spawnError !== true && result.escalated === false && result.forcedSettlement === false &&
    (result.code === 0 || result.signal === "SIGTERM") ? "passed" : "failed";
}

async function runReachability() {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline && evidence.observations.length < maxObservations) {
    boundedPush({ kind: "reachability", ...await observeReachability() });
    if (!await waitForNextObservation(deadline)) break;
  }
  const observations = evidence.observations.filter((row) => row.kind === "reachability");
  const matches = expectedSsh === "reachable"
    ? observations.every((row) => row.sshStatus === "reachable")
    : observations.every((row) => row.sshStatus === "network-nonresponse");
  evidence.policy.sshIsAuthoritativeReachabilityProbe = true;
  evidence.policy.observedReachabilitySamples = observations.length;
  evidence.outcome = observations.length > 0 && matches ? "passed" : "failed";
}

async function runStopObservation() {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline && evidence.observations.length < maxObservations) {
    const control = await observeControlState();
    const freezeCandidate = control.state === "hibernated" || control.state === "absent";
    const observation = freezeCandidate
      ? { kind: "stop", ...control, ...await observeReachability() }
      : { kind: "stop", ...control };
    boundedPush(observation);
    await writeCheckpoint();
    if (freezeCandidate && observation.sshStatus === "network-nonresponse") {
      evidence.outcome = "passed";
      return;
    }
    if (!await waitForNextObservation(deadline)) break;
  }
  evidence.outcome = "failed";
}

async function runWakeRecovery() {
  const wakeStartedAtMs = Date.now();
  const wake = await product(["--timeout-ms", "60000", "box", "wake"], 90_000);
  boundedPush({ kind: "wake", ok: wake.ok, observedAtMs: Date.now() });
  if (!wake.ok) {
    evidence.outcome = "failed";
    return;
  }
  const recovery = await product(["--timeout-ms", "120000", "recover"], 150_000);
  boundedPush({ kind: "recover", ok: recovery.ok, observedAtMs: Date.now() });
  const deadline = startedAtMs + durationMs;
  while (Date.now() < deadline && evidence.observations.length < maxObservations) {
    const reachability = await observeReachability();
    const daemon = reachability.sshReachable
      ? await product(["--timeout-ms", "30000", "daemon", "status"], 45_000)
      : { ok: false, stdout: "" };
    const doctor = daemon.ok
      ? await product(["--timeout-ms", "30000", "doctor"], 45_000)
      : { ok: false, stdout: "" };
    const doctorBody = parseJsonLine(doctor.stdout.trim());
    const doctorHealthy = doctor.ok && doctorBody?.ok === true && doctorBody.data?.ok === true;
    boundedPush({
      kind: "recovery",
      tailnetProbeAvailable: reachability.tailnetProbeAvailable,
      tailnetReachable: reachability.tailnetReachable,
      sshReachable: reachability.sshReachable,
      daemonReachable: daemon.ok,
      doctorHealthy,
      elapsedMs: Date.now() - wakeStartedAtMs,
      observedAtMs: Date.now(),
    });
    if (recovery.ok && reachability.sshReachable && daemon.ok && doctorHealthy) {
      evidence.outcome = "passed";
      return;
    }
    if (!await waitForNextObservation(deadline)) break;
  }
  evidence.outcome = "failed";
}

try {
  if (phase === "reachability") await runReachability();
  else if (phase === "lease") await runLease();
  else if (phase === "stop-observe") await runStopObservation();
  else await runWakeRecovery();
} catch {
  evidence.outcome = "failed";
} finally {
  evidence.completedAtMs = Date.now();
  await writeEvidence();
}

if (evidence.outcome !== "passed") process.exitCode = 1;
