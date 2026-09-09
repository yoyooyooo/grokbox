#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kase = process.argv[2];
if (!kase) {
  console.error("usage: bun scripts/verify-runtime-rebuild.mjs <case>");
  process.exit(1);
}

const CASES = {
  layout: [
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["bun", "test", "packages/box-runtime/test/architecture.test.ts"],
  ],
  codec: [
    ["bun", "test", "packages/box-runtime/test/host-codec.test.ts", "packages/box-runtime/test/ccs-codec.test.ts"],
  ],
  status: [
    ["bun", "test", "packages/runtime-kernel/test/status-facets.test.ts", "packages/box-runtime/test/host-journal.test.ts", "packages/box-runtime/test/observe-status.test.ts"],
    ["bun", "test", "test/runtime-cli.test.ts"],
  ],
  backend: [
    ["bun", "test", "packages/runtime-kernel/test/backend-contract.test.ts", "packages/box-runtime/test/backend-conformance.test.ts"],
    ["bun", "test", "packages/box-runtime/test/host-codec.test.ts", "packages/box-runtime/test/ccs-codec.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["bun", "test", "packages/box-runtime/test/architecture.test.ts"],
  ],
  binding: [
    ["bun", "test", "packages/runtime-kernel/test/selection.test.ts", "packages/runtime-kernel/test/route-binding.test.ts", "packages/runtime-kernel/test/step-ledger.test.ts"],
    ["bun", "test", "packages/box-runtime/test/binding-composition.test.ts"],
  ],
  lifecycle: [
    ["bun", "test", "packages/box-runtime/test/modeld-lifecycle.test.ts", "packages/box-runtime/test/modeld-wire.test.ts"],
  ],
  stream: [
    ["bun", "test", "packages/box-runtime/test/host-entry.test.ts", "packages/box-runtime/test/host-session.test.ts", "packages/box-runtime/test/host-fullstream.test.ts", "packages/box-runtime/test/runtime-pipeline.test.ts"],
  ],
  control: [
    ["bun", "test", "packages/runtime-kernel/test/controller.test.ts", "packages/box-runtime/test/controller-generation.test.ts", "packages/box-runtime/test/controller-io.test.ts", "test/runtime-cli.test.ts"],
  ],
  "raw-output": [
    ["bun", "test", "packages/box-runtime/test/controller-io.test.ts", "-t", "raw output"],
  ],
};

const mapped = CASES[kase];
if (!mapped) {
  console.error(`unknown case: ${kase}`);
  process.exit(1);
}

function sha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const commands = [];
let failed = false;
for (const argv of mapped) {
  const ran = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: "utf8" });
  const combined = `${ran.stdout ?? ""}\n${ran.stderr ?? ""}`;
  const pass = [...combined.matchAll(/\b(\d+) pass\b/g)].map((m) => Number(m[1])).at(-1);
  const skip = [...combined.matchAll(/\b(\d+) skip\b/g)].map((m) => Number(m[1])).at(-1);
  const failn = [...combined.matchAll(/\b(\d+) fail\b/g)].map((m) => Number(m[1])).at(-1);
  const expects = [...combined.matchAll(/\b(\d+) expect\(\) calls\b/g)].map((m) => Number(m[1])).at(-1);
  const isTest = argv.includes("test");
  const entry = {
    case: kase,
    argv,
    exit: ran.status ?? 1,
    stdoutTail: (ran.stdout ?? "").slice(-2000),
    stderrTail: (ran.stderr ?? "").slice(-2000),
    asserts: { pass, skip, fail: failn, expects },
  };
  commands.push(entry);
  if (ran.status !== 0) failed = true;
  if (isTest) {
    if (pass == null || pass === 0) failed = true;
    if ((skip ?? 0) > 0 && (pass ?? 0) === 0) failed = true;
    if ((failn ?? 0) > 0) failed = true;
  }
}

const SUPPORTS = {
  layout: ["layout-structure", "import-export-gates", "preload-esbuild-fence"],
  codec: ["host-context-snapshot", "ccs-chat-responses-http-oracle"],
  status: ["status-facets", "host-journal-roles", "readonly-status-ports"],
  backend: ["model-backend-port", "backend-auth-lease", "ccs-codec-prepare"],
  binding: ["selection-capture", "route-binding", "step-ledger"],
  lifecycle: ["modeld-v3-wire", "effect-unix-root"],
  stream: ["host-fullStream", "v3-unix-host-consumer"],
  control: ["controller-effect-program", "cli-confirmed-apply"],
  "raw-output": ["default-child-stdio-ignore", "t12-renewer-allowlist"],
};
const REALITY = {
  layout: "offline-layout",
  codec: "offline-sdk-mock-fetch",
  status: "offline-status-facets",
  backend: "offline-sdk-mock-fetch",
  binding: "offline-testclock-barrier",
  lifecycle: "offline-unix-disposable",
  stream: "offline-unix-sdk-mock-host",
  control: "offline-controller-fakes",
  "raw-output": "offline-helper-fd-renewer",
};
const report = {
  case: kase,
  commit: sha(),
  dependencyReality: REALITY[kase] ?? "offline",
  supports: failed ? [] : (SUPPORTS[kase] ?? []),
  notProven: [
    ...(kase === "stream" || kase === "control" ? [] : kase === "lifecycle" ? ["T26-host-fullStream"] : kase === "backend" || kase === "binding" ? ["T26-host-fullStream"] : ["inference"]),
    ...(kase === "control" ? [] : ["controller-effect-program"]),
    ...(kase === "lifecycle" || kase === "stream" ? [] : ["v3-wire-server"]),
    ...(kase === "stream" ? [] : ["Host-fullStream"]),
    ...(kase === "status" ? [] : ["status-facets"]),
    "live-adopt",
  ],
  commands,
  ok: !failed,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
