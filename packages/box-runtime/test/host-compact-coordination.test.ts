import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { bindHostCompactHook, isHostManagedRootActive, noteHostManagedStep, resetHostCompactSlotForTests, stateSystemCompactHookOptions } from "../src/internal/host/compact.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";

// Owned control-flow fixture: eager model entry precedes two native summary launch sites.
// Literal call-site anchors are the compatibility seam, not a copied native implementation.
const SOURCE = `
var requestIdKey = "turn";
function __addDisposableResource22(env, value) { env.stack.push(value); }
module.exports = async function execute(input) {
  const env_2 = { stack: [] };
  const ctx = input.ctx;
  const stateHandler = input.stateHandler;
  const rootPromptExecutor = input.root;
  const requestContext = {};
  const invocationId = input.stepId;
  const startBackgroundSummary = async () => { input.counts.background++; };
  try {
    let result;
        result = rootPromptExecutor.executeToolStream(
          ctx
        );
        await startBackgroundSummary();
    let stepClosed = false;
      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {
        input.counts.response++;
        return currentUsage;
      });
      let response, extendedUsage, usage, finalInvocationId;
        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([
          result.response, result.extendedUsage, Promise.resolve(), responseSummaryLaunch
        ]);
    stepClosed = true;
    return response;
  } finally {
    for (const value of env_2.stack.reverse()) value[Symbol.dispose]();
  }
};
`;

for (const mode of ["managed", "official", "missing-hook"] as const) {
  test(`native summary coordination preserves ${mode} behavior and releases its root`, async () => {
    resetHostCompactSlotForTests();
    const patches = LIVE_SLICE_PATCHES.filter((p) => p.id.startsWith("compact-"));
    const transformed = transformUnchecked(SOURCE, patches);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;
    const tuple = { agentId: "agent", turnId: "turn", stepId: "step" };
    const root = {
      executeToolStream() {
        expect(isHostManagedRootActive(root)).toBe(false);
        if (mode === "managed") expect(noteHostManagedStep(tuple)).toBe(true);
        expect(isHostManagedRootActive(root)).toBe(mode === "managed");
        expect(isHostManagedRootActive({})).toBe(false);
        return { response: Promise.resolve("done"), extendedUsage: Promise.resolve({ tokens: 9 }) };
      },
      getState: () => [{ role: "system", content: "root" }, { role: "user", content: "body" }],
    };
    const globals: Record<symbol, unknown> = {};
    if (mode !== "missing-hook") {
      globals[Symbol.for(HOST_COMPACT_SYMBOL)] = bindHostCompactHook(stateSystemCompactHookOptions());
      globals[Symbol.for(HOST_MANAGED_STEP_SYMBOL)] = isHostManagedRootActive;
    }
    const module = { exports: undefined as unknown as (input: unknown) => Promise<string> };
    runInContext(transformed.source, createContext({ module, Symbol, globalThis: globals }));
    const counts = { background: 0, response: 0 };
    const owner = {
      orchestrator: { async handleSummarization() { throw new Error("must-not-compact"); } },
      config: { conversationGroupId: tuple.agentId }, interactionListener: {}, resourceAccessor: {},
    };
    expect(await module.exports.call(owner, {
      root, counts, stepId: tuple.stepId, stateHandler: { backgroundSummarizationPromiseInfo: null },
      ctx: { get: () => tuple.turnId, signal: { aborted: false } },
    })).toBe("done");
    expect(counts).toEqual(mode === "managed" ? { background: 0, response: 0 } : { background: 1, response: 1 });
    expect(isHostManagedRootActive(root)).toBe(false);
    expect(noteHostManagedStep(tuple)).toBe(false);
  });
}

test("a wrong tuple cannot suppress native summaries of another root", () => {
  resetHostCompactSlotForTests();
  const root = { getState: () => [] };
  const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
    orchestrator: { async handleSummarization() {} }, ctx: {}, stateHandler: {}, rootPromptExecutor: root,
    invocationId: "step", turnId: "turn", agentId: "owner", stepClosed: () => false,
  });
  expect(slot).toBeDefined();
  expect(noteHostManagedStep({ agentId: "other", turnId: "turn", stepId: "step" })).toBe(false);
  expect(isHostManagedRootActive(root)).toBe(false);
  expect(noteHostManagedStep({ agentId: "owner", turnId: "turn", stepId: "step" })).toBe(true);
  expect(isHostManagedRootActive(root)).toBe(true);
  slot?.[Symbol.dispose]();
  expect(isHostManagedRootActive(root)).toBe(false);
});
