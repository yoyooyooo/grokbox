import { expect, test } from "bun:test";
import { mapSdkStreamPart } from "../src/internal/backends/openai-events.ts";
import { backendFailureObservation } from "../src/internal/backends/failure-observation.ts";
import { createStreamingPromptSession, isHostManagedFailure, type StreamPart } from "../src/internal/host/session.ts";

for (const reason of ["length", "content-filter"] as const) {
  test(`SDK ${reason} is not promoted to a successful stop`, () => {
    let failure: unknown;
    try { mapSdkStreamPart({ type: "finish", finishReason: reason, totalUsage: { inputTokens: 4, outputTokens: 8 } }, new Map()); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "provider_error" });
    expect(backendFailureObservation(failure)).toEqual({ phase: "sdk", reason: reason === "length" ? "output_limit" : "content_filter" });
  });
}

for (const parts of [[], [{ type: "reasoning", textDelta: "Internal deliberation without any answer or tool." }], [{ type: "text-delta", textDelta: "   " }]] as StreamPart[][]) {
  test(`empty or reasoning-only successful finish becomes a managed failure (${parts[0]?.type ?? "empty"})`, async () => {
    const terminals: unknown[] = [];
    const session = createStreamingPromptSession({
      modelId: "openai-responses/owned", vision: false, parallel: "fail-closed",
      produce: async function* () {
        yield* parts;
        yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
      },
      onTerminal: (terminal) => { terminals.push(terminal); },
    });
    const handle = session.stream({ messages: [{ role: "user", content: "Answer the question" }], invocationId: "owned-step" });
    let failure: unknown;
    try { await handle.response; } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "invalid_stream" });
    expect(isHostManagedFailure(failure)).toBe(true);
    expect(terminals).toEqual([expect.objectContaining({ terminalClass: "error", errorCode: "invalid_stream", toolCallCount: 0 })]);
  });
}

test("non-empty assistant text with SendToUser declared becomes a Host SendToUser call", async () => {
  const session = createStreamingPromptSession({
    modelId: "openai-responses/owned", vision: false, parallel: "fail-closed",
    produce: async function* () {
      yield { type: "text-delta", textDelta: "MANAGED_VISIBLE" };
      yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
    },
  });
  const handle = session.stream({
    envelope: {
      version: 1,
      messages: [{ role: "user", content: "say it" }],
      tools: [{ name: "SendToUser", inputSchema: { type: "object", properties: { type: { type: "string" }, content: { type: "string" } } } }],
      options: {},
    },
  });
  const response = await handle.response;
  expect(response.finishReason).toBe("tool-calls");
  expect(response.messages).toEqual([{
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: expect.any(String), toolName: "SendToUser", args: { type: "text", content: "MANAGED_VISIBLE" } }],
  }]);
});

test("assistant text without SendToUser stays internal and does not invent a delivery tool", async () => {
  const session = createStreamingPromptSession({
    modelId: "openai-responses/owned", vision: false, parallel: "fail-closed",
    produce: async function* () {
      yield { type: "text-delta", textDelta: "private scratch" };
      yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
    },
  });
  const handle = session.stream({ messages: [{ role: "user", content: "aux" }], invocationId: "aux-step" });
  const response = await handle.response;
  expect(response.finishReason).toBe("stop");
  expect(response.messages).toEqual([{ role: "assistant", content: "private scratch" }]);
});

test("scratch text beside a real tool call is not rewritten into SendToUser", async () => {
  const session = createStreamingPromptSession({
    modelId: "openai-responses/owned", vision: false, parallel: "fail-closed",
    produce: async function* () {
      yield { type: "text-delta", textDelta: "thinking out loud" };
      yield { type: "tool-call", toolName: "ReadProbe", toolCallId: "call-1", args: {} };
      yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
    },
  });
  const handle = session.stream({
    envelope: {
      version: 1,
      messages: [{ role: "user", content: "read" }],
      tools: [
        { name: "ReadProbe", inputSchema: { type: "object", properties: {} } },
        { name: "SendToUser", inputSchema: { type: "object", properties: { type: { type: "string" }, content: { type: "string" } } } },
      ],
      options: {},
    },
  });
  const response = await handle.response;
  expect(response.finishReason).toBe("tool-calls");
  expect(response.messages[0]?.content).toEqual([
    { type: "text", text: "thinking out loud" },
    { type: "tool-call", toolCallId: "call-1", toolName: "ReadProbe", args: {} },
  ]);
});

test("a valid tool-only response remains executable with no assistant prose", async () => {
  const session = createStreamingPromptSession({
    modelId: "openai-responses/owned", vision: false, parallel: "fail-closed",
    produce: async function* () {
      yield { type: "tool-call", toolName: "ReadProbe", toolCallId: "call-1", args: {} };
      yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
    },
  });
  const handle = session.stream({ envelope: { version: 1, messages: [{ role: "user", content: "read" }], tools: [{ name: "ReadProbe", inputSchema: { type: "object", properties: {} } }], options: {} } });
  expect((await handle.response).finishReason).toBe("tool-calls");
});
