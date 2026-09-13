#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureVerificationSource, withVerificationSource } from "./verification-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kase = process.argv[2];
if (!kase) {
  console.error("usage: bun scripts/verify-runtime-rebuild.mjs <case>");
  process.exit(1);
}

const CASES = {
  all: [
    ["bun", "run", "typecheck"],
    ["bun", "run", "build"],
    ["bun", "test"],
  ],
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
    ["bun", "test", "packages/box-runtime/test/modeld-lifecycle.test.ts", "packages/box-runtime/test/modeld-wire.test.ts", "packages/box-runtime/test/modeld-outcome.test.ts"],
  ],
  "observation-monitor": [
    ["bun", "run", "typecheck"],
    ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/monitor.test.ts", "packages/box-runtime/test/monitor-store.test.ts", "packages/box-runtime/test/monitor-commit-boundaries.test.ts", "test/monitor-cli.test.ts"],
  ],
  "runtime-start": [
    ["bun", "run", "typecheck"],
    ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/runtime-start.test.ts", "test/runtime-start-lifetime.test.ts", "packages/box-runtime/test/runtime-start-packed.test.ts", "test/runtime-service-status.test.ts"],
  ],
  "service-lifecycle": [
    ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/modeld-start-failure.test.ts", "packages/box-runtime/test/modeld-packaged-lifecycle.test.ts", "packages/box-runtime/test/modeld-lifecycle.test.ts", "packages/box-runtime/test/modeld-root-identity.test.ts", "packages/box-runtime/test/modeld-service-info.test.ts", "packages/box-runtime/test/modeld-running-failure.test.ts", "test/runtime-modeld-lifetime.test.ts"],
  ],
  stream: [
    ["bun", "test", "packages/box-runtime/test/host-entry.test.ts", "packages/box-runtime/test/host-session.test.ts", "packages/box-runtime/test/host-fullstream.test.ts", "packages/box-runtime/test/runtime-pipeline.test.ts", "packages/box-runtime/test/responses-continuation.test.ts", "packages/box-runtime/test/incomplete-response.test.ts"],
  ],
  control: [
    ["bun", "test", "packages/runtime-kernel/test/controller.test.ts", "packages/box-runtime/test/controller-generation.test.ts", "packages/box-runtime/test/controller-io.test.ts", "packages/box-runtime/test/controller-lock.test.ts", "packages/box-runtime/test/op-lock.test.ts", "packages/box-runtime/test/guardian-release.test.ts", "packages/box-runtime/test/guardian-process.test.ts", "packages/box-runtime/test/legacy-executor-removed.test.ts", "test/runtime-cli.test.ts"],
  ],
  "raw-output": [
    ["bun", "test", "packages/box-runtime/test/controller-io.test.ts", "-t", "raw output"],
  ],
  "ownership-admission": [
    ["bun", "test", "packages/runtime-kernel/test/ownership-admission.test.ts", "packages/box-runtime/test/ownership-scope-cache.test.ts", "packages/box-runtime/test/ownership-native-pause.test.ts", "packages/box-runtime/test/host-resume-admission.test.ts", "packages/box-runtime/test/host-ownership-read.test.ts", "packages/box-runtime/test/modeld-outcome.test.ts", "test/ownership.test.ts"],
  ],
  "identity-alignment": [
    ["bun", "run", "build"],
    ["bun", "test", "test/identity-alignment.test.ts", "test/ownership-model-selection.test.ts", "packages/cli/test/harness-profile.test.ts", "test/management.test.ts", "packages/box-runtime/test/host-harness-stick.test.ts"],
  ],
  "ownership-artifact": [
    ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/ownership-packed-client.test.ts"],
  ],
  "model-selection": [
    ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/model-selection.test.ts", "packages/box-runtime/test/configuration-write.test.ts", "packages/box-runtime/test/model-switch-pipeline.test.ts", "test/ownership-model-selection.test.ts", "packages/runtime-kernel/test/route-binding.test.ts", "packages/runtime-kernel/test/selection.test.ts", "packages/box-runtime/test/host-selection-unavailable.test.ts", "packages/box-runtime/test/host-session-hook.test.ts"],
  ],
  compact: [
    ["bun", "test", "packages/runtime-kernel/test/overflow-recovery.test.ts", "packages/box-runtime/test/overflow-bridge.test.ts", "packages/box-runtime/test/modeld-wire.test.ts", "packages/box-runtime/test/host-compact.test.ts"],
    ["bun", "test", "packages/box-runtime/test/host-agent-id.test.ts", "packages/box-runtime/test/host-compact-pipeline.test.ts", "packages/box-runtime/test/host-compact-lifetime.test.ts", "packages/box-runtime/test/host-compact-coordination.test.ts", "packages/box-runtime/test/host-compact-control.test.ts", "packages/box-runtime/test/modeld-v4-compact-adapter.test.ts", "packages/box-runtime/test/host-managed-retry.test.ts", "packages/box-runtime/test/host-managed-turn-retry.test.ts", "packages/box-runtime/test/host-native-error-scope.test.ts"],
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

const packageManager = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
const expectedBun = typeof packageManager === "string" && /^bun@\d+\.\d+\.\d+$/.test(packageManager) ? packageManager.slice(4) : null;
const version = spawnSync("bun", ["--version"], { cwd: root, encoding: "utf8", timeout: 5000 });
const rawVersion = (version.stdout ?? "").trim();
const actualBun = version.status === 0 && /^\d+\.\d+\.\d+$/.test(rawVersion) ? rawVersion : "unknown";
const toolchain = { packageManager, expectedBun, actualBun };
if (!expectedBun || actualBun !== expectedBun) {
  console.log(JSON.stringify({ case: kase, ok: false, error: "toolchain_mismatch", commit: sha(),
    dependencyReality: "toolchain-check-only", toolchain, supports: [], commands: [],
    notProven: ["candidate-tests-not-executed", "production-release"] }, null, 2));
  process.exit(1);
}

const sourceBefore = captureVerificationSource(root);
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
    if ((skip ?? 0) > 0 && ((pass ?? 0) === 0 || ["compact", "all", "ownership-admission", "ownership-artifact", "identity-alignment", "model-selection", "service-lifecycle", "runtime-start", "observation-monitor"].includes(kase))) failed = true;
    if ((failn ?? 0) > 0) failed = true;
  }
}

const SUPPORTS = {
  all: ["typecheck", "repository-regression-suite"],
  layout: ["layout-structure", "import-export-gates", "preload-esbuild-fence"],
  codec: ["host-context-snapshot", "ccs-chat-responses-http-oracle"],
  status: ["status-facets", "host-journal-roles", "readonly-status-ports"],
  "observation-monitor": ["scoped-batch-observations", "atomic-bounded-sqlite-images", "source-observation-time-not-arrival", "incident-cycle-ack-snooze-idempotency", "epoch-bound-pagination", "readonly-cli-zero-network-writes", "packed-node-cold-management"],
  backend: ["model-backend-port", "backend-auth-lease", "ccs-codec-prepare"],
  binding: ["selection-capture", "route-binding", "step-ledger"],
  lifecycle: ["modeld-v3-wire", "effect-unix-root"],
  "runtime-start": ["scoped-start-preparation", "source-cli-start-and-root-qualified-borrow", "packed-node-start-borrow-orderly-restart", "root-qualified-service-status", "saved-intent-is-not-running-Host", "owned-signal-output-and-later-service-failure-cleanup"],
  "service-lifecycle": ["startup-failure-and-interruption-settlement", "caller-owned-cancellation", "shutdown-timeout-is-cleanup-gap", "packed-node-start-borrow-stop", "foreign-socket-path-preserved", "root-qualified-service-reuse", "post-ready-listener-loss-settles-owner"],
  stream: ["host-fullStream", "v4-unix-host-consumer", "responses-reasoning-tool-continuation", "incomplete-finish-refusal"],
  control: ["controller-effect-program", "cli-confirmed-apply", "guardian-exact-identity-release", "guardian-disposable-process-recovery"],
  "raw-output": ["default-child-stdio-ignore", "t12-renewer-allowlist"],
  "ownership-admission": ["shared-scoped-ownership-decision", "bounded-native-read-cache", "native-pause-observation-contract", "production-unix-admission-refusal", "attempt1-after-prepare-authority-fence"],
  "identity-alignment": ["ordinary-profile-update-no-harness", "direct-daemon-update-refusal", "create-once-ownership-readback", "retired-harness-writers-refused", "unchanged-owned-native-writer-bodies"],
  "ownership-artifact": ["actual-packed-node-host-client", "actual-packed-ownership-read", "packed-client-native-pause-refusal", "source-modeld-unix-admission-positive-negative"],
  "model-selection": ["per-bot-use-reset", "explicit-reset-without-execution-authority", "packed-node-reset-without-gateway", "captured-turn-survives-future-selection", "chat-responses-host-state-pipeline", "owned-official-object-passthrough", "unavailable-selection-no-fallback", "unqualified-no-step-no-official-dispatch"],
  compact: ["confirmed-overflow-ledger", "owned-native-order-unix-sdk-recovery", "root-delegate-lifetime", "remaining-parent-budget", "exact-native-outer-turn-retry"],
};
const REALITY = {
  all: "repository-tests-owned-fixtures-local-processes-sdk-mocks-and-native-source-pins",
  layout: "offline-layout",
  codec: "offline-sdk-mock-fetch",
  status: "offline-status-facets",
  "observation-monitor": "owned-server-clock-and-gateway-fixtures-real-sqlite-images-and-fresh-packaged-node-readers-no-live-Bots",
  backend: "offline-sdk-mock-fetch",
  binding: "offline-testclock-barrier",
  lifecycle: "offline-unix-disposable",
  "runtime-start": "source-and-actual-packed-node-cli-production-unix-root-and-readonly-status-in-disposable-directories-no-model-request-or-Host-mutation",
  "service-lifecycle": "owned-real-unix-source-roots-and-packaged-node-cli-with-explicit-fault-hooks-no-provider-or-native-host",
  stream: "offline-unix-sdk-mock-host",
  control: "offline-controller-fakes-and-disposable-real-guardian-processes",
  "raw-output": "offline-helper-fd-renewer",
  compact: "offline-unix-sdk-mock-owned-host-and-explicit-host-source-pin",
  "ownership-admission": "production-kernel-unix-root-with-owned-server-clock-and-provider-fixtures",
  "identity-alignment": "owned-direct-daemon-gateway-config-and-native-shaped-writer-fixtures",
  "ownership-artifact": "packed-preload-in-owned-node-process-to-source-modeld-unix-sdk-mock-and-native-read-double",
  "model-selection": "production-config-hook-unix-kernel-sdk-mock-http-owned-official-consumer-and-packed-node-reset",
};
const NOT_PROVEN = {
  "observation-monitor": ["live-scoped-native-bridge", "cross-admission-priority-refresh", "abrupt-crash-lock-recovery", "schema-migration-backup-retention", "external-notification-delivery", "service-install-autostart", "full-T41-production-acceptance", "live-deployment"],
  "runtime-start": ["supported-service-manager-install-autostart", "persistent-credential-inference", "native-model-roundtrip", "test2-state-preservation", "live-deployment", "production-release"],
  "service-lifecycle": ["runtime-start-facade", "supported-service-manager-install-autostart", "whole-machine-recreate", "persistent-model-credential-inference", "native-model-roundtrip", "ownership-native-pause", "full-unpatched-host-rollback", "live-deployment", "production-release"],
  "ownership-admission": ["native-migration-fence-qualification", "live-scoped-server-read", "packed-native-admission", "instant-cross-server-revocation", "production-release"],
  "ownership-artifact": ["actual-native-host-startup-and-pauses", "actual-native-server-client", "packed-modeld-process", "native-migration-and-late-effects", "test2-state-preservation", "production-release"],
  "identity-alignment": ["live-writer-retirement-and-new-profile-adoption", "test2-private-state-preservation-and-repair", "live-create-update", "production-release"],
  "model-selection": ["native-official-provider-roundtrip", "native-checkpoint-new-process-recovery", "complete-Memory-episode", "original-App-route-and-Working", "multi-writer-CAS", "production-release"],
};
const report = {
  case: kase,
  commit: sha(),
  worktreeDirty: (() => {
    try { return execSync("git status --porcelain=v1 --untracked-files=normal", { cwd: root, encoding: "utf8" }).trim().length > 0; }
    catch { return null; }
  })(),
  dependencyReality: REALITY[kase] ?? "offline",
  toolchain,
  supports: failed ? [] : (SUPPORTS[kase] ?? []),
  notProven: NOT_PROVEN[kase] ?? (kase === "all" ? [
    "native-full-loop", "real-provider-overflow", "service-install-autostart",
    "production-release-review", "new-live-deployment",
  ] : kase === "compact" ? [
    "native-summary-mutation-contract", "production-model-window-qualification",
    "real-provider-overflow", "Bot-scoped-persistent-rollout", "live-adopt", "production-readiness",
  ] : [
    ...(kase === "stream" || kase === "control" ? [] : kase === "lifecycle" ? ["T26-host-fullStream"] : kase === "backend" || kase === "binding" ? ["T26-host-fullStream"] : ["inference"]),
    ...(kase === "control" ? [] : ["controller-effect-program"]),
    ...(kase === "lifecycle" || kase === "stream" ? [] : ["v3-wire-server"]),
    ...(kase === "stream" ? [] : ["Host-fullStream"]),
    ...(kase === "status" ? [] : ["status-facets"]),
    "live-adopt",
  ]),
  commands,
  ok: !failed,
};
const qualified = withVerificationSource(report, sourceBefore, captureVerificationSource(root));
console.log(JSON.stringify(qualified, null, 2));
process.exit(qualified.ok ? 0 : 1);
