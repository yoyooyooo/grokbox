#!/usr/bin/env node
/**
 * Bounded live-validation control plane.
 *
 * This is an observer and receipt checker. It never sends prompts, changes
 * models, enables Routines, restarts services, deletes objects, or publishes.
 * LIVE/runbook requirements and reported results still need direct evidence.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureVerificationSource } from "./verification-source.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "docs", "tickets", "LIVE-integration-validation.md");
const packagePath = join(root, "package.json");
const RESULT_STATUSES = new Set([
  "not-run", "awaiting-integration", "ready", "running", "passed",
  "failed", "blocked", "needs-revalidation", "excluded", "superseded",
]);
const RECEIPT_STATUSES = new Set(["passed", "failed", "blocked", "not-proven", "not-run"]);
const SECRET_KEY = /(token|secret|password|api[-_]?key|authorization|credential|private[-_]?key)/i;
const SECRET_VALUE = /(?:bearer\s+\S+|gbox_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{12,})/i;
const REPORT_REF = /^(?:\.\.\/reports\/[A-Za-z0-9._-]+\.md#[A-Za-z0-9._-]+|private:[A-Za-z0-9._:-]{1,160})$/;
const SHA = /^[0-9a-f]{40}$/i;
const HASH = /^[0-9a-f]{64}$/i;

function usage(message) {
  throw new Error(`${message}\nusage: node scripts/live-validation.mjs <candidate|plan|probe|receipt> [options]`);
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`${name} requires a value`);
  return value;
}

function flagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usage(`${name} requires a value`);
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function has(args, name) {
  return args.includes(name);
}

function ensureKnownFlags(args, known) {
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg.split("=")[0])) usage(`unknown option ${arg}`);
  }
}

function runGit(args, { trim = true } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) return { ok: false, text: "", error: result.error?.message ?? "git_failed" };
  return { ok: true, text: trim ? result.stdout.trim() : result.stdout, error: null };
}

function readPackage() {
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function parseLiveIndex(markdown = readFileSync(indexPath, "utf8")) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!/^\| <a id="live-[^"]+"><\/a>/.test(line)) continue;
    const anchor = line.match(/^\| <a id="([^"]+)">/)?.[1];
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!anchor || cells.length !== 4) continue;
    const title = cells[0].replace(/^<a[^>]*><\/a>\*\*/, "").replace(/\*\*<br>.*$/, "");
    const gate = cells[0].match(/<br>(G[0-3]|D)/)?.[1] ?? null;
    const tokens = [...cells[1].matchAll(/\`([^\`]+)\`/g)].map((match) => match[1]);
    const currentResult = tokens.find((token) => RESULT_STATUSES.has(token)) ?? null;
    const implementation = tokens.find((token) => /^(?:integrated|partial|planned|reserved|experimental)(?:\/|$)/.test(token)) ?? null;
    const sourceLinks = [...cells[3].matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    rows.push({
      id: anchor,
      stableId: anchor.toUpperCase(),
      title,
      gate,
      implementation,
      currentResult,
      oracle: cells[2],
      blocker: cells[3],
      sourceLinks,
    });
  }
  return rows;
}

function sourceSnapshot() {
  const revision = runGit(["rev-parse", "HEAD"]);
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=normal"], { trim: false });
  const source = captureVerificationSource(root);
  const pkg = readPackage();
  const bun = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf8", timeout: 5000 });
  return {
    sourceCommit: revision.ok ? revision.text : null,
    dirty: status.ok ? status.text.length > 0 : null,
    dirtyPaths: status.ok ? status.text.split("\n").filter(Boolean).map((line) => line.slice(3).trim()) : [],
    sourceDigest: source.ok ? source.sha256 : null,
    sourceFiles: source.ok ? source.files : null,
    sourceCapture: source.ok ? "stable-inputs" : source.reason,
    package: { name: pkg.name, version: pkg.version, packageManager: pkg.packageManager, engines: pkg.engines ?? null },
    runtime: { node: process.versions.node, bun: (bun.stdout ?? "").trim() || null },
  };
}

function runStaticGate() {
  const result = spawnSync("bun", ["test", "test/docs-governance.test.ts", "test/live-e2e-checklist.test.ts"], {
    cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  return {
    command: "bun test test/docs-governance.test.ts test/live-e2e-checklist.test.ts",
    ok: !result.error && result.status === 0 && !result.signal,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    outputTail: String(result.stdout || result.stderr || "").slice(-2000),
  };
}

function candidate(args) {
  ensureKnownFlags(args, new Set(["--json", "--allow-dirty", "--skip-static"]));
  const snapshot = sourceSnapshot();
  const rows = parseLiveIndex();
  const staticGate = has(args, "--skip-static")
    ? { command: null, ok: false, skipped: true, reason: "explicit_skip" }
    : runStaticGate();
  const after = sourceSnapshot();
  const sourceStable = Boolean(snapshot.sourceDigest && snapshot.sourceDigest === after.sourceDigest);
  const blockers = [];
  if (!snapshot.sourceCommit) blockers.push("SOURCE_COMMIT_UNAVAILABLE");
  if (!snapshot.sourceDigest) blockers.push("SOURCE_DIGEST_UNAVAILABLE");
  if (!sourceStable) blockers.push("SOURCE_CHANGED_DURING_CHECK");
  if (snapshot.dirty && !has(args, "--allow-dirty")) blockers.push("WORKTREE_DIRTY");
  if (snapshot.dirty && has(args, "--allow-dirty")) blockers.push("WORKTREE_DIRTY_ALLOWED_ONLY_FOR_PLANNING");
  if (!staticGate.ok) blockers.push(staticGate.skipped ? "STATIC_GATE_SKIPPED" : "STATIC_GATE_FAILED");
  if (rows.length === 0) blockers.push("LIVE_INDEX_EMPTY");
  if (rows.some((row) => !row.gate || !row.currentResult || row.sourceLinks.length === 0)) blockers.push("LIVE_INDEX_ROW_MISSING_ROUTE");
  const result = {
    version: 1,
    kind: "grokbox-live-candidate-check",
    qualification: "structural-precheck-only",
    status: blockers.length === 0 ? "ready" : "blocked",
    ok: blockers.length === 0,
    candidate: snapshot,
    afterCheck: { sourceCommit: after.sourceCommit, sourceDigest: after.sourceDigest, dirty: after.dirty },
    sourceStable,
    index: { path: "docs/tickets/LIVE-integration-validation.md", scenarioCount: rows.length },
    staticGate,
    blockers,
    limits: [
      "This does not adopt Host/modeld, call a Provider, create a Bot, invoke a Webhook, or prove App/native behavior.",
      "A clean source candidate is necessary for a window and never sufficient for live acceptance.",
    ],
  };
  return result;
}

function selectLiveScenarios(ids, rows = parseLiveIndex()) {
  if (ids.length === 0) usage("plan requires at least one --scenario");
  return ids.map((input) => {
    const id = input.toLowerCase();
    const row = rows.find((candidateRow) => candidateRow.id === id);
    if (!row) usage(`unknown LIVE scenario ${input}`);
    if (row.currentResult === "superseded") usage(`superseded LIVE scenario ${input}; follow its replacement route`);
    return row;
  });
}

function plan(args) {
  ensureKnownFlags(args, new Set(["--json", "--scenario"]));
  const selected = selectLiveScenarios(flagValues(args, "--scenario"));
  return {
    version: 1,
    kind: "grokbox-live-plan",
    execution: "manual-explicit",
    selected: selected.map((row) => ({
      ...row,
      currentResult: row.currentResult,
      mutations: "The controller does not perform this scenario. Follow the runbook and record a receipt.",
    })),
    limits: [
      "This is a source-routed slice, not a second status ledger.",
      "Do not treat integrated/offline/review evidence as live proof.",
      "Do not replace an unknown result with a new nonce or a different Provider.",
    ],
  };
}

function redacted(value, key = "") {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    const safe = value
      .replace(SECRET_VALUE, "[redacted]")
      .replace(/(?:^|[\s"'\`])\/(?:home|workspace|tmp|Users)\/[^\s"'\`]+/gi, "[path]")
      .replace(/([?&](?:token|key|secret|api[-_]?key)=)[^&\s]+/gi, "$1[redacted]");
    return safe.slice(0, 4000);
  }
  if (Array.isArray(value)) return value.map((item) => redacted(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redacted(child, childKey)]));
  }
  return value;
}

const READ_ONLY_PROBES = Object.freeze({
  doctor: ["doctor", "--json"],
  roster: ["agents", "list", "--ownership", "--json"],
  models: ["model", "list", "--limit", "100"],
  runtime: ["runtime", "status", "--json"],
  storage: ["runtime", "storage", "status", "--json"],
  targets: ["notification", "receiver", "list"],
  notifications: ["ops", "notifications", "list", "--json"],
});

function runProbe(name, bin) {
  const argv = READ_ONLY_PROBES[name];
  const result = spawnSync(bin, argv, {
    cwd: root, encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env: process.env,
  });
  let parsed = null;
  for (const line of String(result.stdout ?? "").split("\n").reverse()) {
    if (!line.trim()) continue;
    try { parsed = JSON.parse(line); break; } catch { /* keep looking */ }
  }
  return {
    name,
    argv,
    ok: !result.error && result.status === 0 && !result.signal,
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
    result: parsed ? redacted(parsed) : null,
    stderr: redacted(String(result.stderr ?? "").trim()).slice(0, 1000),
  };
}

function probe(args) {
  ensureKnownFlags(args, new Set(["--json", "--probe", "--bin"]));
  const requested = flagValues(args, "--probe");
  const names = requested.length ? requested : ["doctor", "roster", "models", "runtime"];
  for (const name of names) if (!Object.hasOwn(READ_ONLY_PROBES, name)) usage(`unknown read-only probe ${name}`);
  const bin = flagValue(args, "--bin") ?? process.env.GROKBOX_BIN ?? "grokbox";
  const results = names.map((name) => runProbe(name, bin));
  return {
    version: 1,
    kind: "grokbox-live-readonly-probe",
    commandSurface: "current-registered-cli",
    status: results.every((result) => result.ok) ? "observed" : "blocked",
    ok: results.every((result) => result.ok),
    binary: bin.split(/[\\/]/).pop() ?? "grokbox",
    probes: results,
    notProven: [
      "These probes target the current registered CLI, not the planned replacement syntax; success does not bind the binary to a candidate.",
      "Provider identity, requested/captured/emitted/reported effort, tool side effects, compact checkpoint, App rendering, Webhook delivery, restart adoption, and cleanup.",
    ],
  };
}

function findSecrets(value, path = "$", found = []) {
  if (typeof value === "string" && (SECRET_VALUE.test(value) || /(?:^|[\\/])(?:home|workspace|Users|tmp)[\\/]/i.test(value))) found.push(path);
  if (Array.isArray(value)) value.forEach((item, index) => findSecrets(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => findSecrets(child, `${path}.${key}`, found));
  return found;
}

function validateReceipt(receipt, rows = parseLiveIndex()) {
  const errors = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { ok: false, errors: ["receipt_not_object"] };
  if (receipt.version !== 1 || receipt.kind !== "grokbox-live-receipt") errors.push("receipt_kind_or_version");
  if (typeof receipt.windowId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/.test(receipt.windowId)) errors.push("window_id");
  const scenario = typeof receipt.scenario === "string" ? receipt.scenario.toLowerCase() : "";
  const row = rows.find((candidateRow) => candidateRow.id === scenario);
  if (!row) errors.push("unknown_scenario");
  if (row?.currentResult === "superseded") errors.push("scenario_superseded");
  if (!receipt.candidate || typeof receipt.candidate !== "object") errors.push("candidate_missing");
  else {
    if (!SHA.test(receipt.candidate.sourceCommit ?? "")) errors.push("candidate_source_commit");
    if (receipt.candidate.artifactHash !== undefined && !HASH.test(receipt.candidate.artifactHash)) errors.push("candidate_artifact_hash");
  }
  if (!Array.isArray(receipt.steps) || receipt.steps.length === 0) errors.push("steps_missing");
  else {
    const stepIds = new Set();
    receipt.steps.forEach((step, index) => {
      if (!step || typeof step !== "object") { errors.push(`step_${index}_not_object`); return; }
      if (typeof step.id !== "string" || !/^[A-Z0-9-]+\/\d{2}$/.test(step.id)) errors.push(`step_${index}_id`);
      else {
        if (row && !step.id.startsWith(`${row.stableId}/`)) errors.push(`step_${index}_scenario_mismatch`);
        if (stepIds.has(step.id)) errors.push("duplicate_step_id");
        stepIds.add(step.id);
      }
      if (!RECEIPT_STATUSES.has(step.status)) errors.push(`step_${index}_status`);
      if (typeof step.observation !== "string" || step.observation.trim().length === 0 || step.observation.length > 4096) errors.push(`step_${index}_observation`);
      if (typeof step.evidenceRef !== "string" || !REPORT_REF.test(step.evidenceRef)) errors.push(`step_${index}_evidence_ref`);
    });
  }
  const cleanupState = receipt.cleanup?.state;
  if (!["complete", "required", "unknown", "not-applicable"].includes(cleanupState)) errors.push("cleanup_state");
  if (!Array.isArray(receipt.notProven)) errors.push("not_proven_list");
  else if (receipt.notProven.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) errors.push("not_proven_item");
  const secretPaths = findSecrets(receipt);
  if (secretPaths.length) errors.push("secret_or_machine_path");
  const stepStatuses = Array.isArray(receipt.steps) ? receipt.steps.map((step) => step?.status) : [];
  const derived = {
    scenario: row?.stableId ?? null,
    currentResult: row?.currentResult ?? null,
    allStepsPassed: stepStatuses.length > 0 && stepStatuses.every((status) => status === "passed"),
    hasFailure: stepStatuses.some((status) => status === "failed"),
    hasUnknown: stepStatuses.some((status) => status === "blocked" || status === "not-proven" || status === "not-run"),
    cleanupState: cleanupState ?? null,
    indexEligible: errors.length === 0 && stepStatuses.length > 0 && stepStatuses.every((status) => status === "passed")
      && cleanupState === "complete" && Array.isArray(receipt.notProven) && receipt.notProven.length === 0,
  };
  return { ok: errors.length === 0, errors, derived };
}

function receipt(args) {
  ensureKnownFlags(args, new Set(["--json", "--file"]));
  const file = flagValue(args, "--file");
  if (!file) usage("receipt requires --file <json>");
  let parsed;
  try { parsed = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")); }
  catch { return { version: 1, kind: "grokbox-live-receipt-check", ok: false, errors: ["receipt_read_failed"] }; }
  const checked = validateReceipt(parsed);
  return { version: 1, kind: "grokbox-live-receipt-check", ...checked, file: file.split(/[\\/]/).pop() ?? "<provided>" };
}

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.kind}: ${result.status ?? (result.ok ? "ok" : "failed")}\n`);
  if (result.blockers?.length) process.stdout.write(`blockers: ${result.blockers.join(", ")}\n`);
  if (result.errors?.length) process.stdout.write(`errors: ${result.errors.join(", ")}\n`);
  if (result.derived) process.stdout.write(`indexEligible: ${result.derived.indexEligible ? "yes" : "no"}\n`);
}

export { parseLiveIndex, selectLiveScenarios, validateReceipt, sourceSnapshot, READ_ONLY_PROBES };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (!command || command === "--help" || command === "-h") usage("a command is required");
    const json = has(args, "--json");
    const result = command === "candidate" ? candidate(args)
      : command === "plan" ? plan(args)
        : command === "probe" ? probe(args)
          : command === "receipt" ? receipt(args)
            : usage(`unknown command ${command}`);
    print(result, json);
    process.exitCode = result.ok === false ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "live_validation_failed"}\n`);
    process.exitCode = 2;
  }
}
