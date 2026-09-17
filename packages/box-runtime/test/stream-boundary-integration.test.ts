import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer } from "effect";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeBackendAuthLayer, fakeConfigurationReadLayer, unsealFakeAuth } from "@grokbox/runtime-kernel/testing";
import { aiSdkModelBackendLayer } from "../src/internal/backends/ai-sdk.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import type { ModeldStepOutcome } from "../src/internal/modeld/step-outcome.ts";
import { createModeldProduce } from "../src/internal/host/modeld-produce.node.ts";
import { asHostPromptSession, createStreamingPromptSession, type SessionTerminal, type StreamPart } from "../src/internal/host/session.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

const model = { id: "openai/owned", provider: "openai-chat", model: "owned", endpoint: "https://offline.invalid/v1",
  apiKeyRef: "env:OWNED", capabilities: { tools: true }, contextWindowTokens: 200_000 };
const tools = [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const tool = (name: string) => chunk({ tool_calls: [{ index: 0, id: "owned-call", type: "function", function: { name, arguments: "" } }] });
const arg = (arguments_: string) => chunk({ tool_calls: [{ index: 0, function: { arguments: arguments_ } }] });
const stop = (reason = "stop") => ({ ...chunk({}, reason), usage: { prompt_tokens: 3, completion_tokens: 1 } });

async function scenario(kind: "undeclared" | "open-tool" | "missing-finish" | "valid" | "minimax-valid" | "minimax-unknown-second" | "minimax-open-think") {
  const selected = { ...model, ...(kind.startsWith("minimax-") ? { chatDialect: "minimax-inline-v1" } : {}) };
  const config = parseModelsFile({ version: 1, models: { [model.id]: selected }, assignments: { agents: { "owned-agent": model.id }, main: null } });
  const root = await mkdtemp(join(tmpdir(), "grokbox-stream-boundary-"));
  const generation = randomUUID();
  let http = 0, firstChunk = 0;
  let terminal: SessionTerminal | undefined;
  const observed: ModeldStepOutcome[] = [];
  const minimaxPrefix = [chunk({ content: "<think>synthetic reasoning</think>progress" }, ""), tool("lookup"),
    chunk({ tool_calls: [{ index: 0, type: "", id: "", function: { name: "", arguments: '{"q":"ok"}' } }] }, "")];
  const frames = kind === "undeclared" ? [tool("unknown_tool"), arg('{"q":"x"}'), stop("tool_calls")]
    : kind === "open-tool" ? [tool("lookup"), arg('{"q":"'), stop("tool_calls")]
    : kind === "missing-finish" ? [chunk({ content: "partial" })]
    : kind === "minimax-valid" ? [...minimaxPrefix, stop("tool_calls"), chunk({}, "")]
    : kind === "minimax-unknown-second" ? [...minimaxPrefix,
      chunk({ tool_calls: [{ index: 1, type: "function", id: "second", function: { name: "unknown_tool", arguments: "{}" } }] }), stop("tool_calls")]
    : kind === "minimax-open-think" ? [chunk({ content: "<think>unfinished reasoning" }), tool("lookup"), arg("{}"), stop("tool_calls")]
    : [tool("lookup"), arg('{"q":"ok"}'), stop("tool_calls")];
  const fetch = Object.assign(async () => {
    http++;
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (index < frames.length) controller.enqueue(encode(frames[index++]));
      else if (index++ === frames.length) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      else controller.close();
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const graph = Layer.mergeAll(fakeConfigurationReadLayer({ models: () => config, desired: { version: 1, mode: "route" } }),
    fakeBackendAuthLayer("synthetic-only"), aiSdkModelBackendLayer(fetch, unsealFakeAuth),
    admitAllAuthorityLayer(), inferenceMemoryLayer({ serviceEpoch: generation }));
  const fiber = Effect.runFork(Effect.scoped(serveModeld({ path: join(root, "modeld.sock"), generation, env: {},
    observeStep: (_request, outcome) => Effect.sync(() => { observed.push(outcome); }),
  }).pipe(Effect.andThen(Effect.never), Effect.provide(graph))));
  try {
    for (let i = 0; i < 100; i++) {
      if (await probeModeldHealth(root, 100)) break;
      if (i === 99) throw new Error("owned listener did not start");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const runtime = createModeldProduce({ runRoot: root, agentId: "owned-agent", modelId: model.id,
      selectionRevision: computeSelectionRevision({ agentId: "owned-agent", model: config.models[model.id]! }),
      turnId: "owned-turn", bridgeDigest: "d".repeat(64), profileId: "t21-state-root", abiIdentity: "host-abi-v1",
      binding: { generationId: "a".repeat(64), activationId: "owned", pid: 1, start: 1, sourceSha: "b".repeat(64), identitySha: "c".repeat(64) },
      onFirstChunk: () => { firstChunk++; },
    });
    const session = asHostPromptSession(createStreamingPromptSession({ modelId: model.id, vision: false, parallel: "fail-closed",
      produce: runtime.produce, onTerminal: value => { terminal = value; },
    }), model.id, undefined, { requireStepId: true, contextWindowTokens: 200_000 });
    const handle = session.getExecutor([{ role: "system", content: "owned root" }, { role: "user", content: "owned" }]).stream({}, "owned-step", tools);
    let error: unknown;
    const parts: StreamPart[] = [];
    try { for await (const part of handle.fullStream) parts.push(part); } catch (e) { error = e; }
    try { await handle.response; } catch (e) { error = e; }
    for (let i = 0; observed.length === 0 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5));
    return { error, http, firstChunk, terminal, outcome: observed[0], parts };
  } finally { await Effect.runPromise(Fiber.interrupt(fiber)); await rm(root, { recursive: true, force: true }); }
}

describe("real SDK -> modeld -> Unix -> Host failure cause", () => {
  for (const [kind, cause] of [["undeclared", "undeclared_tool"], ["open-tool", "tool_arguments_invalid"], ["missing-finish", "missing_finish"]] as const) {
    test(`${kind} keeps its precise backend cause even when Host closes the connection`, async () => {
      const result = await scenario(kind);
      expect(result.http).toBe(1);
      expect(result.error).toMatchObject({ code: "invalid_stream", stage: "normalize" });
      expect(result.terminal).toMatchObject({ terminalClass: "error", toolCallCount: 0 });
      expect(result.outcome).toMatchObject({ outcome: "error", phase: "normalize", failureCode: "stream_invalid",
        diagnostic: { normalizeCause: cause }, attempts: [{ index: 0, failureCode: "stream_invalid" }] });
      expect(result.outcome?.stream?.counts.providerFetchCalls).toBe(1);
      expect(result.parts.some(part => part.type === "tool-call")).toBe(false);
      if (kind === "undeclared") expect(result.firstChunk).toBe(0);
    });
  }
  test("MiniMax dialect and identity witnesses survive the real SDK/Unix/Host path", async () => {
    const result = await scenario("minimax-valid");
    expect(result.error).toBeUndefined();
    expect(result.http).toBe(1);
    expect(result.terminal).toMatchObject({ terminalClass: "stop", toolCallCount: 1 });
    expect(result.outcome).toMatchObject({ outcome: "ok", stream: {
      counts: { normalizedEmptyToolTypes: 1 }, engine: { chatDialect: "minimax-inline-v1" },
      toolIdentity: { sent: { matchesDeclared: true } },
    } });
    expect(result.outcome?.stream?.toolIdentity?.firstMismatch).toBeUndefined();
    expect(result.parts.filter(part => part.type === "tool-call")).toHaveLength(1);
    expect(result.parts.filter(part => part.type === "text-delta").map(part => part.textDelta).join("")).toBe("progress");
  });
  for (const [kind, cause] of [["minimax-unknown-second", "undeclared_tool"], ["minimax-open-think", "unterminated_reasoning"]] as const) {
    test(`${kind} releases no tools from the rejected batch and never retries`, async () => {
      const result = await scenario(kind);
      expect(result.http).toBe(1);
      expect(result.error).toMatchObject({ code: "invalid_stream", stage: "normalize" });
      expect(result.terminal).toMatchObject({ terminalClass: "error", toolCallCount: 0 });
      expect(result.outcome).toMatchObject({ outcome: "error", diagnostic: { normalizeCause: cause } });
      expect(result.parts.some(part => part.type === "tool-call")).toBe(false);
      expect(result.outcome?.attempts).toHaveLength(1);
      if (kind === "minimax-unknown-second") expect(result.outcome?.stream?.toolIdentity?.firstMismatch?.relation).toBe("unmatched");
    });
  }
  test("complete declared tool still succeeds and reports one measured provider attempt", async () => {
    const result = await scenario("valid");
    expect(result.error).toBeUndefined();
    expect(result.firstChunk).toBe(1);
    expect(result.terminal).toMatchObject({ terminalClass: "stop", toolCallCount: 1 });
    expect(result.outcome).toMatchObject({ outcome: "ok", phase: "complete", stream: { counts: { providerFetchCalls: 1 }, providerFinishReason: "tool_calls" } });
    expect(result.outcome?.failureCode).toBeUndefined();
    expect(result.outcome?.attempts).toHaveLength(1);
  });
});
