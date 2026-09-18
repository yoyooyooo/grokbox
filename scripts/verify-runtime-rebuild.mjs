#!/usr/bin/env node
import { spawnSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureVerificationSource, withVerificationSource } from "./verification-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const kase = process.argv[2];
if (!kase || process.argv.length !== 3) {
  console.error("usage: bun scripts/verify-runtime-rebuild.mjs <case>");
  process.exit(1);
}

const CONTEXT_TESTS = [
  "packages/runtime-kernel/test/context-policy.test.ts", "packages/runtime-kernel/test/context-selection.test.ts", "packages/box-runtime/test/context-reuse.test.ts",
  "packages/box-runtime/test/context-maintenance-summary.test.ts", "packages/box-runtime/test/context-maintenance-host.test.ts",
  "packages/box-runtime/test/context-maintenance-provider-switch.test.ts",
  "packages/box-runtime/test/context-maintenance-boundaries.test.ts", "packages/box-runtime/test/context-maintenance-lifetime.test.ts", "packages/box-runtime/test/context-maintenance-control.test.ts",
  "test/context-commands.test.ts", "packages/box-runtime/test/reviewed-profile-write-lineage.test.ts",
];
const CASES = {
  "continuity-native-binding": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "--timeout", "30000", "packages/runtime-kernel/test/current-state-wire.test.ts", "packages/box-runtime/test/native-checkpoint-worker.test.ts", "packages/box-runtime/test/native-current-state-owner.test.ts", "packages/box-runtime/test/continuity-state-migration.test.ts", "test/agent-state-commands.test.ts", "packages/box-runtime/test/continuity-current-state.test.ts", "packages/box-runtime/test/current-state-process.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["node", "scripts/check-runtime-boundaries.mjs"], ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "continuity-native-binding-qualified": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "--timeout", "30000", "packages/box-runtime/test/native-worker-binding.test.ts", "packages/box-runtime/test/native-checkpoint-qualification.test.ts", "packages/box-runtime/test/native-checkpoint-process.test.ts"],
    ["node", "scripts/check-runtime-boundaries.mjs"], ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "continuity-native-checkpoint": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/native-checkpoint.test.ts", "packages/runtime-kernel/test/current-state-contract.test.ts", "packages/box-runtime/test/continuity-current-state.test.ts", "packages/box-runtime/test/continuity-store.test.ts", "packages/box-runtime/test/obs-continuity-contract.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["node", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "continuity-native-checkpoint-qualified": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "--timeout", "30000", "packages/box-runtime/test/native-checkpoint.test.ts", "packages/box-runtime/test/native-checkpoint-qualification.test.ts", "packages/box-runtime/test/native-checkpoint-process.test.ts"],
    ["node", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "continuity-current-state": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/current-state-contract.test.ts", "packages/box-runtime/test/continuity-current-state.test.ts", "packages/box-runtime/test/current-state-process.test.ts"],
    ["bun", "test", "packages/runtime-kernel/test/continuity-material.test.ts", "packages/box-runtime/test/continuity-store.test.ts", "packages/box-runtime/test/continuity-process.test.ts", "packages/box-runtime/test/obs-continuity-contract.test.ts"],
    ["bun", "test", "packages/box-runtime/test/context-maintenance-boundaries.test.ts", "packages/box-runtime/test/context-maintenance-control.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts", "packages/box-runtime/test/monitor-commit-boundaries.test.ts"],
    ["node", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "continuity-store": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/continuity-material.test.ts", "packages/box-runtime/test/continuity-store.test.ts", "packages/box-runtime/test/continuity-process.test.ts", "packages/box-runtime/test/obs-continuity-contract.test.ts"],
    ["bun", "test", "packages/box-runtime/test/monitor-store.test.ts", "packages/box-runtime/test/monitor-commit-boundaries.test.ts", "packages/box-runtime/test/storage-maintenance-lifetime.test.ts", "packages/box-runtime/test/context-maintenance-boundaries.test.ts", "packages/box-runtime/test/context-maintenance-control.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "test", "packages/box-runtime/test/architecture.test.ts", "--timeout", "15000"],
    ["node", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "obs-continuity": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/obs-continuity-contract.test.ts", "packages/box-runtime/test/monitor-store.test.ts", "packages/box-runtime/test/alert-observability-store.test.ts", "packages/box-runtime/test/storage-maintenance-lifetime.test.ts", "packages/box-runtime/test/storage-footprint.test.ts", "test/monitor-incident-cli.test.ts", "test/incident-observability.test.ts"],
    ["bun", "test", "test/ops-storage-config-migration.test.ts", "packages/runtime-kernel/test/ops-notice-storage-config.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "agent-routines": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/agent-routines.test.ts", "test/agent-routines-cli.test.ts", "test/daemon.test.ts", "test/capabilities_gateway_server_url.test.ts", "test/skills.test.ts"],
    ["bun", "test", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "storage-lifetime": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/storage-maintenance-lifetime.test.ts", "packages/box-runtime/test/storage-footprint.test.ts", "packages/box-runtime/test/process-log-rotation.test.ts", "packages/box-runtime/test/storage-configuration-owner.test.ts"],
    ["bun", "test", "packages/box-runtime/test/modeld-running-failure.test.ts", "packages/box-runtime/test/modeld-start-failure.test.ts", "packages/box-runtime/test/modeld-packaged-lifecycle.test.ts", "packages/box-runtime/test/journal-policy-adoption.test.ts", "test/monitor-incident-cli.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "journal-maintenance": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/journal-policy-adoption.test.ts", "packages/box-runtime/test/journal-lock-recovery.test.ts", "packages/box-runtime/test/storage-configuration-owner.test.ts"],
    ["bun", "test", "packages/box-runtime/test/journal-segment-rotation.test.ts", "packages/box-runtime/test/host-journal.test.ts", "packages/box-runtime/test/modeld-outcome.test.ts", "packages/box-runtime/test/monitor-scheduling-review.test.ts", "test/incident-observability.test.ts", "test/monitor-incident-cli.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "storage-config": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/ops-notice-storage-config.test.ts", "test/ops-storage-config-migration.test.ts", "packages/box-runtime/test/storage-configuration-owner.test.ts"],
    ["bun", "test", "packages/runtime-kernel/test/unified-config.test.ts", "packages/runtime-kernel/test/context-policy.test.ts", "packages/box-runtime/test/config-migration.test.ts", "test/config-cli.test.ts", "test/config-packed.test.ts", "test/config-domain-invalidation.test.ts", "test/config-application-receipt.test.ts", "packages/box-runtime/test/modeld-packaged-lifecycle.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "journal-rotation": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/journal-segment-rotation.test.ts", "test/incident-observability.test.ts", "test/runtime-incident.test.ts", "test/monitor-incident-cli.test.ts", "packages/box-runtime/test/monitor-scheduling-review.test.ts", "packages/box-runtime/test/alert-observability-store.test.ts"],
    ["bun", "test", "packages/box-runtime/test/host-journal.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "process-log-rotation": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/process-log-rotation.test.ts", "packages/box-runtime/test/process-log-modeld.test.ts", "packages/box-runtime/test/modeld-running-failure.test.ts", "packages/box-runtime/test/modeld-packaged-lifecycle.test.ts", "test/monitor-incident-cli.test.ts"],
    ["bun", "test", "packages/box-runtime/test/modeld-lifecycle.test.ts", "packages/box-runtime/test/modeld-start-failure.test.ts", "test/runtime-modeld-lifetime.test.ts", "packages/box-runtime/test/context-continuity-artifact.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
    ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "observation-evidence": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/observation-evidence-contract.test.ts", "packages/runtime-kernel/test/observation-evidence-privacy.test.ts", "packages/box-runtime/test/incident-evidence-store.test.ts", "packages/box-runtime/test/observation-storage-pressure.test.ts", "packages/box-runtime/test/monitor-scheduling-review.test.ts", "test/monitor-incident-cli.test.ts"],
    ["bun", "test", "packages/box-runtime/test/monitor-migration-review.test.ts", "packages/box-runtime/test/monitor-crash-node.test.ts", "test/incident-observability.test.ts", "test/publication-privacy.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"], ["node", "scripts/check-publication.mjs", "--include-untracked"],
  ],
  "context-reuse": [
    ["bun", "run", "build"],
    ["bun", "test", "packages/box-runtime/test/context-reuse.test.ts", "packages/box-runtime/test/context-maintenance-summary.test.ts", "packages/box-runtime/test/context-maintenance-packed.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
  ],
  "context-policy": [
    ["bun", "run", "typecheck"],
    ["bun", "test", "packages/runtime-kernel/test/context-policy.test.ts", "packages/runtime-kernel/test/context-selection.test.ts", "packages/runtime-kernel/test/unified-config.test.ts", "packages/box-runtime/test/config-migration.test.ts", "test/config-cli.test.ts"],
  ],
  "context-owner": [
    ["bun", "test", "packages/runtime-kernel/test/context-selection.test.ts", "packages/box-runtime/test/context-maintenance-host.test.ts", "packages/box-runtime/test/context-maintenance-boundaries.test.ts", "packages/box-runtime/test/context-maintenance-lifetime.test.ts", "packages/box-runtime/test/context-maintenance-control.test.ts", "test/context-commands.test.ts"],
  ],
  "context-summary": [
    ["bun", "test", "packages/box-runtime/test/context-reuse.test.ts", "packages/box-runtime/test/context-maintenance-summary.test.ts", "packages/box-runtime/test/context-maintenance-provider-switch.test.ts", "packages/box-runtime/test/context-maintenance-lifetime.test.ts", "packages/runtime-kernel/test/overflow-recovery.test.ts"],
  ],
  "context-maintenance": [
    ["bun", "run", "typecheck"], ["bun", "run", "build"],
    ["bun", "test", ...CONTEXT_TESTS],
    ["bun", "test", "packages/box-runtime/test/context-maintenance-packed.test.ts", "test/config-packed.test.ts", "packages/box-runtime/test/authority-wire.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
  ],
  "context-native": [["bun", "test", "packages/box-runtime/test/context-native-qualification.test.ts"]],
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
    ["bun", "test", "packages/box-runtime/test/host-codec.test.ts", "packages/box-runtime/test/openai-prompt-adapter.test.ts"],
  ],
  status: [
    ["bun", "test", "packages/runtime-kernel/test/status-facets.test.ts", "packages/box-runtime/test/host-journal.test.ts", "packages/box-runtime/test/observe-status.test.ts"],
    ["bun", "test", "test/runtime-cli.test.ts"],
  ],
  backend: [
    ["bun", "test", "packages/runtime-kernel/test/backend-contract.test.ts", "packages/box-runtime/test/backend-conformance.test.ts"],
    ["bun", "test", "packages/box-runtime/test/host-codec.test.ts", "packages/box-runtime/test/openai-prompt-adapter.test.ts"],
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
  "config-unification": [
    ["bun", "run", "typecheck"],
    ["bun", "run", "build"],
    ["bun", "test", "packages/runtime-kernel/test/unified-config.test.ts", "packages/box-runtime/test/unified-config-store.test.ts", "packages/box-runtime/test/config-lock.test.ts", "packages/box-runtime/test/config-migration.test.ts", "packages/box-runtime/test/config-bootstrap.test.ts", "packages/box-runtime/test/config-aliases.test.ts"],
    ["bun", "test", "test/config-cli.test.ts", "test/config-application-receipt.test.ts", "test/config-domain-invalidation.test.ts", "test/config-packed.test.ts", "test/profile.test.ts", "test/operator.test.ts", "test/desktop.test.ts", "test/skills.test.ts", "test/models-command-surface.test.ts", "test/ownership-model-selection.test.ts"],
    ["bun", "scripts/check-runtime-boundaries.mjs"],
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

const mapped = Object.hasOwn(CASES, kase) ? CASES[kase] : undefined;
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

if (["continuity-native-checkpoint-qualified", "continuity-native-binding-qualified"].includes(kase) && process.env.GROKBOX_TEST_NATIVE_CONTINUITY !== "1") {
  console.log(JSON.stringify({ case: kase, ok: false, error: "native_continuity_opt_in_required", commit: sha(),
    dependencyReality: "opt-in-check-only", toolchain, supports: [], commands: [],
    notProven: ["native-tests-not-executed", "installed-Host-binding"] }, null, 2));
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
    if ((skip ?? 0) > 0 && ((pass ?? 0) === 0 || kase.startsWith("context-") || kase.startsWith("continuity-native-") || ["compact", "all", "ownership-admission", "ownership-artifact", "identity-alignment", "model-selection", "service-lifecycle", "runtime-start", "observation-monitor"].includes(kase))) failed = true;
    if ((failn ?? 0) > 0) failed = true;
  }
}

const SUPPORTS = {
  "continuity-native-binding": ["finite-local-CLI-and-authenticated-RPC", "explicit-CONT-v1-to-v2-saved-request-migration", "bounded-original-worker-transaction-adapter", "root-graph-and-worker-marker-atomicity", "durable-main-and-worker-preparation-fences", "virgin-target-evidence-not-missing-root", "late-checkpoint-and-completion-refusal", "explicit-initialize-reconcile-release-no-business-start", "B2-progress-not-overwritten", "profile-upgrade-preserves-baseline"],
  "continuity-native-binding-qualified": ["exact-Host-worker-pair-and-unique-new-slices", "maintained-opt-in-profile-and-complete-envelope", "original-worker-thread-node-sqlite-transaction", "worker-persistent-marker-and-GC-fence-across-reopen", "native-capture-prepare-apply-observe-release-protocol", "native-graph-and-new-Node-readback", "source-independent-B2-idempotency"],
  "continuity-native-checkpoint": ["bounded-native-reference-walker", "all-declared-edges-including-cycles", "opaque-leaf-encoding-and-syntax", "root-and-closure-readback-not-activation", "no-default-native-binding", "current-state-and-real-vault-regression"],
  "continuity-native-checkpoint-qualified": ["separately-pinned-installed-Host-worker-protobuf-pair", "native-schema-archive-and-historical-root-closure", "original-AgentStore-checkpoint-and-reset-semantics", "original-partial-write-is-not-no-effect", "strict-root-and-closure-readback", "original-writer-and-fresh-Node-reader-after-owned-source-removal", "production-window-codec-projection-not-Agent-loop"],
  "continuity-current-state": ["finite-native-capability-no-default-binding", "immutable-capture-under-owner-boundary", "source-revision-drift-refusal", "context-only-initialization-with-durable-effect-claim", "original-ownership-age-rechecked-at-dispatch", "native-reopen-and-marker-before-ledger-settlement", "unknown-never-reimports-or-activates", "b2-progress-survives-initialization-reentry", "owned-node-process-kill-and-readback", "no-human-message-or-background-native-writer"],
  "continuity-store": ["real-scoped-recovery-and-safety-sqlite-owners", "declared-graph-hash-checked-immutable-material", "publication-reservation-reconciliation-no-false-success", "two-phase-reference-safe-object-gc", "last-readable-fallback-retained", "content-bound-effect-intent-and-single-dispatch-claim", "unknown-is-not-retryable", "real-cont-owner-j1-diagnostic-expiry-integration", "node-process-reopen-kill-boundaries-and-concurrent-claim", "read-only-private-bounded-status"],
  "obs-continuity": ["typed-continuity-intake-existing-sqlite-outbox", "source-zero-based-cursor-gap-and-reentry", "notification-off-not-domain-completion", "fixed-owner-reference-gc-serialization-contract", "owned-recovery-closure-survives-diagnostic-expiry", "capacity-degradation-not-effect-authorization", "unmeasured-not-zero-and-shared-allocation-deduplication", "owner-write-settles-before-supervised-exit"],
  "agent-routines": ["bounded-native-definition-projection", "exact-id-revision-confirm-before-write", "no-native-cas-claim", "single-mutation-and-readback-unknown-not-retry", "local-and-daemon-share-program", "packed-node-routine-management", "no-credential-mint-create-or-invoke"],
  "storage-lifetime": ["modeld-owner-maintenance-no-collector-required", "ops-off-gc-no-model-or-gateway", "settled-child-before-log-listener-close", "fixed-delay-no-overlap-no-fast-retry", "idle-closed-process-segments-only", "bounded-private-maintenance-receipt", "packed-node-owner-death-observed-not-repaired", "bounded-metadata-footprint-with-inode-deduplication"],
  "journal-maintenance": ["canonical-journal-policy-at-real-writer", "last-successful-write-witness-not-config-save", "confirmed-policy-shrink-with-explicit-retirement", "scope-owned-journal-housekeeping-no-rpc-or-bot", "busy-writer-housekeeping-skip", "exact-dead-owner-directory-lock-recovery", "real-process-death-during-rotation-no-append-replay", "bounded-preparation-slots-and-readonly-lock-metadata", "packed-node-host-hook-and-post-crash-write"],
  "storage-config": ["explicit-config4-migration-no-support-resurrection", "validated-single-storage-intent-and-allocation", "storage-only-dependency-revision", "preserved-model-bytes-and-disabled-notifications", "migration-crash-recovery-and-confirmed-config-writes", "configured-monitor-ttl-and-modeld-log-cap", "offline-evidence-survives-broken-config", "pending-adoption-not-fake-applied"],
  "journal-rotation": ["shared-writer-byte-rotation", "durable-segment-cursor-resume", "bounded-registered-journal-data", "retirement-gap-not-fake-health", "rotation-intent-recovery-no-append-replay", "sealed-partial-tail", "packed-node-closed-segment-lookup", "fixed-incident-survives-source-eviction", "no-query-recovery-or-gc"],
  "process-log-rotation": ["writer-owned-modeld-segments", "bounded-multi-generation-disk", "partial-tail-not-reappended", "borrower-does-not-rotate", "diagnostic-failure-does-not-block-modeld", "packaged-node-replacement-no-raw-log-fd", "independent-read-only-storage-facets"],
  "observation-evidence": ["unknown-tray-and-no-step-failure-intake", "immutable-revision-node-cli-read", "public-structure-without-private-identities", "bounded-revisions-and-shared-leases", "sqlite-file-growth-guard-and-retention-resume", "slow-rpc-independent-local-drain", "explicit-v2-migration-no-backlog-wake", "read-only-storage-status", "untracked-source-privacy-scan"],
  "context-reuse": ["pinned-pi-controlled-extraction", "independent-cut-and-usage-goldens", "untruncated-summary-input", "real-sdk-request-owner", "packed-host-process-reopen"],
  "context-policy": ["strict-config-v3", "explicit-v2-migration", "local-window-and-output-reserve", "per-model-per-bot-policy-revision", "unknown-usage-local-measurement"],
  "context-owner": ["pre-main-http-maintenance", "native-facade-accept-fence", "pending-owner-cancellation", "late-root-and-checkpoint-faults", "shared-source-cancellation", "durable-manual-noop", "confirmed-cli-control"],
  "context-summary": ["pi-cut-plan-and-templates", "complete-tool-tail-material", "bounded-summary-request-budget", "blank-tool-and-incomplete-rejection", "narrow-overflow-recovery"],
  "context-maintenance": ["local-budget-old-failed-context", "new-input-exactly-once-in-owned-host", "ten-maintenance-cycles", "new-node-process-checkpoint-reuse", "actual-packed-host-client", "shared-effect-sdk-owner", "config-v3-and-wire-v8", "preload-import-fence"],
  "context-native": ["pinned-native-summarizer-and-archive-accept-methods", "actual-native-carrier-and-durable-block-rendering", "no-native-provider-inference", "all-current-native-slices-unique"],
  all: ["typecheck", "repository-regression-suite"],
  "config-unification": ["strict-v3-schema-and-paths", "shared-cas-domain-writer", "client-box-scope-isolation", "consumer-specific-application-receipts", "operation-crash-reconciliation", "one-way-migration-recovery", "bootstrap-rollback-preserves-later-edits", "alias-repair-preserves-detached-files", "models-and-domain-revision-isolation", "source-and-packed-node-cli", "preload-import-fence"],
  layout: ["layout-structure", "import-export-gates", "preload-esbuild-fence"],
  codec: ["host-context-snapshot", "openai-prompt-http-oracle"],
  status: ["status-facets", "host-journal-roles", "readonly-status-ports"],
  "observation-monitor": ["scoped-batch-observations", "atomic-bounded-sqlite-images", "source-observation-time-not-arrival", "incident-cycle-ack-snooze-idempotency", "epoch-bound-pagination", "readonly-cli-zero-network-writes", "packed-node-cold-management"],
  backend: ["model-backend-port", "backend-auth-lease", "openai-prompt-prepare"],
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
  "continuity-native-binding": "production-coordinator-RPC-client-private-CONT-SQLite-bounded-worker-adapter-owned-native-metadata-projections-local-HTTP-CLI-Node20-no-live-Bot-effects",
  "continuity-native-binding-qualified": "actual-pinned-original-worker-thread-and-node-sqlite-owned-temporary-databases-original-protobuf-AgentStore-new-processes-no-main-Host-startup-no-provider",
  "continuity-native-checkpoint": "production-capture-and-readback-public-reflection-fixture-real-SQLite-vault-owned-current-state-port-no-private-source-or-live-effects",
  "continuity-native-checkpoint-qualified": "selected-original-protobuf-and-AgentStore-from-exact-installed-source-pair-isolated-VM-owned-file-ports-production-vault-new-Node-processes-no-full-Host-or-provider",
  "continuity-current-state": "production-Effect-coordinator-real-private-SQLite-and-content-store-owned-synthetic-native-port-actual-window-codec-packed-Node-SIGKILL-no-installed-Host-binding-or-provider-effects",
  "continuity-store": "production-Effect-programs-real-temporary-private-SQLite-and-content-files-synthetic-material-pinned-Bun-source-packaged-Node-workers-owned-SIGKILL-no-live-Bot-or-provider-effects",
  "obs-continuity": "real-temporary-files-journal-sqlite-and-owned-recovery-adapter-existing-effect-lifetime-no-native-bot-or-network-effects",
  "agent-routines": "synthetic-native-http-boundary-real-cli-daemon-effect-program-and-packed-node-no-live-native-writes",
  "storage-lifetime": "real-owned-sqlite-files-source-and-packed-node-modeld-injected-clock-lifetime-barriers-metadata-only-footprint-no-live-state-or-provider-effects",
  "journal-maintenance": "canonical-temporary-config-real-files-sqlite-linux-process-identities-owned-child-SIGKILL-and-packed-node-host-hook-no-live-state-or-model-requests",
  "storage-config": "strict-kernel-schema-production-migrator-real-owned-files-sqlite-source-modeld-and-packed-node-cli-no-live-config-or-model-spend",
  "journal-rotation": "real-owned-files-and-sqlite-source-writers-rotation-stage-faults-and-packed-node-readers-no-native-host-or-provider-effects",
  "process-log-rotation": "real-private-files-real-unix-modeld-source-root-and-disposable-packaged-node-replacement-no-Host-or-provider-effects",
  "observation-evidence": "production-collector-and-sqlite-writers-real-temporary-databases-files-and-packaged-node-cli-owned-rpc-and-native-event-fixtures-no-live-mutations",
  "context-reuse": "selected-pi-source-extraction-real-sdk-local-http-and-packaged-host-no-global-pi-or-external-provider",
  "context-policy": "pure-policy-real-temporary-config-files-and-explicit-migrator",
  "context-owner": "production-effect-program-and-host-facade-owned-native-methods-real-unix-http-leveldb",
  "context-summary": "real-pi-derived-algorithm-real-sdk-local-http-and-bounded-provider-substitutes",
  "context-maintenance": "production-kernel-real-sdk-local-http-unix-actual-packed-host-owned-native-store-and-fresh-node-processes",
  "context-native": "exact-pinned-native-methods-in-isolated-vm-blob-telemetry-and-privacy-capability-substitutes-no-live-host",
  all: "repository-tests-owned-fixtures-local-processes-sdk-mocks-and-native-source-pins",
  "config-unification": "source-and-packed-node-cli-real-temporary-files-disposable-processes-fake-gateway-no-live-config-or-native-host-mutation",
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
  "continuity-native-binding": ["installed-profile-and-worker-reload", "first-real-Agent-loop-and-provider-request", "full-Memory-display-history-resource-import", "reset-semantic-recovery-spawn-clone-and-replace-products", "automatic-protection-and-handover", "independent-external-review-and-live-adoption"],
  "continuity-native-binding-qualified": ["entire-main-Host-lifecycle-with-actual-App", "production-client-and-profile-adoption", "same-Box-identity-creation-first-turn-and-Host-restart", "real-Memory-display-history-resource-import", "full-J2-notification-inbound-and-retirement", "independent-external-review-and-live-adoption"],
  "continuity-native-checkpoint": ["installed-schema-qualification", "native-exclusive-read-and-writer-boundary", "cross-identity-import-or-application-marker", "complete-Memory-display-history-and-attachments", "original-Agent-loop-and-provider", "independent-review-and-live"],
  "continuity-native-checkpoint-qualified": ["full-Host-native-storage-transaction-and-preparation-fence", "installed-production-capture-binding", "cross-identity-initialization-and-persistent-application-marker", "original-Agent-loop-or-first-provider-request", "complete-Memory-display-history-and-file-resources", "modeld-live-adoption", "independent-review-and-live"],
  "continuity-current-state": ["installed-native-schema-decoder-and-writer-qualification", "actual-Host-preparation-fence-and-cross-identity-import", "first-real-Agent-loop-or-provider-request", "reset-recover-spawn-or-clone-cli", "memory-transcript-attachment-import", "production-config-authority-composition-and-owner-installation", "full-j2-notification-inbound-and-handover", "independent-review-and-live-cutover"],
  "continuity-store": ["native-Bot-capture-schema-and-current-state-import", "configuration-policy-binding-and-production-owner-installation", "actual-clone-start-and-duty-handover", "safety-tombstone-retirement-and-endless-operation-capacity", "full-installation-physical-reservations", "arbitrary-power-loss-or-backup-rollback", "native-notification-and-temporal-inbound", "independent-review-and-live-cutover"],
  "obs-continuity": ["native-recovery-owner-import-and-operation-ledger", "real-temporal-inbound-coverage", "native-notification-delivery-and-unknown-reconciliation", "replacement-relationship-migration-and-bot-retirement", "installation-wide-reservations", "cross-store-atomicity", "independent-review-and-live-schema4-adoption"],
  "agent-routines": ["native-http-management-roundtrip", "durable-create-apply-provisioning", "native-webhook-http-authentication-and-invoke", "bot-delivery-or-user-read", "target-pairing-and-model-qualification", "in-flight-run-cancellation", "independent-review", "live-cutover"],
  "storage-lifetime": ["full-installation-reservations-and-all-owners", "modeld-autostart-after-box-reboot", "native-bot-delivery", "execution-safety-retirement", "arbitrary-power-loss-storage-repair", "aggregate-storage-config-applied", "independent-review", "live-cutover"],
  "journal-maintenance": ["installation-wide-physical-reservations", "legacy-pid-only-lock-retirement", "arbitrary-power-loss-or-torn-owner-index-repair", "all-storage-owner-hot-reload", "service-install-autostart", "native-bot-notification", "independent-review", "live-adoption"],
  "storage-config": ["installation-wide-physical-reservations", "journal-writer-config-adoption", "live-config4-cutover", "persistent-service-owner", "aggregate-storage-applied-receipt", "native-webhook-and-bot-delivery", "independent-review"],
  "journal-rotation": ["whole-installation-budget", "arbitrary-power-loss-or-torn-manifest-recovery", "hard-crash-events-lock-recovery", "native-host-adoption", "persistent-service-installation", "native-bot-notification", "independent-review", "live-adoption"],
  "process-log-rotation": ["installation-wide-storage-budget", "structured-journal-rotation", "other-process-log-producers", "native-webhook-delivery", "persistent-service-installation", "independent-review", "live-adoption"],
  "observation-evidence": ["all-native-boundary-instrumentation", "installation-wide-diagnostic-budget", "process-journal-rotation", "execution-safety-state-retirement", "native-webhook-pairing-and-bot-delivery", "persistent-service-installation", "independent-review", "live-adoption"],
  "context-reuse": ["live-native-context-adoption", "real-provider-summary-quality", "independent-review", "pi-ai-backend-adoption"],
  "context-policy": ["live-config-migration-and-adoption", "arbitrary-provider-tokenizer-equivalence", "native-prompt-delivery"],
  "context-owner": ["loaded-native-abi", "actual-native-store-checkpoint-restart", "original-App-activity", "independent-review"],
  "context-summary": ["real-provider-summary-quality", "all-provider-tokenizer-equivalence", "native-store-and-App"],
  "context-maintenance": ["live-native-adoption", "real-provider-user-journey", "native-checkpoint-service-restart", "original-App-observation", "independent-review", "production-release"],
  "context-native": ["live-loaded-Host", "native-storage-service-crash-atomicity", "real-provider-inference", "original-App", "independent-review"],
  "config-unification": ["production-config-migration", "platform-Reset-and-home-restoration", "remote-config-write-capability", "native-webhook-ops-workers", "independent-code-review", "live-deployment"],
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
