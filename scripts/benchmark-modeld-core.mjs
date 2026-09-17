import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isolatedProofEnvironment, proofProcessSucceeded } from "./verify-modeld-core.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A benchmark result is not an acceptance success merely because both child
 * processes exited. Check the frozen workload and the actual effect counts. */
export function assertBenchmarkComparison(before, after) {
  if (before?.version !== 1 || after?.version !== 1 || before.cases?.length !== 5 || after.cases?.length !== 5) throw Error("benchmark_incomplete_report");
  for (const report of [before, after]) {
    const cancelled = report.cancellation;
    if (!cancelled || cancelled.modelCalls !== 0 || cancelled.sourceCalls !== 1 || cancelled.terminalCount !== 1
      || cancelled.sourceAbortObserved !== true || cancelled.fixtureCleanupCompleted !== true) throw Error("benchmark_cancellation_contract_failed");
  }
  const workload = [[1, 2, 4], [2048, 2, 4], [1, 5500, 1], [1, 7750, 1], [1, 9000, 1]];
  for (let index = 0; index < workload.length; index++) {
    const [fragments, initialDelayMs, requestedSteps] = workload[index];
    for (const report of [before, after]) {
      const row = report.cases[index];
      if (row.fragments !== fragments || row.initialDelayMs !== initialDelayMs || row.requestedSteps !== requestedSteps
        || row.completedSteps !== requestedSteps || !row.fixtureCleanupCompleted
        || row.outcomes.length !== requestedSteps || row.outcomes.some(outcome => outcome.terminalCount !== 1)) throw Error("benchmark_workload_or_cleanup_mismatch");
    }
    const prior = before.cases[index], next = after.cases[index];
    if (next.outcomes.some(outcome => outcome.code !== "ok" || outcome.backendAttempts !== 1)
      || next.modelCalls !== requestedSteps) throw Error("benchmark_candidate_effect_contract_failed");
    if (index < 2) {
      if (prior.outcomes.some(outcome => outcome.code !== "ok") || prior.modelCalls !== requestedSteps
        || next.nativeReads > requestedSteps * 2 || next.fullReads > requestedSteps * 2) throw Error("benchmark_fragment_amplification");
    } else if (prior.outcomes[0].code !== "not_admitted" || prior.modelCalls !== 0
      || next.nativeReads !== 2 || next.outcomes[0].authorityRetries !== 1) throw Error("benchmark_latency_recovery_not_observed");
  }
}

/** Read-only checkout comparison. Neither source checkout is built or mutated;
 * worker services/storage live only in their own temporary fixture roots. */
export function runBenchmark(args) {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || values[0] !== "--baseline-root") throw Error("Expected --baseline-root <source-checkout>");
  const baseline = resolve(values[1]);
  if (baseline === root) throw Error("Baseline and candidate must be different checkouts");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.packageManager !== `bun@${process.versions.bun}`) throw Error("Run benchmark with declared Bun");
  const git = (directory, ...command) => {
    const result = spawnSync("git", ["-C", directory, ...command], { encoding: "utf8" });
    if (!proofProcessSucceeded(result)) throw Error("benchmark_git_source_unavailable");
    return result.stdout.trim();
  };
  if (git(baseline, "status", "--porcelain").length) throw Error("Benchmark baseline must be clean");
  const baselineCommit = git(baseline, "rev-parse", "HEAD"), candidateCommit = git(root, "rev-parse", "HEAD");
  const candidateDirty = git(root, "status", "--porcelain").length > 0;
  const home = mkdtempSync(join(tmpdir(), "modeld-benchmark-home-"));
  try {
    const run = directory => {
      const result = spawnSync(process.execPath, [join(root, "scripts/modeld-hotpath-worker.mjs"), directory, "latency"], {
        cwd: directory, env: isolatedProofEnvironment(process.env, home), encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
      });
      if (!proofProcessSucceeded(result)) throw Error(`benchmark_worker_failed: ${result.stderr.slice(-2000)}`);
      const lines = result.stdout.trim().split("\n");
      const report = JSON.parse(lines.at(-1));
      if (report.version !== 1 || report.cases.length !== 5 || report.cases.some(c => !c.fixtureCleanupCompleted)) throw Error("benchmark_incomplete_report");
      return report;
    };
    const before = run(baseline), after = run(root);
    if (JSON.stringify(before.toolchain) !== JSON.stringify(after.toolchain)) throw Error("benchmark_toolchain_not_comparable");
    assertBenchmarkComparison(before, after);
    if (git(root, "rev-parse", "HEAD") !== candidateCommit) throw Error("benchmark_candidate_changed");
    if (git(baseline, "rev-parse", "HEAD") !== baselineCommit || git(baseline, "status", "--porcelain").length) throw Error("benchmark_baseline_changed");
    const report = { version: 1, workload: "four sequential STEPs at 1/2048 fragments; fixed 5.5/7.75/9s first reads; cancellation during initial source wait",
      baselineCommit, candidateCommit, candidateDirty, before, after,
      comparison: before.cases.map((previous, i) => ({ fragments: previous.fragments, initialDelayMs: previous.initialDelayMs,
        beforeOutcome: previous.outcomes.at(-1)?.code, afterOutcome: after.cases[i].outcomes.at(-1)?.code,
        beforeModelCalls: previous.modelCalls, afterModelCalls: after.cases[i].modelCalls,
        beforeNativeReads: previous.nativeReads, afterNativeReads: after.cases[i].nativeReads })),
      qualification: { hotPathVectors: "executed", historicalComparison: "source-programs-not-official-server-latency", native: "not-proven", independentReview: "pending", live: "not-run" } };
    console.log(JSON.stringify(report));
    return 0;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runBenchmark(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : "benchmark_failed"); process.exitCode = 1; }
}
