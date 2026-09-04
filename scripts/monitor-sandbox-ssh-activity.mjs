#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const evidenceDir = process.env.GROKBOX_SANDBOX_EVIDENCE_DIR;
const notifyHook = process.env.GROKBOX_SANDBOX_NOTIFY_HOOK;
const durationMs = Number(process.env.GROKBOX_SANDBOX_MONITOR_DURATION_MS ?? "0");
const intervalMs = Number(process.env.GROKBOX_SANDBOX_MONITOR_INTERVAL_MS ?? "60000");
const stallMs = Number(process.env.GROKBOX_SANDBOX_MONITOR_STALL_MS ?? "480000");
const allowShort = process.env.GROKBOX_SANDBOX_MONITOR_ALLOW_SHORT === "1";
const minimumMs = allowShort ? 10 : 1000;

function refuse(message) {
  console.error(message);
  process.exit(2);
}

if (!evidenceDir || !isAbsolute(evidenceDir)) refuse("Set GROKBOX_SANDBOX_EVIDENCE_DIR to an absolute path.");
if (!notifyHook || !isAbsolute(notifyHook)) refuse("Set GROKBOX_SANDBOX_NOTIFY_HOOK to an absolute executable path.");
if (!Number.isSafeInteger(durationMs) || durationMs <= 0) refuse("Set a positive GROKBOX_SANDBOX_MONITOR_DURATION_MS.");
if (!Number.isSafeInteger(intervalMs) || intervalMs < minimumMs || intervalMs > 3_600_000) {
  refuse("GROKBOX_SANDBOX_MONITOR_INTERVAL_MS is outside its bounded range.");
}
if (!Number.isSafeInteger(stallMs) || stallMs < minimumMs || stallMs > 86_400_000) {
  refuse("GROKBOX_SANDBOX_MONITOR_STALL_MS is outside its bounded range.");
}

const EVENTS = Object.freeze({
  "monitor-ready": {
    title: "grokbox night harness ready",
    body: "Daytime staging and notification delivery passed; no experiment was started.",
  },
  "development-complete": {
    title: "grokbox development run complete",
    body: "A short development run completed; it is not lifecycle qualification evidence.",
  },
  "stimulus-started": {
    title: "grokbox night experiment started",
    body: "The controlled SSH activity stimulus has started.",
  },
  "stimulus-complete": {
    title: "grokbox stimulus complete",
    body: "Controlled SSH activity stopped; passive withdrawal is now running.",
  },
  "stimulus-degraded": {
    title: "grokbox SSH activity did not hold",
    body: "A confirmed freeze occurred during the controlled SSH activity window.",
  },
  "freeze-candidate": {
    title: "grokbox freeze candidate",
    body: "The experiment is checking a Cursor freeze candidate against strict SSH.",
  },
  "freeze-passed": {
    title: "grokbox SSH activity result",
    body: "Freeze followed complete stimulus withdrawal; the anti-idle hypothesis is supported.",
  },
  "experiment-incomplete": {
    title: "grokbox experiment incomplete",
    body: "No accepted freeze occurred before the passive withdrawal deadline.",
  },
  "experiment-inconclusive": {
    title: "grokbox experiment inconclusive",
    body: "The experiment ended without evidence strong enough for a lifecycle conclusion.",
  },
  "observer-stalled": {
    title: "grokbox experiment stalled",
    body: "No new protected experiment checkpoint arrived within the expected window.",
  },
  "evidence-malformed": {
    title: "grokbox evidence problem",
    body: "A protected experiment checkpoint could not be validated by the monitor.",
  },
  "manual-app-recovery-required": {
    title: "grokbox manual recovery required",
    body: "The box may be frozen. Leave it closed until morning, then reopen Grok Bot.app explicitly.",
  },
  "window-complete": {
    title: "grokbox night experiment complete",
    body: "The night experiment reached a terminal evidence state.",
  },
});

const monitorId = randomUUID();
const startedAtMs = Date.now();
const deadlineAtMs = startedAtMs + durationMs;
const pending = new Map();
const delivered = new Set();
const processed = new Set();
let runId = null;
let lastAdvanceAtMs = startedAtMs;
let terminal = null;
let finalArtifactObserved = false;
let terminalEventsQueued = false;
let malformed = false;
let aborted = false;
let lockPath;
let lockHandle;
let cancelWait = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    aborted = true;
    cancelWait?.();
  });
}

function wait(ms) {
  if (aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (cancelWait === finish) cancelWait = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    cancelWait = finish;
  });
}

function queue(event) {
  if (!EVENTS[event] || delivered.has(event) || pending.has(event)) return;
  pending.set(event, EVENTS[event]);
}

function runHook(event, notification) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(notifyHook, [], { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let killTimer;
    let forceTimer;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(forceTimer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        forceTimer = setTimeout(() => {
          child.stdin?.destroy();
          child.unref();
          finish(false);
        }, 2000);
      }, 2000);
    }, 10_000);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify({ version: 1, event, ...notification })}\n`);
  });
}

async function flush() {
  for (const [event, notification] of [...pending]) {
    if (await runHook(event, notification)) {
      pending.delete(event);
      delivered.add(event);
    }
  }
}

function terminalEvents(finding, qualificationEligible) {
  if (!qualificationEligible && (finding === "supports-anti-idle" || finding === "failed-to-hold")) {
    return ["development-complete", "window-complete"];
  }
  if (finding === "supports-anti-idle") {
    return ["freeze-passed", "manual-app-recovery-required", "window-complete"];
  }
  if (finding === "failed-to-hold") {
    return ["stimulus-degraded", "manual-app-recovery-required", "window-complete"];
  }
  if (finding === "incomplete") return ["experiment-incomplete", "window-complete"];
  return ["experiment-inconclusive", "window-complete"];
}

function validTerminal(outcome, finding) {
  if (finding === "supports-anti-idle" || finding === "failed-to-hold") return outcome === "passed";
  if (finding === "inconclusive" || finding === "incomplete" || finding === "aborted") return outcome === "failed";
  return false;
}

async function inspectCheckpoints() {
  let names;
  try {
    names = (await readdir(evidenceDir))
      .filter((name) => name.startsWith("sandbox-ssh-activity-") && name.includes(".checkpoint-") && name.endsWith(".json"))
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (processed.has(name)) continue;
    processed.add(name);
    let value;
    try {
      value = JSON.parse(await readFile(join(evidenceDir, name), "utf8"));
    } catch {
      malformed = true;
      queue("evidence-malformed");
      continue;
    }
    if (value?.version !== 1 || value?.experiment !== "sandbox-ssh-activity" || typeof value.runId !== "string" ||
      !Number.isSafeInteger(value.sequence) || !value.observation || typeof value.observation !== "object") {
      malformed = true;
      queue("evidence-malformed");
      continue;
    }
    if (runId === null) runId = value.runId;
    if (value.runId !== runId) continue;
    lastAdvanceAtMs = Date.now();
    const observation = value.observation;
    if (observation.kind === "stimulus" && observation.stimulusSequence === 0) queue("stimulus-started");
    if (observation.kind === "stage-transition" && observation.to === "passive-withdrawal") queue("stimulus-complete");
    if (observation.kind === "candidate-confirmation") queue("freeze-candidate");
    if (observation.kind === "terminal" && typeof observation.finding === "string") {
      if (!validTerminal(observation.outcome, observation.finding)) {
        malformed = true;
        queue("evidence-malformed");
        continue;
      }
      terminal = {
        outcome: observation.outcome,
        finding: observation.finding,
        qualificationEligible: value.policy?.qualificationEligible,
        observedAtMs: observation.observedAtMs,
      };
      if (typeof terminal.qualificationEligible !== "boolean") {
        terminal = null;
        malformed = true;
        queue("evidence-malformed");
      }
    }
  }
}

async function inspectFinalArtifact() {
  if (!runId || finalArtifactObserved) return;
  const path = join(evidenceDir, `sandbox-ssh-activity-${runId}.json`);
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    malformed = true;
    queue("evidence-malformed");
    return;
  }
  if (value?.version !== 1 || value?.experiment !== "sandbox-ssh-activity" || value?.runId !== runId ||
    !terminal || value.outcome !== terminal.outcome || value.finding !== terminal.finding ||
    value.policy?.qualificationEligible !== terminal.qualificationEligible) {
    malformed = true;
    queue("evidence-malformed");
    return;
  }
  finalArtifactObserved = true;
  if (!terminalEventsQueued) {
    terminalEventsQueued = true;
    for (const event of terminalEvents(terminal.finding, terminal.qualificationEligible)) queue(event);
  }
}

async function writeSummary() {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
  const summary = {
    version: 1,
    monitorId,
    experiment: "sandbox-ssh-activity-notifications",
    runObserved: runId !== null,
    terminal,
    finalArtifactObserved,
    malformedEvidenceObserved: malformed,
    aborted,
    notifications: {
      delivered: [...delivered],
      pending: [...pending.keys()],
    },
    startedAtMs,
    completedAtMs: Date.now(),
  };
  const stem = `sandbox-ssh-activity-monitor-${monitorId}`;
  const temporaryPath = join(evidenceDir, `.${stem}.${randomUUID()}.tmp`);
  const path = join(evidenceDir, `${stem}.json`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
  return { path, summary };
}

let result;
try {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await chmod(evidenceDir, 0o700);
  lockPath = join(evidenceDir, ".sandbox-ssh-activity-monitor.lock");
  lockHandle = await open(lockPath, "wx", 0o600);
  await lockHandle.writeFile(`${JSON.stringify({ version: 1, monitorId, pid: process.pid })}\n`);

  while (!aborted && Date.now() < deadlineAtMs) {
    await inspectCheckpoints();
    await inspectFinalArtifact();
    if (!terminal && Date.now() - lastAdvanceAtMs >= stallMs) queue("observer-stalled");
    await flush();
    if (terminal && finalArtifactObserved && pending.size === 0) break;
    await wait(Math.min(intervalMs, Math.max(1, deadlineAtMs - Date.now())));
  }
  if (terminal && !finalArtifactObserved) {
    malformed = true;
    queue("evidence-malformed");
  }
  if (!terminal) {
    queue(aborted ? "experiment-inconclusive" : "observer-stalled");
  }
  await flush();
  result = await writeSummary();
} finally {
  if (lockHandle) await lockHandle.close().catch(() => {});
  if (lockPath) await rm(lockPath, { force: true }).catch(() => {});
}

console.log(JSON.stringify({
  ok: terminal !== null && finalArtifactObserved && pending.size === 0 && !malformed && !aborted,
  summary: result?.path ?? null,
  delivered: delivered.size,
  pending: pending.size,
}));
if (!terminal || !finalArtifactObserved || pending.size > 0 || malformed || aborted) process.exitCode = 1;
