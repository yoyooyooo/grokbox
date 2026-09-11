import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { BackendFailure, isConfirmedOverflow } from "@grokbox/runtime-kernel/contract";
import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import {
  canaryOverflowFailure,
  estimateCanaryTokens,
  parseOverflowCanary,
  shouldInterceptOverflowCanary,
  withOverflowCanary,
} from "../src/internal/backends/overflow-canary.ts";
import { makeAuthLease, makePreparedCall } from "../src/internal/backends/prepared.ts";

delete process.env.GROKBOX_MODELD_HOST_COMPACT;
delete process.env.GROKBOX_MODELD_OVERFLOW_CANARY_AGENT;
delete process.env.GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS;
delete process.env.GROKBOX_CONTEXT_CAP;
delete process.env.GROKBOX_ALLOW_LIVE_HOST;

const AGENT = "00000000-0000-4000-8000-000000000115";

function prepared(text: string): PreparedCall {
  return makePreparedCall({
    kind: "openai-responses",
    prompt: { system: "sys", messages: [{ role: "user", content: text }] },
    model: "gpt",
    endpoint: "https://ccs.test/v1",
    api: "responses",
    tools: [],
    options: {},
    settings: {},
  });
}

function fakeInner(calls: { infer: number }) {
  return {
    prepare: (_selection: unknown, _snapshot: unknown) => Effect.succeed(prepared("hi")),
    infer: (_admitted: unknown, _prepared: PreparedCall, _lease: AuthLease) => {
      calls.infer += 1;
      return Stream.make({ type: "text_delta" as const, text: "ok" });
    },
  };
}

describe("modeld overflow canary (default-off CCS intercept)", () => {
  test("unset / partial / malformed env stay off", () => {
    expect(parseOverflowCanary()).toBeUndefined();
    expect(parseOverflowCanary({})).toBeUndefined();
    expect(parseOverflowCanary({ GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT })).toBeUndefined();
    expect(parseOverflowCanary({ GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "128" })).toBeUndefined();
    expect(parseOverflowCanary({
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "true",
    })).toBeUndefined();
    expect(parseOverflowCanary({
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "0",
    })).toBeUndefined();
    expect(parseOverflowCanary({
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "1.5",
    })).toBeUndefined();
    expect(parseOverflowCanary({
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: "",
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "128",
    })).toBeUndefined();
  });

  test("both keys exact-positive attach canary", () => {
    expect(parseOverflowCanary({
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "128",
    })).toEqual({ agentId: AGENT, windowTokens: 128 });
  });

  test("estimator is ceil(chars/4), not a guessed catalog W", () => {
    expect(estimateCanaryTokens({ system: "abcd", messages: [] })).toBe(1);
    expect(estimateCanaryTokens({ system: "a", messages: [{ role: "user", content: "bcd" }] })).toBe(1);
    expect(estimateCanaryTokens({
      system: "sys",
      messages: [{ role: "user", content: "x".repeat(9) }],
    })).toBe(3);
  });

  test("intercept only when agent matches and estimate exceeds window", () => {
    const env = {
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "2",
    };
    const over = prepared("x".repeat(20));
    const under = prepared("hi");
    expect(shouldInterceptOverflowCanary({ env, agentId: AGENT, prepared: over })).toBe(true);
    expect(shouldInterceptOverflowCanary({ env, agentId: AGENT, prepared: under })).toBe(false);
    expect(shouldInterceptOverflowCanary({ env, agentId: "other-agent", prepared: over })).toBe(false);
    expect(shouldInterceptOverflowCanary({ env: {}, agentId: AGENT, prepared: over })).toBe(false);
  });

  test("canary failure uses allowlisted context_length_exceeded / 400", () => {
    const failure = canaryOverflowFailure();
    expect(failure.code).toBe("overflow_candidate");
    expect(failure.overflowEvidence).toEqual({ providerCode: "context_length_exceeded", httpStatus: 400 });
    expect(isConfirmedOverflow(failure.overflowEvidence ?? {})).toBe(true);
  });

  test("wrapper fails before inner infer on hit; otherwise passes through", async () => {
    const env = {
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: AGENT,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "2",
    };
    const hitCalls = { infer: 0 };
    const hit = withOverflowCanary(fakeInner(hitCalls), AGENT, env);
    const hitError = await Effect.runPromise(Effect.result(Stream.runCollect(hit.infer({}, prepared("x".repeat(20)), makeAuthLease()))));
    expect(hitCalls.infer).toBe(0);
    expect(hitError._tag).toBe("Failure");
    if (hitError._tag === "Failure") {
      expect(hitError.failure).toBeInstanceOf(BackendFailure);
      expect((hitError.failure as BackendFailure).overflowEvidence?.providerCode).toBe("context_length_exceeded");
    }

    const missCalls = { infer: 0 };
    const miss = withOverflowCanary(fakeInner(missCalls), "other-agent", env);
    const missEvents = await Effect.runPromise(Stream.runCollect(miss.infer({}, prepared("x".repeat(20)), makeAuthLease())));
    expect(missCalls.infer).toBe(1);
    expect([...missEvents]).toEqual([{ type: "text_delta", text: "ok" }]);

    const offCalls = { infer: 0 };
    const offInner = fakeInner(offCalls);
    const off = withOverflowCanary(offInner, AGENT, {});
    await Effect.runPromise(Stream.runCollect(off.infer({}, prepared("x".repeat(20)), makeAuthLease())));
    expect(offCalls.infer).toBe(1);
    expect(off).toBe(offInner);
  });
});
