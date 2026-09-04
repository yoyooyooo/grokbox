#!/usr/bin/env node

import { spawn } from "node:child_process";

const CONTROLLER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const controller = process.env.GROKBOX_SANDBOX_NOTIFICATION_CONTROLLER;
const messages = Object.freeze({
  "monitor-ready": ["grokbox night harness ready", "Daytime staging and notification delivery passed; no experiment was started."],
  "development-complete": ["grokbox development run complete", "A short development run completed; it is not lifecycle qualification evidence."],
  "stimulus-started": ["grokbox night experiment started", "The controlled SSH activity stimulus has started."],
  "stimulus-complete": ["grokbox stimulus complete", "Controlled SSH activity stopped; passive withdrawal is now running."],
  "stimulus-degraded": ["grokbox SSH activity did not hold", "A confirmed freeze occurred during the controlled SSH activity window."],
  "freeze-candidate": ["grokbox freeze candidate", "The experiment is checking a Cursor freeze candidate against strict SSH."],
  "freeze-passed": ["grokbox SSH activity result", "Freeze followed complete stimulus withdrawal; the anti-idle hypothesis is supported."],
  "experiment-incomplete": ["grokbox experiment incomplete", "No accepted freeze occurred before the passive withdrawal deadline."],
  "experiment-inconclusive": ["grokbox experiment inconclusive", "The experiment ended without evidence strong enough for a lifecycle conclusion."],
  "observer-stalled": ["grokbox experiment stalled", "No new protected experiment checkpoint arrived within the expected window."],
  "evidence-malformed": ["grokbox evidence problem", "A protected experiment checkpoint could not be validated by the monitor."],
  "manual-app-recovery-required": ["grokbox manual recovery required", "The box may be frozen. Leave it closed until morning, then reopen Grok Bot.app explicitly."],
  "window-complete": ["grokbox night experiment complete", "The night experiment reached a terminal evidence state."],
});

function refuse(message) {
  console.error(message);
  process.exit(2);
}

if (!controller || !CONTROLLER.test(controller)) {
  refuse("Set GROKBOX_SANDBOX_NOTIFICATION_CONTROLLER to a safe BatchMode SSH alias.");
}

let input = "";
let bytes = 0;
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 4096) refuse("Notification input exceeds the byte limit.");
  input += chunk;
}

let value;
try {
  value = JSON.parse(input);
} catch {
  refuse("Notification input must be one JSON object.");
}
const keys = value && typeof value === "object" ? Object.keys(value).sort() : [];
if (JSON.stringify(keys) !== JSON.stringify(["body", "event", "title", "version"]) || value.version !== 1 ||
  typeof value.event !== "string" || !Object.hasOwn(messages, value.event)) {
  refuse("Notification input has an invalid event envelope.");
}
const [title, body] = messages[value.event];
if (value.title !== title || value.body !== body) refuse("Notification text does not match the fixed event projection.");

function shellQuote(text) {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

const appleScript = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
const remoteCommand = `/usr/bin/osascript -e ${shellQuote(appleScript)}`;
const child = spawn("ssh", [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=5",
  "-o", "ConnectionAttempts=1",
  "-o", "StrictHostKeyChecking=yes",
  controller,
  remoteCommand,
], { stdio: "ignore" });

const code = await new Promise((resolve) => {
  let settled = false;
  let killTimer;
  let forceTimer;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(forceTimer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      forceTimer = setTimeout(() => {
        child.unref();
        finish(null);
      }, 2000);
    }, 2000);
  }, 10_000);
  child.once("error", () => finish(null));
  child.once("close", (result) => finish(result));
});

if (code !== 0) process.exitCode = 1;
