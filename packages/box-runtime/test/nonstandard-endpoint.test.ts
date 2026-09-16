import { describe, expect, test } from "bun:test";
import { BackendFailure, streamFailureDiagnostic, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { drainSdkStream } from "../src/internal/backends/openai-events.ts";
import { admitNonstandardOpenaiEvent, createNonstandardOpenaiStreamState, repairOpenaiToolCallId } from "../src/internal/backends/nonstandard-endpoint.ts";

describe("nonstandard OpenAI wire", () => {
  test("existing control cleanup preserves a non-empty bounded id", () => {
    expect(repairOpenaiToolCallId("call_\nowned")).toBe("call_owned");
    expect(repairOpenaiToolCallId("ok-id_1")).toBe("ok-id_1");
    expect(() => repairOpenaiToolCallId("\n\n")).toThrow(BackendFailure);
    expect(() => repairOpenaiToolCallId("x".repeat(129))).toThrow(BackendFailure);
  });
  test("all distinct calls survive to the Host all-or-nothing release gate", () => {
    const state = createNonstandardOpenaiStreamState();
    expect(admitNonstandardOpenaiEvent({ type: "tool_start", toolCallId: "one\n", toolName: "lookup" }, state)).toMatchObject({ toolCallId: "one" });
    expect(admitNonstandardOpenaiEvent({ type: "tool_start", toolCallId: "two\n", toolName: "notify" }, state)).toMatchObject({ toolCallId: "two" });
    expect(admitNonstandardOpenaiEvent({ type: "tool_complete", toolCallId: "one\n", toolName: "lookup", args: { q: "x" } }, state)).toMatchObject({ toolCallId: "one" });
  });
  test("normalization collisions cannot fuse two provider calls", () => {
    const state = createNonstandardOpenaiStreamState();
    admitNonstandardOpenaiEvent({ type: "tool_start", toolCallId: "a\n1", toolName: "lookup" }, state);
    try { admitNonstandardOpenaiEvent({ type: "tool_start", toolCallId: "a1", toolName: "lookup" }, state); throw Error("should reject"); }
    catch (error) { expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "tool_id_collision" }); }
  });
  test("two complete tool calls are forwarded, never silently truncated to one", async () => {
    const events: InferenceEvent[] = [];
    await drainSdkStream((async function* () {
      yield { type: "tool-call-streaming-start", toolCallId: "a\n1", toolName: "lookup" };
      yield { type: "tool-call", toolCallId: "a\n1", toolName: "lookup", args: { q: "ping" } };
      yield { type: "tool-call-streaming-start", toolCallId: "b\n2", toolName: "notify" };
      yield { type: "tool-call", toolCallId: "b\n2", toolName: "notify", args: { text: "pong" } };
      yield { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };
    })(), event => { events.push(event); });
    expect(events.filter(e => e.type === "tool_complete")).toEqual([
      { type: "tool_complete", toolCallId: "a1", toolName: "lookup", args: { q: "ping" } },
      { type: "tool_complete", toolCallId: "b2", toolName: "notify", args: { text: "pong" } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "backend_finish", finishReason: "stop" });
  });
});
