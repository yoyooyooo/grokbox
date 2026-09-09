import { describe, expect, test } from "bun:test";
import {
  asHostPromptSession,
  createStreamingPromptSession,
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
    const response = await result.response;
    expect(response.finishReason).toBe("error");
    expect(produced).toBe(0);
  });

  test("error handle does not invent 1/1/2 usage", async () => {
    const handle = visibleFailureHandle("stub/echo", "invalid_envelope");
    const usage = await handle.usage;
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
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
        yield { type: "finish", reason: "stop" };
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
    const response = await handle.response;
    expect(response.finishReason).toBe("error");
    expect(response.error?.code).toBe("parallel_tools");
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
    expect((await handle.response).finishReason).toBe("error");
  });
});
