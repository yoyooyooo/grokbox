import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { bindHostCompactHook, noteHostManagedStep, recordHostManagedStepFailure, resetHostCompactSlotForTests, stateSystemCompactHookOptions } from "../src/internal/host/compact.ts";
import { isHostManagedFailure } from "../src/internal/host/session.ts";
import { HOST_MANAGED_FAILURE_SYMBOL, HOST_MANAGED_STEP_FAILURE_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

for (const managed of [true, false]) {
  test(`native error receives retry provenance only from its active managed STEP (managed=${managed})`, async () => {
    resetHostCompactSlotForTests();
    class RetryableNativeError extends Error {}
    const error = new RetryableNativeError("owned native error after model completion");
    const root = { getState: () => [], executeToolStream() { throw error; } };
    const ids = { agentId: "owner-A", turnId: "turn-A", stepId: "step-A" };
    const lease = bindHostCompactHook(stateSystemCompactHookOptions())({
      ...ids, invocationId: ids.stepId, ctx: {}, stateHandler: {}, rootPromptExecutor: root,
      orchestrator: { async handleSummarization() {} }, stepClosed: () => false,
    });
    if (managed) expect(noteHostManagedStep(ids)).toBe(true);
    const scope = LIVE_SLICE_PATCHES.filter(p => ["managed-step-error-scope", "managed-output-retry-gate", "managed-summary-retry-gate"].includes(p.id));
    const transformed = transformUnchecked(LIVE_SHAPED_HOST, scope);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) throw new Error("owned scope fixture no longer matches");
    const module = { exports: {} as { compactOwner: {
      runStep(...args: unknown[]): Promise<unknown>;
      runWithMaxTokensRetry(...args: unknown[]): Promise<unknown>;
      runWithSummarizationRetry(...args: unknown[]): Promise<unknown>;
    } } };
    runInContext(transformed.source, createContext({ module, Symbol,
      OutputTokensLimitExceededError: RetryableNativeError, ProactiveSummarizationThresholdError: RetryableNativeError,
      globalThis: {
      [Symbol.for(HOST_MANAGED_STEP_FAILURE_SYMBOL)]: recordHostManagedStepFailure,
      [Symbol.for(HOST_MANAGED_FAILURE_SYMBOL)]: isHostManagedFailure,
    } }));
    try {
      // Direct scope ownership, with no provider text/name-based attribution.
      expect(recordHostManagedStepFailure({}, error)).toBe(false);
      await expect(module.exports.compactOwner.runStep({}, {}, root, {})).rejects.toBe(error);
      expect(isHostManagedFailure(error)).toBe(managed);
      let outputAttempts = 0, summaryAttempts = 0;
      await expect(module.exports.compactOwner.runWithMaxTokensRetry({}, root, async () => { outputAttempts++; throw error; })).rejects.toBe(error);
      await expect(module.exports.compactOwner.runWithSummarizationRetry({}, {}, root, async () => { summaryAttempts++; throw error; })).rejects.toBe(error);
      expect(outputAttempts).toBe(managed ? 1 : 2);
      expect(summaryAttempts).toBe(managed ? 1 : 2);
      lease?.[Symbol.dispose]();
      const later = new Error("late after scope disposal");
      expect(recordHostManagedStepFailure(root, later)).toBe(false);
      expect(isHostManagedFailure(later)).toBe(false);
    } finally { lease?.[Symbol.dispose](); resetHostCompactSlotForTests(); }
  });
}
