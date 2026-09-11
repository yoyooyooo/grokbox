import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asHostPromptSession,
  createStreamingPromptSession,
  normalizeHostResponse,
  visibleFailureHandle,
  type StreamPart,
} from "../src/internal/host/session.ts";
import { reshapeInferenceEvent } from "../src/internal/host/stream-codec.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { collectStreamParts, consumeHandle } from "./host-consumer.ts";

describe("host session ABI", () => {
  test("getModelId/getExecutor/stream getters are independent arrays", async () => {
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () {
        yield { type: "text-delta", textDelta: "hi" };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
      },
    }), "stub/echo", undefined, { requireStepId: true });
    expect(session.getModelId()).toBe("stub/echo");
    const executor = session.getExecutor([{ role: "user", content: "hi" }]);
    executor.appendMessages([{ role: "user", content: "again" }]);
    const messages = executor.getMessages();
    messages.push("mutant");
    expect(executor.getMessages()).toHaveLength(2);
    executor.clearMessages();
    expect(executor.getMessages()).toEqual([]);
    const result = executor.stream({}, "step-1");
    expect(result).toHaveProperty("fullStream");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("usage");
    expect(result).toHaveProperty("extendedUsage");
    expect(result).toHaveProperty("providerMetadata");
    expect(result).toHaveProperty("invocationId");
    const parts = await collectStreamParts(result.fullStream);
    expect(parts.some((part) => part.type === "text-delta")).toBe(true);
    const response = await result.response;
    const usage = await result.usage;
    expect(response.modelId).toBe("stub/echo");
    expect(response.finishReason).toBe("stop");
    expect(usage).toEqual({ promptTokens: 2, completionTokens: 1, totalTokens: 3 });
    expect(await result.invocationId).toBe("step-1");
  });

  test("missing step id rejects without produce", async () => {
    let produced = 0;
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () {
        produced += 1;
        yield { type: "finish", reason: "stop" };
      },
    }), "stub/echo", undefined, { requireStepId: true });
    const result = session.getExecutor([]).stream({});
    await expect(result.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    await expect(collectStreamParts(result.fullStream)).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    expect(produced).toBe(0);
  });

  test("error handle does not invent 1/1/2 usage", async () => {
    const handle = visibleFailureHandle("stub/echo", "invalid_envelope");
    await expect(handle.usage).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError" });
  });

  test("slow second reader does not retrigger produce", async () => {
    let produced = 0;
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () {
        produced += 1;
        yield { type: "text-delta", textDelta: "one" };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    });
    const handle = prompt.stream({ messages: [{ role: "user", content: "hi" }] });
    const first = collectStreamParts(handle.fullStream);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = collectStreamParts(handle.fullStream);
    await Promise.all([first, second]);
    await handle.response;
    expect(produced).toBe(1);
  });

  test("cancelling one reader does not cancel the producer", async () => {
    let produced = 0;
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () {
        produced += 1;
        yield { type: "text-delta", textDelta: "keep" };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    });
    const handle = prompt.stream({ messages: [{ role: "user", content: "hi" }] });
    const iterator = handle.fullStream[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    const rest = await collectStreamParts(handle.fullStream);
    expect(rest.some((part) => part.type === "finish")).toBe(true);
    expect(produced).toBe(1);
  });

  test("reshape maps canonical events and drops backend_finish", () => {
    expect(reshapeInferenceEvent({ type: "text_delta", text: "a" })).toEqual({ kind: "part", part: { type: "text-delta", textDelta: "a" } });
    expect(reshapeInferenceEvent({ type: "backend_finish", finishReason: "stop" })).toEqual({ kind: "ignore" });
    expect(reshapeInferenceEvent({ type: "mystery_event" })).toEqual({ kind: "invalid" });
    expect(reshapeInferenceEvent({ type: "text_delta", text: 42 })).toEqual({ kind: "invalid" });
    expect(reshapeInferenceEvent({ type: "tool_complete", toolCallId: "c1", toolName: "lookup", args: { q: "1" } }))
      .toEqual({ kind: "part", part: { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "1" } } });
  });

  test("serial extra tool fails closed with zero executable releases", async () => {
    const parts: StreamPart[] = [
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "1" } },
      { type: "tool-call", toolCallId: "c2", toolName: "lookup", args: { q: "2" } },
      { type: "finish", reason: "stop" },
    ];
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () { for (const part of parts) yield part; },
    });
    const envelope = buildHostEnvelope(
      [{ role: "user", content: "hi" }],
      [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    );
    const handle = prompt.stream({ envelope });
    const vector = await consumeHandle(handle);
    expect(vector.toolExecutionCount).toBe(0);
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError", code: "parallel_tools" });
  });

  test("undeclared tool name is not released as an executable Host call", async () => {
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      produce: async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "undeclared", args: {} };
        yield { type: "finish", reason: "stop" };
      },
    });
    const envelope = buildHostEnvelope(
      [{ role: "user", content: "hi" }],
      [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    );
    const handle = prompt.stream({ envelope });
    const vector = await consumeHandle(handle);
    expect(vector.toolExecutionCount).toBe(0);
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_stream" });
  });

  test("qualified context window is projected as extendedUsage.maxTokens; unknown stays unqualified", async () => {
    const produce = async function* () {
      yield { type: "text-delta" as const, textDelta: "hi" };
      yield {
        type: "finish" as const, reason: "stop" as const,
        usage: { promptTokens: 179999, completionTokens: 20, totalTokens: 180019, cacheReadTokens: 12, cacheWriteTokens: 3 },
      };
    };
    const qualified = asHostPromptSession(createStreamingPromptSession({
      modelId: "openai/gpt", vision: false, parallel: "allow", produce,
    }), "openai/gpt", undefined, { contextWindowTokens: 200000 });
    const known = await qualified.getExecutor([{ role: "user", content: "hi" }]).stream({}, "step-w").extendedUsage;
    expect(known).toEqual({
      inputTokens: 179999, outputTokens: 20, cacheReadTokens: 12, cacheWriteTokens: 3, maxTokens: 200000,
    });
    expect(known.maxTokens).not.toBe(20);
    const stubUnknown = asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo", vision: false, parallel: "allow", produce,
    }), "stub/echo");
    const missing = await stubUnknown.getExecutor([{ role: "user", content: "hi" }]).stream({}, "step-unknown").extendedUsage;
    expect(missing.maxTokens).toBe(0);
    expect(missing.inputTokens).toBe(179999);
  });

  test("stub contextWindowTokens is projected as Host W", async () => {
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo", vision: false, parallel: "allow",
      produce: async function* () {
        yield { type: "text-delta", textDelta: "hi" };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
      },
    }), "stub/echo", undefined, { contextWindowTokens: 200000 });
    expect(await session.getExecutor([{ role: "user", content: "hi" }]).stream({}, "step-stub-w").extendedUsage).toMatchObject({
      inputTokens: 2, outputTokens: 1, maxTokens: 200000,
    });
  });

  test("non-stub missing window refuses before produce", async () => {
    let produced = 0;
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "openai/gpt", vision: false, parallel: "allow",
      produce: async function* () {
        produced += 1;
        yield { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    }), "openai/gpt");
    const executor = session.getExecutor([{ role: "user", content: "hi" }]);
    await expect(executor.stream({}, "step-nowindow").response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    expect(produced).toBe(0);
    expect(executor.getState()).toEqual([{ role: "user", content: "hi" }]);
  });

  test("settled tool-call response has no toolCalls alias", async () => {
    const prompt = createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      produce: async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "1" } };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } };
      },
    });
    const envelope = buildHostEnvelope(
      [{ role: "user", content: "hi" }],
      [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    );
    const handle = prompt.stream({ envelope });
    const response = await handle.response;
    expect(response.finishReason).toBe("tool-calls");
    expect(response.messages[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "1" } }],
    });
    expect(Object.hasOwn(response.messages[0]!, "toolCalls")).toBe(false);
    const wrapped = await asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo", vision: false, parallel: "allow",
      produce: async function* () {
        yield { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "1" } };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } };
      },
    }), "stub/echo", undefined, { contextWindowTokens: 200000 })
      .getExecutor([{ role: "user", content: "hi" }])
      .stream({}, "step-alias", [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }])
      .response;
    expect(Object.hasOwn(wrapped.messages[0]!, "toolCalls")).toBe(false);
    expect(JSON.stringify(wrapped.messages[0])).not.toContain("\"toolCalls\"");
  });

  test("normalizeHostResponse does not rehydrate a toolCalls alias", () => {
    const normalized = normalizeHostResponse({
      modelId: "stub/echo",
      finishReason: "tool-calls",
      messages: [{
        role: "assistant",
        content: [],
        toolCalls: [{ id: "c1", name: "lookup", args: { q: 1 } }],
      }],
    });
    expect(normalized.messages).toEqual([{ role: "assistant", content: [] }]);
    expect(Object.hasOwn(normalized.messages[0]!, "toolCalls")).toBe(false);
  });

  test("session source does not keep the internal toolCalls alias or 1/1/2 fixture default", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/internal/host/session.ts"), "utf8");
    expect(src).not.toMatch(/message\.toolCalls/);
    expect(src).not.toMatch(/toolCalls\?:\s*Array</);
    expect(src).not.toMatch(/promptTokens:\s*1,\s*completionTokens:\s*1,\s*totalTokens:\s*2/);
    expect(src).not.toMatch(/usage:\s*config\.usage\s*\?\?/);
  });

  test("stop without measured usage does not settle 0/0 success", async () => {
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "openai/gpt", vision: false, parallel: "allow",
      produce: async function* () {
        yield { type: "text-delta", textDelta: "partial" };
        yield { type: "finish", reason: "stop" };
      },
    }), "openai/gpt", undefined, { contextWindowTokens: 200000 });
    const executor = session.getExecutor([{ role: "user", content: "hi" }]);
    const handle = executor.stream({}, "step-nousage");
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError" });
    await expect(handle.usage).rejects.toBeDefined();
    expect(executor.getState()).toEqual([{ role: "user", content: "hi" }]);
  });
});
