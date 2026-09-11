import { describe, expect, test } from "bun:test";
import { collectHostDuplicateStream, hasMeaningfulResponseMessageContent } from "./host-consumer.ts";
import { asHostPromptSession, createManagedPromptSession, type StreamPart } from "../src/internal/host/session.ts";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";

const MEASURED_USAGE = { promptTokens: 8, completionTokens: 3, totalTokens: 11 };
const textParts: StreamPart[] = [
  { type: "text-delta", textDelta: "hello" },
  { type: "finish", reason: "stop", usage: MEASURED_USAGE },
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
    expect(usage).toEqual(MEASURED_USAGE);
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
        { type: "finish", reason: "stop", usage: MEASURED_USAGE },
      ],
    });
    const handle = session.stream({
      envelope: buildHostEnvelope(
        [{ role: "user", content: "hi" }],
        [{ name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } }],
      ),
    });
    const ids: string[] = [];
    for await (const part of handle.fullStream) {
      if (part.type === "tool-call") ids.push(part.toolCallId);
    }
    const response = await handle.response;
    expect(ids).toEqual(["call-1"]);
    expect(response.messages[0]?.content).toEqual([
      { type: "tool-call", toolCallId: "call-1", toolName: "bash", args: { command: "pwd" } },
    ]);
    expect(Object.hasOwn(response.messages[0]!, "toolCalls")).toBe(false);
  });

  test("managed fixture does not invent 1/1/2 usage when finish has none", async () => {
    const session = createManagedPromptSession({
      modelId: "fake/nousage",
      vision: false,
      parallel: "allow",
      parts: [
        { type: "text-delta", textDelta: "hello" },
        { type: "finish", reason: "stop" },
      ],
    });
    const handle = session.stream();
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError" });
    await expect(handle.usage).rejects.toBeDefined();
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
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError", code: "unsupported_image" });
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
    await expect(handle.response).rejects.toMatchObject({ name: "RetriableError", code: "parallel_tools", userVisible: true });
    const parts: StreamPart[] = [];
    try {
      for await (const part of handle.fullStream) parts.push(part);
    } catch { /* Host consumeStream throw path */ }
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
    expect(parts.some((part) => part.type === "text-delta")).toBe(false);
    expect(parts.some((part) => part.type === "error")).toBe(true);
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
    expect(response.messages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
    expect(await result.usage).toEqual(MEASURED_USAGE);
    const fromStream: string[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") fromStream.push(part.textDelta);
    }
    expect(fromStream).toEqual(["hello"]);
    expect(await result.extendedUsage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      maxTokens: 0,
    });
    expect(await result.providerMetadata).toEqual({});
    expect(await result.invocationId).toBe("inv-1");
    expect(session.getExecutorWithoutResolvedModelTracking()).not.toBe(session.getExecutor());
  });

  test("Host adapter needs no producer delay when duplicateStream's second reader attaches late",
    async () => {
    const inner = createManagedPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      parts: textParts,
    });
    const session = asHostPromptSession(inner, "stub/echo");
    const result = session.getExecutor().stream({}, "inv-dup", [], {});
    expect(result).not.toBeInstanceOf(Promise);
    expect("then" in result).toBe(false);

    const [innerParts, fullParts] = await collectHostDuplicateStream(result.fullStream);
    for (const parts of [innerParts, fullParts]) {
      expect(parts.some((part) => part.type === "text-delta" && part.textDelta === "hello")).toBe(true);
      const finish = parts.find((part) => part.type === "finish");
      expect(finish).toMatchObject({
        type: "finish",
        reason: "stop",
        finishReason: "stop",
        usage: MEASURED_USAGE,
        response: { modelId: "stub/echo", messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }] },
      });
    }
    const response = await result.response;
    expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
  });
});
