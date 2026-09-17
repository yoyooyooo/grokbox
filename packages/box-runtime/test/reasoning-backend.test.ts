import { readPreparedCall } from "../src/internal/backends/prepared.ts";
import { describe, expect, test } from "bun:test";
import { createOpenAI } from "@ai-sdk/openai";
import { Effect, Stream } from "effect";
import { StreamEvidence, projectStreamSummary, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import type { ReasoningPolicy } from "@grokbox/runtime-kernel/selection";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { encodeReasoningRequest } from "../src/internal/backends/reasoning-request.ts";
import { generationSettings } from "../src/internal/backends/openai-prompt-adapter.ts";
import { mapSdkStreamPart, createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { usageFromTerminal } from "../src/internal/host/stream-codec.ts";
import { normalizeHostUsage } from "../src/internal/host/session.ts";
import { reasoningModel, reasoningResponse, reasoningSnapshot } from "./reasoning-fixture.ts";
type Body = Record<string, any>;
async function infer(api: "chat" | "responses", reasoning?: ReasoningPolicy, modelName = "grok-4.6") {
  let sent: Body | undefined, calls = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => { calls++; sent = JSON.parse(String(init?.body)); return reasoningResponse(api); }) as typeof globalThis.fetch;
  const record = { ...reasoningModel(api, modelName), ...(reasoning ? { reasoning } : {}) };
  const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const snapshot = reasoningSnapshot({ parallelToolCalls: false, maxTokens: 100, temperature: 0.2, toolChoice: "none" });
    snapshot.tools.push({ name: "lookup", inputSchema: { type: "object", properties: {} } });
    const prepared = yield* backend.prepare(record, snapshot);
    if (record.reasoning) record.reasoning.effort = "low";
    snapshot.options.maxTokens = 1; record.endpoint = "https://changed.invalid/v1";
    const lease = yield* auth.pin({ apiKeyRef: "env:FIXTURE_KEY" });
    return yield* Stream.runCollect(backend.infer({}, prepared, lease.lease));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { FIXTURE_KEY: "synthetic" } })))));
  const terminal = [...events].find((e): e is Extract<InferenceEvent, {type:"backend_finish"}> => e.type === "backend_finish")!;
  return { body: sent!, calls, terminal };
}
describe("reasoning HTTP encoding and evidence", () => {
  test("locked SDK loses Grok Responses effort but our production adapter restores it", async () => {
    let raw: Body | undefined;
    const sdk = createOpenAI({ apiKey: "synthetic", baseURL: "https://fixture.invalid/v1", fetch: (async (_url, init) => {
      raw = JSON.parse(String(init?.body)); return reasoningResponse("responses");
    }) as typeof fetch });
    const result = await sdk.responses("grok-4.6").doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "local" }] }], providerOptions: { openai: { reasoningEffort: "xhigh" } } });
    const reader = result.stream.getReader(); const start = await reader.read(); await reader.cancel();
    expect(raw).not.toHaveProperty("reasoning");
    expect(start.value).toMatchObject({ type: "stream-start", warnings: [{ type: "unsupported-setting", setting: "reasoningEffort" }] });
    const fixed = await infer("responses", { effort: "xhigh" });
    expect(fixed.body.reasoning).toEqual({ effort: "xhigh" });
    expect(fixed.terminal.stream?.sdkWarnings).toContainEqual({ type: "unsupported-setting", setting: "reasoningEffort" });
  });
  for (const api of ["chat", "responses"] as const) {
    test(`${api}: frozen effort, parallel/tools/budget and subset usage survive HTTP`, async () => {
      const { body, calls, terminal } = await infer(api, { effort: "xhigh" });
      expect(calls).toBe(1); expect(body.model).toBe("grok-4.6");
      expect(api === "chat" ? body.reasoning_effort : body.reasoning?.effort).toBe("xhigh");
      expect(body.parallel_tool_calls).toBe(false); expect(body.tool_choice).toBe("none");
      expect(api === "chat" ? body.max_tokens : body.max_output_tokens).toBe(100);
      expect(body.temperature).toBe(0.2);
      expect(terminal.usage).toMatchObject({ promptTokens: 10, completionTokens: 20, reasoningTokens: 12 });
      expect(terminal.stream?.reasoning).toEqual({ requested: "xhigh", emitted: "xhigh", providerReported: "unknown" });
      expect(usageFromTerminal(terminal.usage)).toMatchObject({ promptTokens: 10, completionTokens: 20, totalTokens: 30, reasoningTokens: 12 });
      expect(normalizeHostUsage(usageFromTerminal(terminal.usage)).totalTokens).toBe(30);
    });
    test(`${api}: default omits effort, never fabricates medium/none`, async () => {
      const { body, terminal } = await infer(api);
      expect(body).not.toHaveProperty("reasoning_effort"); expect(body.reasoning?.effort).toBeUndefined();
      expect(terminal.stream?.reasoning).toEqual({ requested: "default", emitted: "default", providerReported: "unknown" });
    });
  }
  test("native SDK receives none to preserve its sampling-parameter behavior", async () => {
    const { body } = await infer("responses", { effort: "none" }, "gpt-5.1");
    expect(body.reasoning.effort).toBe("none"); expect(body.temperature).toBe(0.2);
  });
  test("settings merge cannot clobber reasoning or parallelToolCalls false", () => {
    expect(generationSettings({ parallelToolCalls: false, maxTokens: 64 }, "responses", { effort: "xhigh" })).toEqual({
      maxOutputTokens: 64, providerOptions: { openai: { parallelToolCalls: false, reasoningEffort: "xhigh" } },
    });
  });
  test("egress rejects conflicts, foreign protocol fields and wrong model; default preserves bytes", () => {
    const init = { body: '{ "model": "grok-4.6", "stream": true }' };
    expect(encodeReasoningRequest(init, "responses", "grok-4.6", undefined)).toBe(init);
    for (const [api, body] of [
      ["responses", { reasoning: { effort: "high" } }], ["responses", { reasoning_effort: "xhigh" }],
      ["responses", { reasoning: null }], ["chat", { reasoning: { effort: "xhigh" } }], ["chat", { reasoning_effort: "low" }],
    ] as const) expect(() => encodeReasoningRequest({ body: JSON.stringify({ model: "grok-4.6", ...body }) }, api, "grok-4.6", { effort: "xhigh" })).toThrow();
    expect(() => encodeReasoningRequest({ body: '{"model":"gpt-5","reasoning":{"effort":"xhigh"}}' }, "responses", "grok-4.6", { effort: "xhigh" })).toThrow();
    expect(() => encodeReasoningRequest({ body: '{"model":"grok-4.6","reasoning_effort":"high"}' }, "chat", "grok-4.6", undefined)).toThrow();
  });
  test("unqualified effort fails before credentials and HTTP", async () => {
    for (const capability of [undefined, false, { efforts: ["low"] }]) {
      let pins = 0, calls = 0;
      const model = reasoningModel(); model.capabilities.reasoning = capability as never;
      const fetch = (async (_url: unknown, _init?: RequestInit) => { calls++; return reasoningResponse("responses"); }) as typeof globalThis.fetch;
      const result = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const backend = yield* ModelBackend, auth = yield* BackendAuth;
        yield* backend.prepare({ ...model, reasoning: { effort: "xhigh" } }, reasoningSnapshot());
        pins++; yield* auth.pin({ apiKeyRef: model.apiKeyRef });
      }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { FIXTURE_KEY: "synthetic" } })))));
      await expect(result).rejects.toMatchObject({ code: "unsupported_options" }); expect(pins).toBe(0); expect(calls).toBe(0);
    }
  });
  test("usage absence, zero, invalid values and inconsistent subsets remain distinct", () => {
    for (const reasoningTokens of [undefined, 0, 12, -1, 1.5, 21, NaN]) {
      const mapped = mapSdkStreamPart({ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20, reasoningTokens } }, new Map());
      expect(mapped).toMatchObject({ type: "backend_finish", usage: { promptTokens: 10, completionTokens: 20 } });
      if (mapped !== "skip" && mapped.type === "backend_finish") expect(mapped.usage?.reasoningTokens).toBe(reasoningTokens === 0 || reasoningTokens === 12 ? reasoningTokens : undefined);
    }
  });
  test("SDK warnings are bounded and redacted; Provider effort is not guessed", () => {
    const evidence = new StreamEvidence(); evidence.reasoningRequested("xhigh");
    const normalizer = createSdkStreamNormalizer({ evidence });
    normalizer.next({ type: "stream-start", warnings: Array.from({length:40}, () => ({ type: "unsupported-setting", setting: "private-setting", details: "secret-prompt-body" })) });
    const summary = projectStreamSummary({ ...evidence.snapshot(), reasoning: { requested: "xhigh", emitted: "xhigh", providerReported: "xhigh" } })!;
    expect(summary.sdkWarnings).toHaveLength(16); expect(summary.counts.sdkWarnings).toBe(40);
    expect(summary.reasoning?.providerReported).toBe("unknown"); expect(JSON.stringify(summary)).not.toContain("secret-prompt"); expect(JSON.stringify(summary)).not.toContain("private-setting");
  });
});

test("an encoder setting diverging from the frozen policy is rejected before actual fetch", async () => {
  let calls = 0;
  const record = reasoningModel("responses", "gpt-5.1");
  const fetch = Object.assign(async (_url: unknown, _init?: RequestInit) => { calls++; return reasoningResponse("responses"); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const result = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const prepared = yield* backend.prepare({ ...record, reasoning: { effort: "high" } }, reasoningSnapshot());
    // Deliberate private encoder drift: the policy remains high, but SDK sees low.
    readPreparedCall(prepared)!.settings.providerOptions!.openai.reasoningEffort = "low";
    const pinned = yield* auth.pin({ apiKeyRef: "env:FIXTURE_KEY" });
    return yield* Stream.runCollect(backend.infer({}, prepared, pinned.lease));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { FIXTURE_KEY: "synthetic" } })))));
  await expect(result).rejects.toMatchObject({ code: "unsupported_options" });
  expect(calls).toBe(0);
});

test("warning projection never executes array-index or field getters", () => {
  let reads = 0;
  const warnings: unknown[] = [];
  Object.defineProperty(warnings, "0", { configurable: true, get() { reads++; return { setting: "private" }; } });
  const row = { type: "unsupported-setting" };
  Object.defineProperty(row, "setting", { get() { reads++; return "private"; } });
  warnings[1] = row;
  const evidence = new StreamEvidence(); evidence.sdkWarnings(warnings);
  const summary = projectStreamSummary({ ...evidence.snapshot(), sdkWarnings: warnings });
  expect(reads).toBe(0);
  expect(summary?.sdkWarnings).toEqual([{ type: "other", setting: "unknown" }, { type: "unsupported-setting", setting: "unknown" }]);
  expect(JSON.stringify(summary)).not.toContain("private");
});
