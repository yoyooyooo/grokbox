import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import { BackendFailure, contextSnapshotBody, isConfirmedOverflow, WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import type { AuthLease, PreparedCall } from "@grokbox/runtime-kernel/ports";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import {
  canaryOverflowFailure,
  estimateCanaryTokens,
  parseOverflowCanary,
  shouldInterceptOverflowCanary,
  withOverflowCanary,
} from "../src/internal/backends/overflow-canary.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { makeAuthLease, makePreparedCall } from "../src/internal/backends/prepared.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";

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

  test("serveModeld canary replaces backend: matching agent skips fetch", async () => {
    const agentId = AGENT;
    const openai = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
      endpoint: "https://ccs.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
      contextWindowTokens: 200000,
    };
    const models = parseModelsFile({
      version: 1,
      models: { [openai.id]: openai },
      assignments: { main: null, agents: { [agentId]: openai.id } },
    });
    const body = contextSnapshotBody({
      version: 1,
      profileId: "p",
      abiIdentity: "abi",
      systemMessages: [{ role: "system", content: "root" }],
      messages: [{ role: "user", content: "x".repeat(40) }],
      tools: [],
      options: {},
    });
    const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
    let http = 0;
    const fetchImpl = Object.assign(async () => {
      http += 1;
      return new Response("nope", { status: 500 });
    }, { preconnect: async () => undefined }) as typeof fetch;
    const env = {
      OPENAI_API_KEY: "sk-test",
      GROKBOX_MODELD_OVERFLOW_CANARY_AGENT: agentId,
      GROKBOX_MODELD_OVERFLOW_CANARY_WINDOW_TOKENS: "2",
    };
    const auth = createLiveBackendAuth(env);
    const generation = randomUUID();
    const layer = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } }).pipe(
      Layer.merge(admitAllAuthorityLayer()),
      Layer.merge(auth.layer),
      Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const dir = await mkdtemp(join(tmpdir(), "grokbox-overflow-canary-"));
    const path = join(dir, "modeld.sock");
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({ path, generation, env }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(layer),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const frames = await requestModeld(dir, {
        version: WIRE_VERSION,
        method: "run-step",
        hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v4" },
        serviceEpoch: { incarnationId: generation },
        agentId,
        turnId: "t-canary",
        stepId: "s-canary",
        selection: { agentId, modelId: openai.id, selectionRevision: computeSelectionRevision({ agentId, model: openai }) },
        snapshot,
      }, 8_000);
      expect(http).toBe(0);
      const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string; code?: string };
      expect(terminal?.outcome).toBe("error");
      expect(terminal?.code).toBe("overflow_candidate");
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    }
  }, 15_000);
});
