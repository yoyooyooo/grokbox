import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProvenance } from "./build-provenance.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const box = "packages/box-runtime/test/";
const kernel = "packages/runtime-kernel/test/";

// A finite route to existing production-path tests, not a second implementation
// or a generic command dispatcher. Unimplemented gates must fail, never pass an
// empty suite. Add a case only with its ticket's real executable evidence.
const MODEL_CORE_SUITES = {
  baseline: [
    `${kernel}ownership-admission.test.ts`,
    `${box}ownership-scope-cache.test.ts`,
    `${box}host-ownership-observation.test.ts`,
    `${box}ownership-native-pause.test.ts`,
    `${box}modeld-lifecycle.test.ts`,
    `${box}architecture.test.ts`,
  ],
  lifecycle: [
    `${box}modeld-service-lifetime-parity.test.ts`,
    `${box}modeld-start-failure.test.ts`,
    `${box}modeld-running-failure.test.ts`,
    `${box}modeld-lifecycle.test.ts`,
    `${box}modeld-root-identity.test.ts`,
    `${box}modeld-service-info.test.ts`,
    `${box}runtime-start.test.ts`,
    "test/runtime-start-lifetime.test.ts",
    "test/runtime-modeld-lifetime.test.ts",
    `${box}modeld-packaged-lifecycle.test.ts`,
    `${box}runtime-start-packed.test.ts`,
  ],
  evidence: [
    `${kernel}authority-policy.test.ts`,
    `${kernel}ownership-admission.test.ts`,
    `${kernel}ownership-observation.test.ts`,
    `${box}ownership-coordinator.test.ts`,
    `${box}ownership-native-source-lifetime.test.ts`,
    `${box}host-ownership-read.test.ts`,
    `${box}host-ownership-observation.test.ts`,
    `${box}ownership-scope-cache.test.ts`,
    `${box}ownership-native-pause.test.ts`,
    `${box}ownership-observation-unix.test.ts`,
    `${box}ownership-packed-client.test.ts`,
    `${box}architecture.test.ts`,
  ],
  state: [
    `${kernel}execution-state-concurrency.test.ts`,
    `${kernel}execution-cooling-review.test.ts`,
    `${kernel}ownership-admission.test.ts`,
    `${box}execution-lifetime.test.ts`,
    `${box}execution-history-storage-review.test.ts`,
  ],
  authority: [
    `${kernel}authority-gate.test.ts`,
    `${kernel}ownership-admission.test.ts`,
    `${kernel}route-binding.test.ts`,
    `${kernel}step-ledger.test.ts`,
    `${kernel}overflow-recovery.test.ts`,
    `${box}authority-wait-unix.test.ts`,
    `${box}modeld-deadline.test.ts`,
    `${box}authority-wire.test.ts`,
    `${box}ownership-coordinator.test.ts`,
    `${box}ownership-observation-unix.test.ts`,
    `${box}ownership-packed-client.test.ts`,
    `${box}provider-recovery-unix.test.ts`,
  ],
  availability: [
    `${kernel}authority-policy.test.ts`,
    `${kernel}authority-gate.test.ts`,
    `${kernel}ownership-observation.test.ts`,
    `${box}ownership-coordinator.test.ts`,
    `${box}ownership-availability.test.ts`,
    `${box}ownership-availability-presentation.test.ts`,
    `${box}ownership-availability-unix.test.ts`,
    `${box}model-selection.test.ts`,
    "test/ownership-model-selection.test.ts",
    "test/runtime-cli.test.ts",
  ],
  "tool-contract": [
    `${box}tool-choice-contract.test.ts`,
    `${box}tool-declaration-contract.test.ts`,
    `${box}tool-contract-integration.test.ts`,
    `${box}layered-tool-diagnosis.test.ts`,
    `${box}tool-identity-framing.test.ts`,
    `${box}tool-evidence-retention.test.ts`,
    `${box}tool-identity-audit.test.ts`,
    `${box}provider-stream-node.test.ts`,
    `${box}validated-tool-batch-unix.test.ts`,
    `${box}architecture.test.ts`,
  ],
  observation: [
    `${kernel}authority-policy.test.ts`,
    `${box}authority-observation.test.ts`,
    `${box}authority-wire.test.ts`,
    `${box}modeld-outcome.test.ts`,
    `${box}monitor-ownership-diagnostic.test.ts`,
    `${box}ownership-observation-unix.test.ts`,
    "test/outcome.test.ts",
    "test/runtime-protocol-observation.test.ts",
    "test/modeld-core-verifier.test.ts",
  ],
};
export const MODEL_CORE_CASES = Object.freeze({
  ...MODEL_CORE_SUITES,
  "release-offline": [...new Set(Object.values(MODEL_CORE_SUITES).flat()),
    `${box}modeld-replace.test.ts`, `${box}t32-live-enable-readiness.test.ts`,
    `${box}context-continuity-artifact.test.ts`, "test/packaging.test.ts", "test/publication-privacy.test.ts",
    "test/modeld-core-benchmark.test.ts"],
});

export function resolveCoreCase(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 1 || !Object.hasOwn(MODEL_CORE_CASES, values[0])) {
    throw new Error(`Expected exactly one case: ${Object.keys(MODEL_CORE_CASES).join(", ")}`);
  }
  const name = values[0];
  const files = MODEL_CORE_CASES[name];
  if (!Array.isArray(files) || files.length === 0) throw new Error(`Proof case is not implemented: ${name}`);
  return { name, files: [...new Set(files)] };
}

export function isolatedProofEnvironment(env, home) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(GROKBOX_|PI_|CURSOR_|ANTHROPIC_|OPENAI_|MINIMAX_|AWS_|AZURE_|GOOGLE_)/i.test(key)
      && !/(TOKEN|SECRET|API_KEY|PASSWORD|KEYCHAIN)/i.test(key)
      && !/^(NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|LD_PRELOAD|DYLD_INSERT_LIBRARIES|BUN_RUNTIME_TRANSPILER_CACHE_PATH)$/.test(key)));
  return { ...isolated, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" };
}

export function assertProofSuites(directory, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Empty required proof suite");
  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".test.ts") || !statSync(join(directory, file)).isFile()) {
      throw new Error(`Missing required proof suite: ${file}`);
    }
  }
}

export function proofProcessSucceeded(result) {
  return !result.error && result.status === 0 && !result.signal;
}

export function runCoreProof(args) {
  const selected = resolveCoreCase(args);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const expected = String(pkg.packageManager).replace(/^bun@/, "");
  if (process.versions.bun !== expected) throw new Error(`Proof requires declared Bun ${expected}; observed ${process.versions.bun ?? "Node"}`);
  assertProofSuites(root, selected.files);
  const identity = buildProvenance(root);
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (!proofProcessSucceeded(revision)) throw new Error("Proof source revision unavailable");
  const home = mkdtempSync(join(tmpdir(), "grokbox-modeld-proof-"));
  const reality = {
    case: selected.name, bun: process.versions.bun, sourceCommit: revision.stdout.trim(),
    sourceDigest: identity.sourceDigest, compilerVersion: identity.compilerVersion, sdkVersions: identity.sdkVersions,
    effect: pkg.workspaces.catalogs["effect-v4-beta"].effect,
    dependencyReality: "production programs with synthetic capabilities and fixture-owned local resources",
    nativeQualification: "not-proven", independentReview: "pending", liveRelease: "not-run",
  };
  try {
    console.log(JSON.stringify({ ...reality, suites: selected.files, stage: "start" }));
    const env = isolatedProofEnvironment(process.env, home);
    // Packed tests must consume this source revision, not whichever dist a
    // previous test happened to leave behind in the checkout.
    if (["lifecycle", "evidence", "authority", "availability", "tool-contract", "observation", "release-offline"].includes(selected.name)) {
      const build = spawnSync(process.execPath, ["run", "build"], { cwd: root, env, stdio: "inherit", timeout: 180_000 });
      if (!proofProcessSucceeded(build)) {
        console.error(JSON.stringify({ ...reality, stage: "failed", reason: "required-build-failed" }));
        return 1;
      }
    }
    const result = spawnSync(process.execPath, ["test", "--timeout", "30000", ...selected.files], {
      cwd: root, env, stdio: "inherit", timeout: 180_000,
    });
    if (!proofProcessSucceeded(result)) {
      console.error(JSON.stringify({ ...reality, stage: "failed", status: result.status, signal: result.signal ?? null,
        reason: result.error ? "test-process-unavailable-or-timeout" : "test-failure" }));
      return 1;
    }
    if (buildProvenance(root).sourceDigest !== identity.sourceDigest) {
      console.error(JSON.stringify({ ...reality, stage: "failed", reason: "source-changed-during-proof" }));
      return 1;
    }
    console.log(JSON.stringify({ ...reality, stage: "passed-offline" }));
    return 0;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runCoreProof(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid modeld proof invocation");
    process.exitCode = 2;
  }
}
