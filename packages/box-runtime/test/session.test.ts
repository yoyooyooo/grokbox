import { describe, expect, test } from "bun:test";
import { asHostPromptSession, createManagedPromptSession, type StreamPart } from "../src/session.ts";

const textParts: StreamPart[] = [
  { type: "text-delta", textDelta: "hello" },
  { type: "finish", reason: "stop" },
];

describe("managed PromptSession contract", () => {
  test("stream() is synchronous and response does not consume fullStream", async () => {
    const session = createManagedPromptSession({
      modelId: "fake/main",
      vision: false,
      parallel: "allow",
      parts: textParts,
    });
    const handle = session.stream();
    expect(handle.fullStream).toBeDefined();
    expect(typeof handle.response.then).toBe("function");
    const fromStream: string[] = [];
    const finishes: StreamPart[] = [];
    for await (const part of handle.fullStream) {
      if (part.type === "text-delta") fromStream.push(part.textDelta);
      if (part.type === "finish") finishes.push(part);
    }
    const response = await handle.response;
    const usage = await handle.usage;
    expect(fromStream).toEqual(["hello"]);
    expect(response.modelId).toBe("fake/main");
    expect(response.messages[0]?.content).toBe("hello");
    expect(usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    expect(finishes[0]).toMatchObject({
      type: "finish",
      reason: "stop",
      finishReason: "stop",
      response: { modelId: "fake/main", messages: [{ role: "assistant", content: "hello" }] },
    });
    const again: StreamPart[] = [];
    for await (const part of handle.fullStream) again.push(part);
    expect(again.some((part) => part.type === "text-delta")).toBe(true);
  });

  test("tool-call ids match streamed parts", async () => {
    const session = createManagedPromptSession({
      modelId: "fake/tools",
      vision: false,
      parallel: "allow",
      parts: [
        { type: "tool-call", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } },
        { type: "finish", reason: "stop" },
      ],
    });
    const handle = session.stream();
    const ids: string[] = [];
    for await (const part of handle.fullStream) {
      if (part.type === "tool-call") ids.push(part.toolCallId);
    }
    const response = await handle.response;
    expect(ids).toEqual(["call-1"]);
    expect(response.messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["call-1"]);
  });

  test("images without vision fail before provider effect", async () => {
    const providerCalls = { count: 0 };
    const session = createManagedPromptSession({
      modelId: "fake/text",
      vision: false,
      parallel: "allow",
      parts: textParts,
      providerCalls,
    });
    const handle = session.stream({
      messages: [{ role: "user", content: [{ type: "image", url: "https://example.test/a.png" }] }],
    });
    expect(providerCalls.count).toBe(0);
    const failed = await handle.response;
    expect(failed.modelId.trim()).toBe("fake/text");
    expect(failed.messages.some((message) => message.role === "assistant")).toBe(true);
    const vision = createManagedPromptSession({
      modelId: "fake/vision",
      vision: true,
      parallel: "allow",
      parts: textParts,
      providerCalls,
    });
    const ok = vision.stream({
      messages: [{ role: "user", content: [{ type: "image", url: "https://example.test/a.png" }] }],
    });
    expect(providerCalls.count).toBe(1);
    expect((await ok.response).modelId).toBe("fake/vision");
  });

  test("parallel tool calls fail closed without dropping the second id", async () => {
    const session = createManagedPromptSession({
      modelId: "fake/serial",
      vision: false,
      parallel: "fail-closed",
      parts: [
        { type: "tool-call", toolCallId: "a", toolName: "bash", args: {} },
        { type: "tool-call", toolCallId: "b", toolName: "bash", args: {} },
        { type: "finish", reason: "stop" },
      ],
    });
    const handle = session.stream();
    const failed = await handle.response;
    expect(failed.modelId.trim()).toBe("fake/serial");
    expect(Array.isArray(failed.messages)).toBe(true);
    expect(failed.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(failed.messages[0]?.toolCalls?.map((call) => call.id)).toEqual(["a", "b"]);
    const parts: StreamPart[] = [];
    for await (const part of handle.fullStream) parts.push(part);
    expect(parts.some((part) => part.type === "finish" && part.reason === "error")).toBe(true);
  });

  test("abort yields one terminal and discards later parts", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = createManagedPromptSession({
      modelId: "fake/abort",
      vision: false,
      parallel: "allow",
      parts: [
        { type: "text-delta", textDelta: "late" },
        { type: "finish", reason: "stop" },
      ],
    });
    const handle = session.stream({ abortSignal: controller.signal });
    const parts: StreamPart[] = [];
    for await (const part of handle.fullStream) parts.push(part);
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
    expect(parts.some((part) => part.type === "text-delta")).toBe(false);
  });

  test("Host session getModelId then getExecutor().stream yields a trim-able modelId",
    async () => {
    const inner = createManagedPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      parts: textParts,
    });
    const session = asHostPromptSession(inner, "stub/echo");
    expect(session.getModelId().trim()).toBe("stub/echo");
    const executor = session.getExecutor({});
    expect(Array.isArray(executor.getMessages())).toBe(true);
    expect(Array.isArray(executor.getState())).toBe(true);
    executor.appendMessages([{ role: "user", content: "hi" }]);
    expect(executor.getMessages()).toEqual([{ role: "user", content: "hi" }]);
    executor.clearMessages();
    expect(executor.getState()).toEqual([]);
    const result = executor.stream({}, "inv-1", [], {});
    expect(result).not.toBeInstanceOf(Promise);
    expect("then" in result).toBe(false);
    const response = await result.response;
    expect(response.modelId.trim()).toBe("stub/echo");
    expect(response.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(await result.usage).toEqual({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    const fromStream: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") fromStream.push(part.textDelta);
    }
    expect(fromStream).toEqual(["hello"]);
    expect(await result.extendedUsage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    });
    expect(await result.providerMetadata).toEqual({});
    expect(await result.invocationId).toBe("inv-1");
    expect(session.getExecutorWithoutResolvedModelTracking()).toBe(session.getExecutor());
  });
});
