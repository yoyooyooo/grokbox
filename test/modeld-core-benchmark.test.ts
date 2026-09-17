import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "scripts/benchmark-modeld-core.mjs");
const { assertBenchmarkComparison } = await import(pathToFileURL(entry).href) as {
  assertBenchmarkComparison: (before: unknown, after: unknown) => void;
};
function reports() {
  const workload = [[1, 2, 4], [2048, 2, 4], [1, 5500, 1], [1, 7750, 1], [1, 9000, 1]];
  const cases = (candidate: boolean) => workload.map(([fragments, initialDelayMs, requestedSteps], index) => ({
    fragments, initialDelayMs, requestedSteps, completedSteps: requestedSteps,
    fixtureCleanupCompleted: true, modelCalls: !candidate && index >= 2 ? 0 : requestedSteps,
    nativeReads: index >= 2 && candidate ? 2 : 1, fullReads: index >= 2 && candidate ? 2 : 1,
    outcomes: Array.from({ length: requestedSteps! }, () => ({ code: !candidate && index >= 2 ? "not_admitted" : "ok",
      backendAttempts: !candidate && index >= 2 ? 0 : 1, authorityRetries: index >= 2 && candidate ? 1 : 0, terminalCount: 1 })),
  }));
  const cancellation = () => ({ modelCalls: 0, sourceCalls: 1, terminalCount: 1, sourceAbortObserved: true, fixtureCleanupCompleted: true });
  return { before: { version: 1, cases: cases(false), cancellation: cancellation() },
    after: { version: 1, cases: cases(true), cancellation: cancellation() } };
}

test("benchmark evidence checks behavior and cleanup, not just successful child exit", () => {
  const valid = reports();
  expect(() => assertBenchmarkComparison(valid.before, valid.after)).not.toThrow();
  for (const mutate of [
    (r: ReturnType<typeof reports>) => { r.after.cases[0]!.modelCalls = 8; },
    (r: ReturnType<typeof reports>) => { r.after.cases[0]!.fixtureCleanupCompleted = false; },
    (r: ReturnType<typeof reports>) => { r.after.cases[1]!.nativeReads = 2048; },
    (r: ReturnType<typeof reports>) => { r.after.cases[2]!.outcomes[0]!.code = "not_admitted"; },
    (r: ReturnType<typeof reports>) => { r.after.cases[3]!.outcomes[0]!.terminalCount = 2; },
    (r: ReturnType<typeof reports>) => { r.after.cases[4]!.initialDelayMs = 1; },
    (r: ReturnType<typeof reports>) => { r.before.cases[4]!.modelCalls = 1; },
    (r: ReturnType<typeof reports>) => { r.after.cases.pop(); },
    (r: ReturnType<typeof reports>) => { r.after.cancellation.modelCalls = 1; },
  ]) {
    const broken = reports(); mutate(broken);
    expect(() => assertBenchmarkComparison(broken.before, broken.after)).toThrow();
  }
});

test("benchmark requires an explicit separate baseline before starting any worker", () => {
  const result = spawnSync(process.execPath, [entry, "--unknown"], { cwd: root, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--baseline-root");
});
