#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureVerificationSource, withVerificationSource } from "./verification-source.mjs";
import { verifyPreloadArtifact } from "./preload-artifact.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const help = args.includes("--help") || args.includes("-h");
const laneIdx = args.indexOf("--lane");
const lane = laneIdx >= 0 ? args[laneIdx + 1] : undefined;

const LANES = new Set(["contract-e2e", "artifact-e2e"]);
const REQUIRED_CASES = ["E01", "E02", "E03", "E04", "E05", "E06", "E08"];
const PACKED = join(root, "dist", "preload.cjs");
const PACKED_SESSION_SYMBOL = "grokbox.box-runtime.packed-session.v1";
const REBUILD = "bun scripts/pack-runtime-helpers.mjs";
const OBS_REQUIRED = [
  "bun smoke: packed preload --require load",
  "default packed --require does not install session factory",
];
const CONTRACT_TESTS = [
  "packages/box-runtime/test/context-continuity.test.ts",
  "packages/box-runtime/test/context-continuity-e2e.test.ts",
  "packages/box-runtime/test/context-continuity-artifact.test.ts",
  "packages/box-runtime/test/e07-host-admission.test.ts",
  "packages/box-runtime/test/e07-host-purpose-e2e.test.ts",
];
const ARTIFACT_PACKED_TESTS = [
  "packages/box-runtime/test/context-continuity.test.ts",
  "packages/box-runtime/test/context-continuity-e2e.test.ts",
];
const ARTIFACT_OBS_TESTS = [
  "packages/box-runtime/test/context-continuity-artifact.test.ts",
  "packages/box-runtime/test/e07-host-purpose-packed.test.ts",
];
const E07_SOURCE_REQUIRED = [
  "optional purpose slices replay with all strict profile gates; older profiles remain valid",
  "E07 invalid attach leaves ctx unchanged (step-main)",
  "E07 Host memory and interval episode use the actual parent STEP and captured selection",
  "E07 missing parent, mismatched TURN, and failed newest main STEP never fall back to official",
  "E07 pending main is not a parent; late completion cannot relabel an earlier auxiliary attempt",
  "E07 duplicate and stale aux, foreign ctx, tools and malformed options do not dispatch again",
  "E07 evidence-only and dedicated external stay official; self-summary still needs a STEP",
  "E07 half-stream failure at request %s cannot commit partial Memory",
  "E07 canceled auxiliary fullStream rejects instead of committing an empty/partial success",
];
const E07_PACKED_REQUIRED = ["positive", "missing-parent", "half-stream", "abort", "old-profile"].map((name) => `E07 packed ${name}`);

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

function childEnv(overrides = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.GROKBOX_PACKED_SESSION_FACTORY;
  delete env.GROKBOX_PACKED_PRELOAD;
  delete env.GROKBOX_ALLOW_LIVE_HOST;
  delete env.GROKBOX_PATCH_PROFILE;
  delete env.GROKBOX_OPERATION_ID;
  return { ...env, ...overrides };
}

function nodeFactoryProbe({ factory, live, expectFactory }) {
  const code = [
    `const api = globalThis[Symbol.for(${JSON.stringify(PACKED_SESSION_SYMBOL)})];`,
    expectFactory
      ? "const ok = !!(api && api.asHostPromptSession && api.createStreamingPromptSession && api.InvalidHostStateError);"
      : "const ok = api == null;",
    "process.stdout.write(ok ? \"preload-probe-ok\" : \"preload-probe-mismatch\");",
    "process.exit(ok ? 0 : 2);",
  ].join("\n");
  const env = childEnv({
    ...(factory ? { GROKBOX_PACKED_SESSION_FACTORY: factory } : {}),
    ...(live ? { GROKBOX_ALLOW_LIVE_HOST: live } : {}),
  });
  return spawnSync("node", ["--require", PACKED, "-e", code], { cwd: root, encoding: "utf8", env });
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

function e09OracleStatus(parsed, extra = {}) {
  const failed = parsed.failNames.some((name) => name.includes("E09 reject-old"));
  const consumer = parsed.passNames.some((name) => name.includes("E09 reject-old oracle: old error-text consumer"));
  const bound = parsed.passNames.some((name) => name.includes("E09 reject-old oracle: source-bound rebuild matches captured artifact"));
  if (failed) return { id: "E09", status: "fail", tests: parsed.failNames.filter((name) => name.includes("E09 reject-old")) };
  const oracle = consumer && bound;
  if (!oracle) {
    return { id: "E09", status: "unavailable", reason: "e09_reject_old_oracle_not_qualified" };
  }
  if (extra.requirePacked) {
    if (extra.loadOk && extra.bindingOk && extra.packedOk) {
      return { id: "E09", status: "pass", tests: parsed.passNames.filter((name) => name.includes("E09 reject-old oracle")) };
    }
    return {
      id: "E09",
      status: "unavailable",
      reason: extra.loadOk === false
        ? "packed_node_load_failed"
        : extra.bindingOk === false
          ? "packed_source_binding_mismatch"
          : extra.packedOk === false
            ? "packed_preload_does_not_export_session_factory"
            : "e09_reject_old_oracle_not_qualified",
    };
  }
  return {
    id: "E09",
    status: "unavailable",
    reason: "e09_reject_old_oracle_not_qualified",
    note: "oracle observations are not E09 pass; packed E01–E08 factory still required",
  };
}

function e07HostStatus(parsed, packed = false) {
  const required = packed ? E07_PACKED_REQUIRED : E07_SOURCE_REQUIRED;
  const passed = required.every((name) => parsed.passNames.some((test) => test.endsWith(`> ${name}`)));
  const failed = parsed.failNames.some((name) => name.includes("E07"));
  return {
    id: "E07",
    status: failed ? "fail" : passed ? "partial" : "unavailable",
    reason: passed && !failed ? "e07_full_matrix_not_qualified" : "auxiliary_unqualified",
    hostAdmission: { status: failed ? "fail" : passed ? "pass" : "unavailable", lane: packed ? "packed-node-exact-compile" : "source-host-shaped-unix-sdk-fake" },
    note: "D2 Host purpose slices are implemented. This is Host admission proof only, not the complete E07 matrix or native Host consumer qualification.",
  };
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
  const qualified = withVerificationSource({ toolchain, worktreeDirty, ...report }, sourceBefore, captureVerificationSource(root));
  console.log(JSON.stringify(qualified, null, 2));
  process.exit(failed || !qualified.ok ? 1 : 0);
}

const commit = sha();
const sourceBefore = captureVerificationSource(root);
const worktreeDirty = (() => {
  try {
    return execSync("git status --porcelain=v1 --untracked-files=normal", { cwd: root, encoding: "utf8" }).trim().length > 0;
  } catch {
    return null;
  }
})();
const bun = bunVersion();
const packageManager = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
const expectedBun = typeof packageManager === "string" && /^bun@\d+\.\d+\.\d+$/.test(packageManager)
  ? packageManager.slice(4)
  : null;
const toolchain = { packageManager: packageManager ?? null, expectedBun, actualBun: bun };

// Evidence is version-scoped. Reject before any tests, preload probes or pack side effects.
if (expectedBun === null || bun !== expectedBun) {
  emit({
    lane,
    commit,
    bun,
    ok: false,
    error: "toolchain_mismatch",
    dependencyReality: "toolchain-check-only",
    supports: [],
    cases: [...REQUIRED_CASES, "E07", "E09"].map((id) => ({
      id, status: "unavailable", reason: "toolchain_mismatch",
    })),
    notProven: ["continuity", "packed-artifact", "native_host_consumer_qualification", "live-adopt", "B-closed"],
  }, true);
}
function continuityNotProven(e09, e07) {
  return [
    "E07",
    e07?.hostAdmission.status === "pass" ? "e07_full_matrix_not_qualified" : "auxiliary_unqualified",
    ...(e09?.status === "pass" ? [] : ["E09", "e09_reject_old_oracle_not_qualified"]),
    "E10", "E11",
    "native_host_consumer_qualification",
    "live-adopt",
    "B-closed",
    "production-contextWindowTokens",
  ];
}

if (lane === "contract-e2e") {
  const argv = ["bun", "test", ...CONTRACT_TESTS];
  const ran = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8", env: childEnv() });
  const combined = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
  const parsed = parseBunTest(combined);
  const cases = [
    ...REQUIRED_CASES.map((id) => caseStatus(id, parsed, true)),
    e07HostStatus(parsed),
    e09OracleStatus(parsed),
  ];
  const e07 = cases.find((row) => row.id === "E07");
  const e09 = cases.find((row) => row.id === "E09");
  const executed = parsed.pass > 0;
  const failed = ran.status !== 0
    || !executed
    || parsed.fail > 0
    || parsed.skip > 0
    || REQUIRED_CASES.some((id) => caseStatus(id, parsed, true).status !== "pass")
    || e07?.hostAdmission.status !== "pass"
    || e09?.status === "fail";
  emit({
    lane,
    commit,
    bun,
    dependencyReality: "offline-unix-sdk-mock-http-owned-store",
    packedPreload: false,
    constructorSource: "source",
    liveHost: false,
    supports: failed ? [] : ["F1-executor-isolation", "F2-invalid-not-checkpointable", "F3-fixture-window-only", "E01", "E02", "E03", "E04", "E05", "E06", "E08", "E07-Host-admission"],
    cases,
    asserts: { pass: parsed.pass, fail: parsed.fail, skip: parsed.skip, expects: parsed.expects },
    commands: [{
      argv,
      env: { GROKBOX_PACKED_SESSION_FACTORY: null, GROKBOX_PACKED_PRELOAD: null },
      exit: ran.status ?? 1,
      stdoutTail: (ran.stdout ?? "").slice(-4000),
      stderrTail: (ran.stderr ?? "").slice(-2000),
    }],
    notProven: continuityNotProven(e09, e07),
    ok: !failed,
  }, failed);
}

const packedExists = existsSync(PACKED);
const packedSha = packedExists ? sha256File(PACKED) : null;
const artifact = {
  path: PACKED,
  rebuildCommand: REBUILD,
  present: packedExists,
  sha256: packedSha,
  constructorSource: PACKED,
  loadProbe: null,
  factoryProbes: null,
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
    notProven: continuityNotProven({ status: "unavailable" }),
    ok: false,
    error: `packed preload missing; rebuild with: ${REBUILD}`,
  }, true);
}

// Refuse a stale or altered file before any candidate code is executed.
// Verification only rebuilds trusted source in memory; it never repairs dist.
const bindingBefore = await verifyPreloadArtifact(root, PACKED);
artifact.sourceBinding = { before: bindingBefore, after: null };
if (!bindingBefore.ok) {
  emit({ lane, commit, bun, dependencyReality: "offline-packed-preload", artifact, ok: false,
    error: bindingBefore.reason, cases: REQUIRED_CASES.map(id => ({ id, status: "unavailable", reason: "packed_source_binding_mismatch" })),
    notProven: continuityNotProven({ status: "unavailable" }) }, true);
}

const defaultProbe = nodeFactoryProbe({ expectFactory: false });
const optInProbe = nodeFactoryProbe({ factory: "1", expectFactory: true });
const liveRefuseProbe = nodeFactoryProbe({ factory: "1", live: "1", expectFactory: false });
const probeOk = (ran) => ran.status === 0 && (ran.stdout ?? "").includes("preload-probe-ok");
const loadOk = probeOk(defaultProbe) && probeOk(optInProbe) && probeOk(liveRefuseProbe);
artifact.loadProbe = {
  exit: defaultProbe.status ?? 1,
  ok: probeOk(defaultProbe),
  stdoutTail: (defaultProbe.stdout ?? "").slice(-500),
  stderrTail: (defaultProbe.stderr ?? "").slice(-500),
};
artifact.factoryProbes = {
  defaultClosed: { exit: defaultProbe.status ?? 1, ok: probeOk(defaultProbe) },
  optIn: { exit: optInProbe.status ?? 1, ok: probeOk(optInProbe) },
  liveRefuse: { exit: liveRefuseProbe.status ?? 1, ok: probeOk(liveRefuseProbe) },
};

const packedEnv = childEnv({
  GROKBOX_PACKED_SESSION_FACTORY: "1",
  GROKBOX_PACKED_PRELOAD: PACKED,
});
const packedArgv = ["bun", "test", ...ARTIFACT_PACKED_TESTS];
const packedRan = spawnSync(packedArgv[0], packedArgv.slice(1), { cwd: root, encoding: "utf8", env: packedEnv });
const packedParsed = parseBunTest(`${packedRan.stdout ?? ""}\n${packedRan.stderr ?? ""}`);
const packedCases = REQUIRED_CASES.map((id) => caseStatus(id, packedParsed, true));

const obsArgv = ["bun", "test", ...ARTIFACT_OBS_TESTS];
const obsRan = spawnSync(obsArgv[0], obsArgv.slice(1), { cwd: root, encoding: "utf8", env: childEnv() });
const obsParsed = parseBunTest(`${obsRan.stdout ?? ""}\n${obsRan.stderr ?? ""}`);
const obsRequiredMissing = OBS_REQUIRED.filter((name) => !obsParsed.passNames.some((n) => n.includes(name)));

const packedFailed = packedRan.status !== 0
  || packedParsed.fail > 0
  || packedParsed.skip > 0
  || packedParsed.pass === 0
  || packedCases.some((c) => c.status !== "pass");
const obsFailed = obsRan.status !== 0
  || obsParsed.fail > 0
  || obsParsed.skip > 0
  || obsParsed.pass === 0
  || obsParsed.expects === 0
  || obsRequiredMissing.length > 0;
const bindingAfter = await verifyPreloadArtifact(root, PACKED);
artifact.sourceBinding.after = bindingAfter;
const bindingOk = bindingAfter.ok && bindingAfter.artifact.sha256 === bindingBefore.artifact.sha256
  && bindingAfter.expected.sha256 === bindingBefore.expected.sha256;
const e09 = e09OracleStatus(obsParsed, {
  requirePacked: true,
  loadOk,
  packedOk: !packedFailed,
  bindingOk,
});
const e07 = e07HostStatus(obsParsed, true);
const failed = !bindingOk || !loadOk || packedFailed || obsFailed || e09.status === "fail" || e07.hostAdmission.status !== "pass";

emit({
  lane,
  commit,
  bun,
  dependencyReality: "offline-packed-preload",
  native_qualification_pending: true,
  packedSessionFactory: !failed,
  artifact,
  cases: [...packedCases, e07, e09],
  asserts: {
    packed: { pass: packedParsed.pass, fail: packedParsed.fail, skip: packedParsed.skip, expects: packedParsed.expects },
    obs: { pass: obsParsed.pass, fail: obsParsed.fail, skip: obsParsed.skip, expects: obsParsed.expects },
  },
  commands: [{
    argv: packedArgv,
    env: { GROKBOX_PACKED_SESSION_FACTORY: "1", GROKBOX_PACKED_PRELOAD: PACKED },
    exit: packedRan.status ?? 1,
    stdoutTail: (packedRan.stdout ?? "").slice(-2000),
    stderrTail: (packedRan.stderr ?? "").slice(-1000),
  }, {
    argv: obsArgv,
    exit: obsRan.status ?? 1,
    stdoutTail: (obsRan.stdout ?? "").slice(-1000),
    stderrTail: (obsRan.stderr ?? "").slice(-500),
  }],
  notProven: continuityNotProven(e09, e07),
  shaGate: "Capture the artifact before tests, independently rebuild current source in memory, and recheck exact bytes and build inputs after tests; no golden update or artifact repair.",
  ok: !failed,
  ...(failed ? {
    error: !bindingOk
      ? "packed source binding changed during qualification"
      : !loadOk
      ? "packed preload Node factory probes failed"
      : packedFailed
        ? "packed E01–E06+E08 against dist/preload.cjs failed"
        : obsRequiredMissing.length > 0
          ? `packed observation required checks missing: ${obsRequiredMissing.join(", ")}`
          : "packed observation checks failed, skipped, or did not execute",
  } : {}),
}, failed);
