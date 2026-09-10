#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const help = args.includes("--help") || args.includes("-h");
const laneIdx = args.indexOf("--lane");
const lane = laneIdx >= 0 ? args[laneIdx + 1] : undefined;

const LANES = new Set(["contract-e2e", "artifact-e2e"]);
const REQUIRED_CASES = ["E01", "E02", "E03", "E04", "E05", "E06", "E08"];
const PACKED = join(root, "dist", "preload.cjs");
const REBUILD = "bun scripts/pack-runtime-helpers.mjs";
const CONTRACT_TESTS = [
  "packages/box-runtime/test/context-continuity.test.ts",
  "packages/box-runtime/test/context-continuity-e2e.test.ts",
];

function usage(code) {
  const text = "usage: bun scripts/verify-context-continuity.mjs --lane contract-e2e|artifact-e2e [--json]";
  if (json) console.log(JSON.stringify({ ok: false, error: text, lane: lane ?? null }));
  else console.error(text);
  process.exit(code);
}

if (help || !lane || !LANES.has(lane)) usage(1);

function sha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function bunVersion() {
  const ran = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf8" });
  return (ran.stdout ?? "").trim() || "unknown";
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseBunTest(combined) {
  const strip = (name) => name.replace(/\s+\[\d+(?:\.\d+)?ms\]$/, "").trim();
  const passNames = [...combined.matchAll(/\(pass\)\s+(\S[^\n]*)/g)].map((m) => strip(m[1]));
  const failNames = [...combined.matchAll(/\(fail\)\s+(\S[^\n]*)/g)].map((m) => strip(m[1]));
  const skipNames = [...combined.matchAll(/\(skip\)\s+(\S[^\n]*)/g)].map((m) => strip(m[1]));
  const pass = [...combined.matchAll(/\b(\d+) pass\b/g)].map((m) => Number(m[1])).at(-1) ?? 0;
  const fail = [...combined.matchAll(/\b(\d+) fail\b/g)].map((m) => Number(m[1])).at(-1) ?? 0;
  const skip = [...combined.matchAll(/\b(\d+) skip\b/g)].map((m) => Number(m[1])).at(-1) ?? 0;
  const expects = [...combined.matchAll(/\b(\d+) expect\(\) calls\b/g)].map((m) => Number(m[1])).at(-1) ?? 0;
  return { passNames, failNames, skipNames, pass, fail, skip, expects };
}

function caseStatus(id, parsed, ran) {
  const names = [...parsed.passNames, ...parsed.failNames, ...parsed.skipNames];
  const mentioned = names.filter((name) => name.includes(id));
  if (!ran) {
    return { id, status: "unavailable", reason: "lane_did_not_execute_tests" };
  }
  if (mentioned.length === 0) {
    return { id, status: "unavailable", reason: "case_not_executed" };
  }
  if (parsed.failNames.some((name) => name.includes(id))) {
    return { id, status: "fail", tests: mentioned };
  }
  if (parsed.skipNames.some((name) => name.includes(id)) && !parsed.passNames.some((name) => name.includes(id))) {
    return { id, status: "unavailable", reason: "skipped", tests: mentioned };
  }
  return { id, status: "pass", tests: mentioned.filter((name) => parsed.passNames.includes(name)) };
}

function emit(report, failed) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}

const commit = sha();
const bun = bunVersion();
const notProven = [
  "E07",
  "auxiliary_unqualified",
  "E09", "E10", "E11",
  "native_host_consumer_qualification",
  "live-adopt",
  "B-closed",
  "production-contextWindowTokens",
];

if (lane === "contract-e2e") {
  const argv = ["bun", "test", ...CONTRACT_TESTS];
  const ran = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8" });
  const combined = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
  const parsed = parseBunTest(combined);
  const cases = [
    ...REQUIRED_CASES.map((id) => caseStatus(id, parsed, true)),
    {
      id: "E07",
      status: "unavailable",
      reason: "auxiliary_unqualified",
      note: "F5 aux request-kind / captured parent binding not admitted. Helper unit tests are subset-only and do not grant E07 pass.",
    },
  ];
  const executed = parsed.pass > 0;
  const failed = ran.status !== 0
    || !executed
    || parsed.fail > 0
    || parsed.skip > 0
    || REQUIRED_CASES.some((id) => caseStatus(id, parsed, true).status !== "pass");
  emit({
    lane,
    commit,
    bun,
    dependencyReality: "offline-unix-sdk-mock-http-owned-store",
    packedPreload: false,
    liveHost: false,
    supports: failed ? [] : ["F1-executor-isolation", "F2-invalid-not-checkpointable", "F3-fixture-window-only", "E01", "E02", "E03", "E04", "E05", "E06", "E08"],
    cases,
    asserts: { pass: parsed.pass, fail: parsed.fail, skip: parsed.skip, expects: parsed.expects },
    commands: [{
      argv,
      exit: ran.status ?? 1,
      stdoutTail: (ran.stdout ?? "").slice(-4000),
      stderrTail: (ran.stderr ?? "").slice(-2000),
    }],
    notProven,
    ok: !failed,
  }, failed);
}

const packedExists = existsSync(PACKED);
const artifact = {
  path: "dist/preload.cjs",
  rebuildCommand: REBUILD,
  present: packedExists,
  sha256: packedExists ? sha256File(PACKED) : null,
  loadProbe: null,
  liveHost: false,
};

if (!packedExists) {
  const cases = REQUIRED_CASES.map((id) => ({
    id,
    status: "unavailable",
    reason: "packed_preload_missing",
  }));
  emit({
    lane,
    commit,
    bun,
    dependencyReality: "offline-packed-preload",
    native_qualification_pending: true,
    artifact,
    cases,
    notProven,
    ok: false,
    error: `packed preload missing; rebuild with: ${REBUILD}`,
  }, true);
}

const probeFile = join(tmpdir(), `grokbox-ctx-continuity-preload-probe-${process.pid}.cjs`);
writeFileSync(probeFile, "console.log('preload-probe-ok');\n");
const probe = spawnSync("node", ["--require", PACKED, probeFile], {
  cwd: root,
  encoding: "utf8",
  env: {
    ...process.env,
    GROKBOX_ALLOW_LIVE_HOST: "",
    GROKBOX_PATCH_PROFILE: "",
    GROKBOX_OPERATION_ID: "",
  },
});
const probeOut = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`;
const loadOk = probe.status === 0 && probeOut.includes("preload-probe-ok");
artifact.loadProbe = {
  exit: probe.status ?? 1,
  ok: loadOk,
  stdoutTail: (probe.stdout ?? "").slice(-500),
  stderrTail: (probe.stderr ?? "").slice(-500),
};

const cases = REQUIRED_CASES.map((id) => ({
  id,
  status: "unavailable",
  reason: "packed_preload_does_not_export_session_factory",
  note: "E09 needs an owned Host fixture driving dist/preload.cjs; this lane only SHA-gates and load-probes the packed artifact.",
}));

emit({
  lane,
  commit,
  bun,
  dependencyReality: "offline-packed-preload",
  native_qualification_pending: true,
  artifact,
  cases,
  notProven,
  shaGate: "Compare dist/preload.cjs sha256 after rebuilding with the recorded command before claiming artifact E01–E09.",
  ok: false,
  error: loadOk
    ? "native_qualification_pending: packed preload loaded but contract cases cannot run against an unexported session factory without a Host fixture"
    : "packed preload load probe failed",
}, true);
