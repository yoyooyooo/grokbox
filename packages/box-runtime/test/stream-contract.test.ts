import { describe, expect, test } from "bun:test";
import { asHostPromptSession, createStreamingPromptSession, type SessionTerminal, type StreamPart } from "../src/internal/host/session.ts";
import { collectStreamParts, duplicateHostStream, hasMeaningfulResponseMessageContent } from "./host-consumer.ts";
import { scriptedStream, within } from "./scripted-stream.ts";

function fixture(input: { parallel?: "allow" | "fail-closed"; maxParts?: number; maxBytes?: number } = {}) {
  const script = scriptedStream();
  const terminals: SessionTerminal[] = [];
  const calls = { count: 0 };
  let driverSignal: AbortSignal | undefined;
  const session = asHostPromptSession(createStreamingPromptSession({ modelId: "fake/stream", vision: false,
    parallel: input.parallel ?? "allow", maxParts: input.maxParts, maxBytes: input.maxBytes, providerCalls: calls,
    onTerminal: (terminal) => terminals.push(terminal),
    produce: (request) => { driverSignal = request.abortSignal; return script.source; },
  }), "fake/stream", undefined, { contextWindowTokens: 200000 });
  return { script, session, terminals, calls, driverSignal: () => driverSignal };
}
const STOP: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 8, completionTokens: 4, totalTokens: 12 } };
const LOOKUP_TOOLS = [
  { name: "lookup", inputSchema: { type: "object", properties: { n: { type: "number" }, query: { type: "string" } } } },
  { name: "memory_write", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
];

describe("incremental stream contract, scripted producer with provider hard-off", () => {
  test("first chunk arrives before completion; independent late readers replay without redispatch", async () => {
    const f = fixture();
    const handle = f.session.getExecutor([]).stream({}, "inv-chunks");
    expect(handle).not.toBeInstanceOf(Promise);
    let responded = false;
    void handle.response.then(() => { responded = true; });
    const first = handle.fullStream[Symbol.asyncIterator]();
    f.script.push({ type: "text-delta", textDelta: "first" });
    expect(await within(first.next())).toMatchObject({ done: false, value: { type: "text-delta", textDelta: "first" } });
    expect(responded).toBe(false); // The fixture has not even supplied a terminal yet.
    f.script.push({ type: "text-delta", textDelta: " second" });
    f.script.push(STOP);
    const response = await within(handle.response);
    expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "first second" }] }]);
    expect(await within(handle.usage)).toEqual({ promptTokens: 8, completionTokens: 4, totalTokens: 12 });
    const late = await within(collectStreamParts(handle.fullStream));
    expect(late.filter((part) => part.type === "text-delta")).toMatchObject([
      { type: "text-delta", textDelta: "first" }, { type: "text-delta", textDelta: " second" },
    ]);
    expect(late.at(-1)).toMatchObject({ type: "finish", reason: "stop", response });
    expect(f.calls.count).toBe(1);
    expect(f.terminals).toMatchObject([{ terminalClass: "stop", toolCallCount: 0 }]);
    await first.return?.();
  });

  test("closing a waiting reader resolves it promptly without canceling the producer or another reader", async () => {
    const f = fixture();
    const handle = f.session.getExecutor().stream({}, "inv-close-reader");
    const reader = handle.fullStream[Symbol.asyncIterator]();
    const pending = reader.next();
    expect(await within(reader.return!())).toMatchObject({ done: true });
    expect(await within(pending)).toMatchObject({ done: true });
    expect(f.driverSignal()?.aborted).toBe(false);
    f.script.push({ type: "text-delta", textDelta: "still available" }); f.script.push(STOP);
    expect((await within(collectStreamParts(handle.fullStream)))[0]).toMatchObject({ type: "text-delta", textDelta: "still available" });
    expect((await within(handle.response)).finishReason).toBe("stop");
    expect(f.calls.count).toBe(1);
  });

  test("Host backpressured forks can attach the UI after response without holding the producer/completion", async () => {
    const f = fixture();
    const handle = f.session.getExecutor().stream({}, "inv-late-ui");
    const [inner, late] = duplicateHostStream(handle.fullStream);
    const innerParts = collectStreamParts(inner);
    f.script.push({ type: "text-delta", textDelta: "before UI" });
    f.script.push(STOP);
    const response = await within(handle.response); // Does not wait for Host's blocked UI fork.
    expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
    const [left, right] = await within(Promise.all([innerParts, collectStreamParts(late)]));
    expect(left).toEqual(right);
    expect(left[0]).toMatchObject({ type: "text-delta", textDelta: "before UI" });
    expect(left.at(-1)).toMatchObject({ type: "finish", response });
    expect(f.calls.count).toBe(1);
  });

  test.each(["ctx", "options"])("%s abort settles even a stalled producer; late tokens/finish cannot win", async (where) => {
    const f = fixture();
    const ctx = new AbortController();
    const options = new AbortController();
    const handle = f.session.getExecutor().stream({ signal: ctx.signal }, "inv-abort", [], { abortSignal: options.signal });
    const iterator = handle.fullStream[Symbol.asyncIterator]();
    f.script.push({ type: "text-delta", textDelta: "prefix" });
    expect((await within(iterator.next())).value).toMatchObject({ type: "text-delta" });
    (where === "ctx" ? ctx : options).abort("private-abort-reason");
    const response = await within(handle.response);
    expect(response.finishReason).toBe("abort");
    expect(f.driverSignal()?.aborted).toBe(true);
    f.script.push({ type: "text-delta", textDelta: "must-not-deliver" });
    f.script.push(STOP);
    const parts = await within(collectStreamParts(handle.fullStream));
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
    expect(parts.at(-1)).toMatchObject({ reason: "abort" });
    expect(JSON.stringify(parts)).not.toMatch(/must-not-deliver|private-abort-reason/);
    expect(f.terminals).toMatchObject([{ terminalClass: "abort", toolCallCount: 0 }]);
    expect(f.calls.count).toBe(1);
    await iterator.return?.();
  });

  test("pre-abort never invokes the producer; one terminal is still available to late readers", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    const handle = f.session.getExecutor().stream({}, "inv-preabort", [], { abortSignal: controller.signal });
    expect((await within(handle.response)).finishReason).toBe("abort");
    expect(f.calls.count).toBe(0);
    expect(f.terminals).toMatchObject([{ terminalClass: "abort", toolCallCount: 0 }]);
    expect(await collectStreamParts(handle.fullStream)).toEqual([expect.objectContaining({ type: "finish", reason: "abort" })]);
  });

  test("first terminal wins over extra tokens, another terminal and later cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    const handle = f.session.getExecutor().stream({}, "inv-terminal", [], { abortSignal: controller.signal });
    f.script.push({ type: "text-delta", textDelta: "accepted" }); f.script.push(STOP);
    const response = await within(handle.response);
    f.script.push({ type: "text-delta", textDelta: "late" }); f.script.push({ type: "finish", reason: "error" }); controller.abort();
    const parts = await collectStreamParts(handle.fullStream);
    expect(parts).toHaveLength(2);
    expect(parts.at(-1)).toMatchObject({ type: "finish", reason: "stop", response });
    expect(f.terminals).toMatchObject([{ terminalClass: "stop", toolCallCount: 0 }]);
  });

  test("interleaved tool argument streams keep names/ids and produce one complete call per id", async () => {
    const f = fixture();
    const handle = f.session.getExecutor().stream({}, "inv-tools", LOOKUP_TOOLS);
    f.script.push({ type: "tool-call-streaming-start", toolCallId: "one", toolName: "lookup" });
    f.script.push({ type: "tool-call-streaming-start", toolCallId: "two", toolName: "memory_write" });
    f.script.push({ type: "tool-call-delta", toolCallId: "one", toolName: "lookup", argsTextDelta: '{"query":' });
    f.script.push({ type: "tool-call-delta", toolCallId: "two", toolName: "memory_write", argsTextDelta: '{"text":"note"}' });
    f.script.push({ type: "tool-call-delta", toolCallId: "one", toolName: "lookup", argsTextDelta: '"find"}' });
    const one = { type: "tool-call" as const, toolCallId: "one", toolName: "lookup", args: { query: "find" } };
    const two = { type: "tool-call" as const, toolCallId: "two", toolName: "memory_write", args: { text: "note" } };
    f.script.push(one); f.script.push(one); f.script.push(two); f.script.push(STOP);
    const response = await within(handle.response);
    expect(response.finishReason).toBe("tool-calls");
    expect(response.messages[0]!.content).toEqual([one, two]);
    expect(Object.hasOwn(response.messages[0]!, "toolCalls")).toBe(false); // no second Host call list
    const parts = await collectStreamParts(handle.fullStream);
    expect(parts.filter((part) => part.type === "tool-call")).toEqual([one, two]);
    expect(f.terminals).toMatchObject([{ terminalClass: "stop", toolCallCount: 2 }]);
  });

  test.each(["mismatched-args", "renamed-call", "incomplete-call", "conflicting-duplicate"])("%s is visible, never a silent id/args rewrite", async (fault) => {
    const f = fixture(); const handle = f.session.getExecutor().stream({}, "inv-invalid", LOOKUP_TOOLS);
    const call = { type: "tool-call" as const, toolCallId: "id", toolName: "lookup", args: { n: 1 } };
    if (fault === "conflicting-duplicate") { f.script.push(call); f.script.push({ ...call, args: { n: 2 } }); }
    else {
      f.script.push({ type: "tool-call-streaming-start", toolCallId: "id", toolName: "lookup" });
      f.script.push({ type: "tool-call-delta", toolCallId: "id", toolName: "lookup", argsTextDelta: '{"n":1}' });
      if (fault !== "incomplete-call") f.script.push({ ...call, ...(fault === "renamed-call" ? { toolName: "other" } : { args: { n: 9 } }) });
    }
    f.script.push(STOP);
    await expect(within(handle.response)).rejects.toMatchObject({ name: "RetriableError", code: "invalid_stream", userVisible: true, toolCallIds: ["id"] });
    const parts: StreamPart[] = [];
    try {
      for await (const part of handle.fullStream) parts.push(part);
    } catch (error) {
      expect(error).toMatchObject({ name: "RetriableError", code: "invalid_stream" });
    }
    expect(parts.filter((part) => part.type === "text-delta")).toHaveLength(0);
    expect(parts.filter((part) => part.type === "tool-call")).toHaveLength(fault === "conflicting-duplicate" ? 1 : 0);
  });

  test("serial-only policy withholds executable calls until completion; parallel rejection preserves both ids", async () => {
    const f = fixture({ parallel: "fail-closed" }); const handle = f.session.getExecutor().stream({}, "inv-serial", LOOKUP_TOOLS);
    f.script.push({ type: "tool-call", toolCallId: "a", toolName: "lookup", args: {} });
    f.script.push({ type: "tool-call", toolCallId: "b", toolName: "lookup", args: {} }); f.script.push(STOP);
    await expect(within(handle.response)).rejects.toMatchObject({ name: "RetriableError", code: "parallel_tools" });
    expect((await collectStreamParts(handle.fullStream).catch(() => [])).some((part) => part.type === "tool-call" || part.type === "text-delta")).toBe(false);
    expect(f.terminals).toMatchObject([{ terminalClass: "error", toolCallCount: 0, errorCode: "parallel_tools", rejected: true }]);
  });

  test.each(["parts", "bytes"])("%s cap stops production visibly and completes every observer", async (limit) => {
    const f = fixture(limit === "parts" ? { maxParts: 1 } : { maxBytes: 20 });
    const handle = f.session.getExecutor().stream({}, "inv-cap");
    f.script.push({ type: "text-delta", textDelta: "first" }); f.script.push({ type: "text-delta", textDelta: "second" });
    await expect(within(handle.response)).rejects.toMatchObject({ name: "RetriableError", code: "stream_limit" });
    expect((await within(collectStreamParts(handle.fullStream).catch(() => []))).some((part) => part.type === "text-delta" && part.textDelta === "second")).toBe(false);
    expect(f.driverSignal()?.aborted).toBe(true);
    expect(f.terminals).toHaveLength(1);
  });

  test("producer exception and missing terminal become redacted visible errors, not implicit success", async () => {
    for (const throws of [true, false]) {
      const session = asHostPromptSession(createStreamingPromptSession({ modelId: "fake/error", vision: false, parallel: "allow",
        produce: () => ({ async *[Symbol.asyncIterator]() { yield { type: "text-delta" as const, textDelta: "prefix" }; if (throws) throw new Error("private-provider-body-secret"); } }),
      }), "fake/error", undefined, { contextWindowTokens: 200000 });
      const handle = session.getExecutor().stream();
      await expect(within(handle.response)).rejects.toMatchObject({ name: "RetriableError", userVisible: true });
      const thrown = await handle.response.then(() => undefined, (error) => error as Error);
      expect(JSON.stringify(thrown)).not.toContain("private-provider");
      expect((await collectStreamParts(handle.fullStream).catch(() => [])).some((part) => part.type === "text-delta" && part.textDelta.includes("private-provider"))).toBe(false);
    }
  });
});
