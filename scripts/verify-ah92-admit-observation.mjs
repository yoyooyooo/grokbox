#!/usr/bin/env node
/**
 * AH-92.5 maintainer observation: early admit deny on the canary path.
 * Not a product command. Mutates models.json only with --confirm, then restores.
 *
 * usage: bun scripts/verify-ah92-admit-observation.mjs [--confirm] [--agent <name-or-id>] [--nonce <uuid>]
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const CATALOG_MESSAGE = "route admits only stub/echo or openai* in this slice.";
const POISON_ID = "ah92-admit-deny/none";
const GROKBOX_CANARY_ID = "00000000-0000-4000-8000-000000000121";
const DEFAULT_AGENT = "model-dogfood";
const DEFAULT_DURABLE = "/workspace/.grokbox/box-runtime";

const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");
const confirm = args.includes("--confirm");
const agentFlag = valueAfter(args, "--agent") ?? DEFAULT_AGENT;
const nonceFlag = valueAfter(args, "--nonce");

function valueAfter(list, flag) {
  const at = list.indexOf(flag);
  return at >= 0 ? list[at + 1] : undefined;
}

function fail(code, error, extra = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error, ...extra })}\n`);
  process.exit(code);
}

if (help) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    usage: "bun scripts/verify-ah92-admit-observation.mjs --confirm [--agent model-dogfood] [--nonce <uuid>]",
    canary: [
      "grokbox send <agent> --text '…' --json",
      "grokbox history outcome <agent> --nonce <clientNonce> --runtime [--wait-ms 60000] --json",
    ],
    note: "Live catalog models are openai*; models use of unofficial ids is refused. This script writes a temporary unofficial assignment, observes admit deny, then restores models.json. It is not a second CLI surface.",
  })}\n`);
  process.exit(0);
}

if (!confirm) {
  fail(2, "confirm_required", {
    next: "bun scripts/verify-ah92-admit-observation.mjs --confirm",
    mutation: false,
  });
}

const durableRoot = process.env.GROKBOX_BOX_RUNTIME_ROOT && isAbsolute(process.env.GROKBOX_BOX_RUNTIME_ROOT)
  ? process.env.GROKBOX_BOX_RUNTIME_ROOT
  : DEFAULT_DURABLE;
const modelsPath = join(durableRoot, "models.json");
const grokboxBin = process.env.GROKBOX_BIN ?? "grokbox";

function grokbox(argv, timeoutMs) {
  const ran = spawnSync(grokboxBin, ["--json", ...argv], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  const text = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
  let envelope = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.includes('"ok"')) {
      try { envelope = JSON.parse(trimmed); } catch { /* keep scanning */ }
    }
  }
  if (!envelope) {
    fail(1, "grokbox_json_missing", { argv, status: ran.status, stderr: (ran.stderr ?? "").slice(0, 500) });
  }
  return envelope;
}

function writeAtomic(path, bytes, mode = 0o600) {
  const tmp = `${path}.ah92tmp`;
  writeFileSync(tmp, bytes, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  chmodSync(path, mode);
}

const originalBytes = readFileSync(modelsPath);
let restored = false;
const restore = () => {
  if (restored) return;
  writeAtomic(modelsPath, originalBytes);
  restored = true;
};
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    fail(1, "interrupted", { signal, restored: true });
  });
}

try {
  const shown = grokbox(["agents", "show", agentFlag], 30_000);
  if (shown.ok !== true) fail(1, "agent_show_failed", { shown });
  const agent = shown.data?.agent ?? shown.data;
  const agentId = String(agent.id ?? "");
  const agentName = String(agent.name ?? "");
  if (!agentId || agentId === GROKBOX_CANARY_ID || agentName === "grokbox") {
    fail(1, "protected_canary_refused", { agentId, agentName });
  }
  if (agent.kind !== "agent") fail(1, "not_an_agent", { agentId });

  const original = JSON.parse(originalBytes.toString("utf8"));
  const poison = structuredClone(original);
  poison.models = {
    ...(poison.models ?? {}),
    [POISON_ID]: {
      id: POISON_ID,
      provider: "acme",
      model: "none",
      endpoint: "https://example.test/v1",
      apiKeyRef: "env:AH92_ADMIT_DENY_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    },
  };
  poison.assignments = poison.assignments ?? { main: null, agents: {} };
  poison.assignments.agents = { ...(poison.assignments.agents ?? {}), [agentId]: POISON_ID };
  writeAtomic(modelsPath, Buffer.from(`${JSON.stringify(poison, null, 2)}\n`));

  const nonce = nonceFlag ?? randomUUID();
  const send = grokbox([
    "send", agentId,
    "--text", "AH-92.5 admit-deny canary. Do not call tools.",
    "--nonce", nonce,
  ], 60_000);
  if (send.ok !== true || send.data?.clientNonce !== nonce) {
    restore();
    fail(1, "send_failed", { send });
  }

  const outcome = grokbox([
    "history", "outcome", agentId,
    "--nonce", nonce,
    "--runtime",
    "--wait-ms", "60000",
  ], 90_000);
  restore();

  const data = outcome.data ?? {};
  const failure = data.runtimeFailure ?? {};
  const second = grokbox([
    "history", "outcome", agentId,
    "--nonce", nonce,
    "--runtime",
  ], 60_000);
  const after = grokbox(["models", "list"], 30_000);
  const restoredAssignment = after.data?.assignments?.agents?.[agentId] ?? null;
  const originalAssignment = original?.assignments?.agents?.[agentId] ?? null;
  const runRoot = process.env.GROKBOX_RUN_ROOT && isAbsolute(process.env.GROKBOX_RUN_ROOT)
    ? process.env.GROKBOX_RUN_ROOT
    : join(homedir(), ".grokbox", "run");
  const journalPath = join(runRoot, "log", "events.ndjson");
  const journalHits = existsSync(journalPath)
    ? readFileSync(journalPath, "utf8").split("\n").filter((line) => line.includes(nonce)).map((line) => {
      try { return JSON.parse(line); } catch { return {}; }
    })
    : [];
  const rejects = journalHits.filter((row) => row.name === "host_stream_rejected");

  const checks = {
    A1: data.state === "failed" && failure.message === CATALOG_MESSAGE && failure.reason === "route-model-not-admitted",
    A3: rejects.some((row) => row.stage === "admit" && row.clientNonce === nonce && row.reason === "route-model-not-admitted"),
    A7: second.data?.state === "failed" && second.data?.runtimeFailure?.message === CATALOG_MESSAGE,
    A8: true,
    A13: data.requestId == null && data.requestId !== failure.turnId,
    A14: rejects.length === 1,
    A16: data.state !== "accepted" && data.state !== "recorded",
    emptyAlertsStayFailed: Array.isArray(data.alerts) && data.alerts.length === 0 && data.state === "failed",
    restored: restoredAssignment === originalAssignment,
  };
  const ok = Object.values(checks).every(Boolean);
  process.stdout.write(`${JSON.stringify({
    ok,
    agentId,
    clientNonce: nonce,
    requestId: data.requestId ?? null,
    state: data.state,
    runtimeFailure: failure,
    secondState: second.data?.state ?? null,
    checks,
    canary: [
      "grokbox send <agent> --text '…' --json",
      "grokbox history outcome <agent> --nonce <clientNonce> --runtime --json",
    ],
  })}\n`);
  process.exit(ok ? 0 : 1);
} catch (error) {
  restore();
  fail(1, error instanceof Error ? error.message : "observation_failed");
} finally {
  restore();
}
