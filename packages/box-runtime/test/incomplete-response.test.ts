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
