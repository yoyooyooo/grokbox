import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { emptyRecoveryLedger } from "@grokbox/runtime-kernel/contract";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { admitOverflowRecovery } from "@grokbox/runtime-kernel/inference";
import {
  bindHostCompactHook,
  HOST_COMPACT_SYMBOL,
  requestHostCompact,
  resetHostCompactSlotForTests,
  stateSystemCompactHookOptions,
} from "../src/internal/host/compact.ts";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, HOST_COMPACT_SYMBOL as PROFILE_COMPACT_SYMBOL, profileFromSource, transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const LIVE_SHA = "2ede71e2db066b32dfe75b5073c0cac8052faf76d23ed34b8fea4567ea0e9baa";
const TUPLE = {
  agentId: "agent-a",
  turnId: "turn-1",
  stepId: "step-1",
  bindingId: "bind-1",
  selectionRevision: "rev-a",
};

const COMPACT_HOST = `"use strict";
var requestIdKey = "requestId";
var __addDisposableResource23 = function(env, value) {
  if (value != null) env.stack.push({ value: value, dispose: value[Symbol.dispose] });
  return value;
};
var __disposeResources23 = function(env) {
  while (env.stack.length) {
    var r = env.stack.pop();
    if (r && r.dispose) r.dispose.call(r.value);
  }
};
function Handler() {}
Handler.prototype.runStep = async function(parentCtx, wait) {
  const env_2 = { stack: [], error: void 0, hasError: false };
  try {
    const ctx = parentCtx;
    const invocationId = this.invocationId;
    const stateHandler = this.stateHandler;
    const rootPromptExecutor = this.rootPromptExecutor;
    const requestContext = {};
    let stepClosed = false;
      let response;
      let extendedUsage;
      let usage;
      let finalInvocationId;
      try {
        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([
          wait(),
          Promise.resolve(),
          Promise.resolve(),
          Promise.resolve()
        ]);
      } catch (error41) {
        stepClosed = true;
        throw error41;
      } finally {
        stepClosed = true;
      }
    return { response: response };
  } catch (e_2) {
    env_2.error = e_2;
    env_2.hasError = true;
  } finally {
    __disposeResources23(env_2);
  }
};
module.exports = { Handler };
`;

function evidence() {
  return {
    providerCode: "context_length_exceeded" as const,
    httpStatus: 400,
    releasedText: 0,
    releasedReasoning: 0,
    releasedTools: 0,
  };
}

function rootState(text = "compacted") {
  return [
    { role: "system", content: "root-from-state" },
    { role: "user", content: text },
  ];
}

describe("D2 Host compact registration", () => {
  test("LIVE_SLICE_PATCHES apply the compact-register slice on the live-shaped fixture", () => {
    expect(PROFILE_COMPACT_SYMBOL).toBe(HOST_COMPACT_SYMBOL);
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "compact-shaped");
    const applied = applyPatchProfile(LIVE_SHAPED_HOST, profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(HOST_COMPACT_SYMBOL);
    expect(applied.source).toContain("__addDisposableResource23(env_2, __grokbox_compact_slot, false)");
    expect(applied.source.includes("handleSummarization")).toBe(false);
    expect(applied.source.includes("queued summarizeAction")).toBe(false);
  });

  test("absent compact hook leaves the wait path inert", async () => {
    resetHostCompactSlotForTests();
    const applied = transformUnchecked(COMPACT_HOST, LIVE_SLICE_PATCHES.filter((slice) => slice.id === "compact-register"));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const module = { exports: {} as { Handler: new () => {
      invocationId: string;
      orchestrator: { handleSummarization: () => Promise<string> };
      config: { conversationGroupId: string };
      resourceAccessor: object;
      interactionListener: object;
      stateHandler: { backgroundSummarizationPromiseInfo: null };
      rootPromptExecutor: { getState: () => unknown };
      runStep: (ctx: object, wait: () => Promise<unknown>) => Promise<unknown>;
    } } };
    const sandbox = createContext({ module, exports: module.exports, Symbol, globalThis });
    runInContext(applied.source, sandbox);
    const counts = { compact: 0 };
    const handler = new module.exports.Handler();
    handler.invocationId = TUPLE.stepId;
    handler.orchestrator = { handleSummarization: async () => { counts.compact += 1; return "summary"; } };
    handler.config = { conversationGroupId: TUPLE.agentId };
    handler.resourceAccessor = {};
    handler.interactionListener = {};
    handler.stateHandler = { backgroundSummarizationPromiseInfo: null };
    handler.rootPromptExecutor = { getState: () => rootState() };
    await handler.runStep({ get: () => TUPLE.turnId, signal: { aborted: false } }, async () => "ok");
    expect(counts.compact).toBe(0);
    expect((await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) })).kind).toBe("unavailable");
  });

  test("register before wait, dispose on runStep finally, and one-shot identity", async () => {
    resetHostCompactSlotForTests();
    const applied = transformUnchecked(COMPACT_HOST, LIVE_SLICE_PATCHES.filter((slice) => slice.id === "compact-register"));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const module = { exports: {} as { Handler: new () => {
      invocationId: string;
      orchestrator: { handleSummarization: ( ...args: unknown[]) => Promise<unknown> };
      config: { conversationGroupId: string };
      resourceAccessor: object;
      interactionListener: object;
      stateHandler: { backgroundSummarizationPromiseInfo: null };
      rootPromptExecutor: { getState: () => unknown };
      runStep: (ctx: object, wait: () => Promise<unknown>) => Promise<unknown>;
    } } };
    const sandbox = createContext({ module, exports: module.exports, Symbol, globalThis });
    const hook = bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    sandbox.globalThis[Symbol.for(HOST_COMPACT_SYMBOL)] = hook;
    runInContext(applied.source, sandbox);
    const seen: unknown[] = [];
    let release!: (value: unknown) => void;
    const held = new Promise((resolve) => { release = resolve; });
    const handler = new module.exports.Handler();
    handler.invocationId = TUPLE.stepId;
    handler.orchestrator = {
      handleSummarization: async (...args) => {
        seen.push(args[6]);
        return "summary";
      },
    };
    handler.config = { conversationGroupId: TUPLE.agentId };
    handler.resourceAccessor = {};
    handler.interactionListener = {};
    handler.stateHandler = { backgroundSummarizationPromiseInfo: null };
    handler.rootPromptExecutor = { getState: () => rootState() };
    const running = handler.runStep({ get: () => TUPLE.turnId, signal: { aborted: false } }, () => held);
    const first = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(first.kind).toBe("snapshot");
    if (first.kind === "snapshot") {
      expect(first.snapshot.messages).toEqual([{ role: "user", content: "compacted" }]);
    }
    expect(seen).toEqual([{
      backgroundSummarizationMode: "WaitForCompletion",
      forceExternalModel: true,
      triggerReason: "input_token_limit_error",
      currentInvocationId: TUPLE.stepId,
      resourceAccessor: handler.resourceAccessor,
    }]);
    const duplicate = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(duplicate).toEqual({ kind: "unavailable", reason: "blocked" });
    const mismatched = await requestHostCompact({
      tuple: { ...TUPLE, stepId: "other" },
      recoveryNonce: "n".repeat(32),
    });
    expect(mismatched).toEqual({ kind: "unavailable", reason: "capability_not_ready" });
    expect(seen).toHaveLength(1);
    release("ok");
    await running;
    const afterDispose = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(afterDispose).toEqual({ kind: "unavailable", reason: "capability_not_ready" });
  });

  test("pending summary and unconfirmed overflow never invoke Host compact", async () => {
    resetHostCompactSlotForTests();
    const hook = bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    const counts = { compact: 0 };
    const slot = hook({
      orchestrator: { handleSummarization: async () => { counts.compact += 1; return "summary"; } },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: { pending: true } },
      rootPromptExecutor: { getState: () => rootState() },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    expect(slot).toBeDefined();
    expect(await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) })).toEqual({
      kind: "unavailable", reason: "blocked",
    });
    expect(counts.compact).toBe(0);
    expect(admitOverflowRecovery({
      ledger: emptyRecoveryLedger(TUPLE, "n".repeat(32)),
      evidence: { providerCode: "context_length_exceeded", releasedText: 0, releasedReasoning: 0, releasedTools: 0 },
      identity: TUPLE,
      recoveryNonce: "n".repeat(32),
    })).toBe("unconfirmed");
    slot?.[Symbol.dispose]();
  });

  test("concurrent requests share one Host compact invocation", async () => {
    resetHostCompactSlotForTests();
    const hook = bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    let resume!: (value: unknown) => void;
    const held = new Promise((resolve) => { resume = resolve; });
    const counts = { compact: 0 };
    hook({
      orchestrator: {
        handleSummarization: async () => {
          counts.compact += 1;
          return held;
        },
      },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => rootState() },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    const first = requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    const second = requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(counts.compact).toBe(1);
    resume("summary");
    const [a, b] = await Promise.all([first, second]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["snapshot", "unavailable"]);
    expect(counts.compact).toBe(1);
  });

  test("late core completion after dispose, close, or abort is not resume success", async () => {
    for (const mode of ["dispose", "close", "abort"] as const) {
      resetHostCompactSlotForTests();
      const hook = bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
      let resume!: (value: unknown) => void;
      const held = new Promise((resolve) => { resume = resolve; });
      const counts = { compact: 0 };
      const closed = { value: false };
      const signal = { aborted: false };
      const slot = hook({
        orchestrator: {
          handleSummarization: async () => {
            counts.compact += 1;
            return held;
          },
        },
        ctx: { get: () => TUPLE.turnId, signal },
        stateHandler: { backgroundSummarizationPromiseInfo: null, lastStepInvocationId: TUPLE.stepId },
        rootPromptExecutor: { getState: () => rootState() },
        interactionListener: {},
        config: {},
        requestContext: {},
        invocationId: TUPLE.stepId,
        turnId: TUPLE.turnId,
        agentId: TUPLE.agentId,
        resourceAccessor: {},
        stepClosed: () => closed.value,
      });
      const pending = requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(counts.compact).toBe(1);
      if (mode === "dispose") slot?.[Symbol.dispose]();
      if (mode === "close") closed.value = true;
      if (mode === "abort") signal.aborted = true;
      resume("summary");
      const result = await pending;
      expect(result.kind).toBe("unavailable");
      expect(result).toEqual({
        kind: "unavailable",
        reason: mode === "abort" ? "cancelled" : "unknown",
      });
      const replay = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
      expect(replay.kind).toBe("unavailable");
      expect(counts.compact).toBe(1);
    }
  });

  test("state-system hook options qualify a D2 slot; omitted options stay fail-closed", async () => {
    expect(stateSystemCompactHookOptions()).toEqual({
      profileId: "t21-state-root",
      abiIdentity: "host-abi-v1",
    });
    const preload = await readFile(new URL("../src/preload.ts", import.meta.url), "utf8");
    expect(preload).toContain("bindHostCompactHook(stateSystemCompactHookOptions())");
    expect(preload).not.toContain("bindHostCompactHook();");
    resetHostCompactSlotForTests();
    const counts = { compact: 0 };
    bindHostCompactHook(stateSystemCompactHookOptions())({
      orchestrator: { handleSummarization: async () => { counts.compact += 1; return "summary"; } },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => rootState() },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    const qualified = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(qualified.kind).toBe("snapshot");
    expect(counts.compact).toBe(1);
  });

  test("missing or unsupported snapshot qualification never invokes the core", async () => {
    resetHostCompactSlotForTests();
    for (const options of [
      undefined,
      { profileId: "not-a-profile", abiIdentity: "host-abi-v1" },
      { profileId: "t21-independent-root", abiIdentity: "host-abi-v1" },
    ]) {
      const counts = { compact: 0 };
      bindHostCompactHook(options)({
        orchestrator: { handleSummarization: async () => { counts.compact += 1; return "summary"; } },
        ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
        stateHandler: { backgroundSummarizationPromiseInfo: null },
        rootPromptExecutor: { getState: () => rootState() },
        interactionListener: {},
        config: {},
        requestContext: {},
        invocationId: TUPLE.stepId,
        turnId: TUPLE.turnId,
        agentId: TUPLE.agentId,
        resourceAccessor: {},
        stepClosed: () => false,
      });
      expect(await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) })).toEqual({
        kind: "unavailable", reason: "capability_not_ready",
      });
      expect(counts.compact).toBe(0);
      resetHostCompactSlotForTests();
    }
  });

  test("unqualified hook or named-document callback never invokes the core", async () => {
    resetHostCompactSlotForTests();
    const cases = [
      { config: { enableExecuteHookExec: true }, requestContext: { hooksConfig: { configuredSteps: ["preCompact"] } } },
      { config: { getNamedAgentSelfDocument: async () => "doc" }, requestContext: {} },
    ];
    for (const extra of cases) {
      const counts = { compact: 0 };
      bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" })({
        orchestrator: { handleSummarization: async () => { counts.compact += 1; return "summary"; } },
        ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
        stateHandler: { backgroundSummarizationPromiseInfo: null },
        rootPromptExecutor: { getState: () => rootState() },
        interactionListener: {},
        ...extra,
        invocationId: TUPLE.stepId,
        turnId: TUPLE.turnId,
        agentId: TUPLE.agentId,
        resourceAccessor: {},
        stepClosed: () => false,
      });
      expect(await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) })).toEqual({
        kind: "unavailable", reason: "blocked",
      });
      expect(counts.compact).toBe(0);
      resetHostCompactSlotForTests();
    }
  });

  test("a later STEP registration does not overwrite a live earlier owner", async () => {
    resetHostCompactSlotForTests();
    const hook = bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" });
    const counts = { a: 0, b: 0 };
    const other = { ...TUPLE, agentId: "agent-b", turnId: "turn-2", stepId: "step-2" };
    const a = hook({
      orchestrator: { handleSummarization: async () => { counts.a += 1; return "summary"; } },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => rootState("a") },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    const b = hook({
      orchestrator: { handleSummarization: async () => { counts.b += 1; return "summary"; } },
      ctx: { get: () => other.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => rootState("b") },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: other.stepId,
      turnId: other.turnId,
      agentId: other.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    b?.[Symbol.dispose]();
    const kept = await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) });
    expect(kept.kind).toBe("snapshot");
    if (kept.kind === "snapshot") {
      expect(kept.snapshot.messages).toEqual([{ role: "user", content: "a" }]);
    }
    expect(counts).toEqual({ a: 1, b: 0 });
    expect(await requestHostCompact({ tuple: other, recoveryNonce: "n".repeat(32) })).toEqual({
      kind: "unavailable", reason: "capability_not_ready",
    });
    expect(await requestHostCompact({ tuple: TUPLE, recoveryNonce: "n".repeat(32) })).toEqual({
      kind: "unavailable", reason: "blocked",
    });
    a?.[Symbol.dispose]();
  });
});

const describeLive = existsSync(LIVE_HOST_BUNDLE) ? describe : describe.skip;

describeLive("D2 live Host compact anchors", () => {
  test("SHA-matched Host accepts unique compact-register without writing the live file", async () => {
    const bytes = await readFile(LIVE_HOST_BUNDLE);
    expect(sha256Bytes(bytes)).toBe(LIVE_SHA);
    const source = bytes.toString("utf8");
    const before = source;
    const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "d2-live");
    const applied = applyPatchProfile(source, profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(HOST_COMPACT_SYMBOL);
    expect(applied.source).toContain("__addDisposableResource23(env_2, __grokbox_compact_slot, false)");
    const streamAt = source.indexOf("result = rootPromptExecutor.executeToolStream(");
    const closedAt = source.indexOf("let stepClosed = false;");
    expect(streamAt).toBeGreaterThan(-1);
    expect(closedAt).toBeGreaterThan(streamAt);
    expect(applied.source.indexOf("__grokbox_compact_slot")).toBeGreaterThan(applied.source.indexOf("let stepClosed = false;"));
    expect(await readFile(LIVE_HOST_BUNDLE, "utf8")).toBe(before);
  });
});
