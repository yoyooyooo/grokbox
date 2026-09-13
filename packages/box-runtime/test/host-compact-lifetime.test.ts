import { describe, expect, test } from "bun:test";
import { bindHostCompactHook, requestHostCompact, resetHostCompactSlotForTests, stateSystemCompactHookOptions } from "../src/internal/host/compact.ts";

const tuple = { agentId: "lifetime-agent", turnId: "lifetime-turn", stepId: "lifetime-step", bindingId: "binding", selectionRevision: "selection" };
const original = [{ role: "system", content: "system" }, { role: "user", content: "old facts" }];
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Tests the actual delegate's late mutation boundary, not merely the absence of resume.
for (const stop of ["socket", "dispose", "host-abort", "deadline"] as const) {
  test(`HostCompact ${stop} before root acceptance forbids late root and state writes`, async () => {
    resetHostCompactSlotForTests();
    const started = deferred();
    const held = deferred();
    let state = structuredClone(original);
    const counts = { archive: 0, clear: 0, append: 0 };
    const signal = { aborted: false };
    let stopped = false;
    let now = 10;
    const stateHandler: { backgroundSummarizationPromiseInfo: unknown; lastStepInvocationId: string } = {
      backgroundSummarizationPromiseInfo: null, lastStepInvocationId: tuple.stepId,
    };
    const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
      orchestrator: {
        async handleSummarization(_ctx: unknown, guardedState: typeof stateHandler, root: {
          clearMessages(): void; appendMessages(messages: typeof original): void;
        }) {
          started.release();
          await held.promise;
          // An external/archive effect may already have happened. It is not a root commit.
          counts.archive++;
          root.clearMessages();
          root.appendMessages([{ role: "system", content: "system" }, { role: "user", content: "summary" }]);
          guardedState.backgroundSummarizationPromiseInfo = { accepted: true };
          return "summary";
        },
      },
      ctx: { get: () => tuple.turnId, signal }, stateHandler,
      rootPromptExecutor: {
        getState: () => structuredClone(state), getMessages: () => structuredClone(state),
        clearMessages() { counts.clear++; state = []; },
        appendMessages(messages: typeof original) { counts.append++; state.push(...messages); },
      },
      invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
      config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
    });
    const running = requestHostCompact({ tuple, recoveryNonce: "nonce" }, {
      stopped: () => stopped, deadlineMs: 100, now: () => now,
    });
    await started.promise;
    if (stop === "socket") stopped = true;
    if (stop === "dispose") slot?.[Symbol.dispose]();
    if (stop === "host-abort") signal.aborted = true;
    if (stop === "deadline") now = 111;
    held.release();
    const result = await running;
    expect(result.kind).toBe("unavailable");
    expect(counts).toEqual({ archive: 1, clear: 0, append: 0 });
    expect(state).toEqual(original);
    expect(stateHandler.backgroundSummarizationPromiseInfo).toBeNull();
    slot?.[Symbol.dispose]();
  });
}

describe("HostCompact lifetime admission", () => {
  test("a stale STEP is refused before calling the summary provider", async () => {
    resetHostCompactSlotForTests();
    let calls = 0;
    const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
      orchestrator: { async handleSummarization() { calls++; return "summary"; } },
      ctx: { signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null, lastStepInvocationId: "newer-step" },
      rootPromptExecutor: { getState: () => structuredClone(original) },
      invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
      config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
    });
    try {
      expect((await requestHostCompact({ tuple, recoveryNonce: "nonce" })).kind).toBe("unavailable");
      expect(calls).toBe(0);
    } finally {
      slot?.[Symbol.dispose]();
    }
  });

  for (const outcome of ["snapshot", "no-improvement", "error"] as const) {
    test(`a ${outcome} compact outcome revokes retained delegates before the STEP ends`, async () => {
      resetHostCompactSlotForTests();
      let state = structuredClone(original);
      const owner = { backgroundSummarizationPromiseInfo: null as unknown };
      let savedRoot: { clearMessages(): void } | undefined;
      let savedState: typeof owner | undefined;
      let savedClear: (() => void) | undefined;
      const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
        orchestrator: {
          async handleSummarization(_ctx: unknown, guardedState: typeof owner, guardedRoot: { clearMessages(): void }) {
            savedRoot = guardedRoot;
            savedClear = guardedRoot.clearMessages;
            savedState = guardedState;
            if (outcome === "error") throw new Error("owned-summary-failure");
            return outcome === "snapshot" ? "summary" : undefined;
          },
        },
        ctx: {}, stateHandler: owner,
        rootPromptExecutor: {
          getState: () => structuredClone(state),
          clearMessages() { state = []; },
        },
        invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
        config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
      });
      try {
        const result = await requestHostCompact({ tuple, recoveryNonce: "nonce" });
        expect(result.kind).toBe(outcome === "snapshot" ? "snapshot" : outcome === "error" ? "unavailable" : "no_improvement");
        expect(savedRoot).toBeDefined();
        expect(savedClear).toBeDefined();
        expect(savedState).toBeDefined();
        expect(() => savedRoot!.clearMessages()).toThrow("host_compact_lease_expired");
        expect(() => savedClear!()).toThrow("host_compact_lease_expired");
        expect(() => { savedState!.backgroundSummarizationPromiseInfo = { late: true }; }).toThrow("host_compact_lease_expired");
        expect(state).toEqual(original);
        expect(owner.backgroundSummarizationPromiseInfo).toBeNull();
      } finally {
        slot?.[Symbol.dispose]();
      }
    });
  }

  test("a newer STEP owning the same root revokes the pending old delegate", async () => {
    resetHostCompactSlotForTests();
    const started = deferred();
    const held = deferred();
    let state = structuredClone(original);
    let clearCount = 0;
    const root = {
      getState: () => structuredClone(state),
      clearMessages() { clearCount++; state = []; },
    };
    const hook = bindHostCompactHook(stateSystemCompactHookOptions());
    const common = {
      ctx: {}, rootPromptExecutor: root,
      config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
    };
    const a = hook({
      ...common,
      stateHandler: { backgroundSummarizationPromiseInfo: null, lastStepInvocationId: tuple.stepId },
      orchestrator: { async handleSummarization(_ctx: unknown, _state: unknown, guarded: typeof root) {
        started.release(); await held.promise; guarded.clearMessages(); return "summary";
      } },
      invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
    });
    const pending = requestHostCompact({ tuple, recoveryNonce: "nonce-a" });
    await started.promise;
    const next = { ...tuple, stepId: "new-root-owner" };
    const b = hook({
      ...common,
      stateHandler: { backgroundSummarizationPromiseInfo: null, lastStepInvocationId: next.stepId },
      orchestrator: { async handleSummarization() { return "summary"; } },
      invocationId: next.stepId, turnId: next.turnId, agentId: next.agentId,
    });
    try {
      expect(b).toBeDefined();
      held.release();
      expect((await pending).kind).toBe("unavailable");
      expect(clearCount).toBe(0);
      expect(state).toEqual(original);
      // Disposing an older generation must not remove the new owner's slot.
      a?.[Symbol.dispose]();
      expect((await requestHostCompact({ tuple: next, recoveryNonce: "nonce-b" })).kind).toBe("snapshot");
    } finally {
      held.release();
      await pending;
      a?.[Symbol.dispose]();
      b?.[Symbol.dispose]();
    }
  });
  test("already stopped or exhausted budget performs zero summary invocation", async () => {
    for (const lifetime of [{ stopped: () => true }, { deadlineMs: 0 }, { deadlineMs: -1 }]) {
      resetHostCompactSlotForTests();
      let calls = 0;
      const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
        orchestrator: { async handleSummarization() { calls++; return "summary"; } },
        ctx: { signal: { aborted: false } },
        stateHandler: { backgroundSummarizationPromiseInfo: null },
        rootPromptExecutor: { getState: () => original },
        invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
        config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
      });
      expect((await requestHostCompact({ tuple, recoveryNonce: "nonce" }, lifetime)).kind).toBe("unavailable");
      expect(calls).toBe(0);
      slot?.[Symbol.dispose]();
    }
  });

  test("active delegated writes preserve method receiver, chaining and Host ownership", async () => {
    resetHostCompactSlotForTests();
    const root = {
      state: structuredClone(original),
      getState() { return structuredClone(this.state); },
      clearMessages() { this.state = []; return this; },
      appendMessages(messages: typeof original) { this.state.push(...messages); return this; },
    };
    const slot = bindHostCompactHook(stateSystemCompactHookOptions())({
      orchestrator: {
        async handleSummarization(_ctx: unknown, _state: unknown, guarded: typeof root) {
          expect(guarded).not.toBe(root);
          guarded.clearMessages().appendMessages([{ role: "system", content: "system" }, { role: "user", content: "new summary" }]);
          return "summary";
        },
      },
      ctx: { signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null }, rootPromptExecutor: root,
      invocationId: tuple.stepId, turnId: tuple.turnId, agentId: tuple.agentId,
      config: {}, requestContext: {}, resourceAccessor: {}, interactionListener: {}, stepClosed: () => false,
    });
    const result = await requestHostCompact({ tuple, recoveryNonce: "nonce" }, { deadlineMs: 100 });
    expect(result.kind).toBe("snapshot");
    expect(root.state[1]?.content).toBe("new summary");
    slot?.[Symbol.dispose]();
  });
});
