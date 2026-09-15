import { describe, expect, test } from "bun:test";
import { BackendFailure } from "@grokbox/runtime-kernel/contract";
import { drainSdkStream } from "../src/internal/backends/openai-events.ts";
import {
  admitNonstandardOpenaiEvent,
  createNonstandardOpenaiStreamState,
  repairOpenaiToolCallId,
} from "../src/internal/backends/nonstandard-endpoint.ts";

describe("nonstandard OpenAI wire", () => {
  test("strips C0 controls including LF from call_id", () => {
    expect(repairOpenaiToolCallId("call_\nowned")).toBe("call_owned");
    expect(repairOpenaiToolCallId("ok-id_1")).toBe("ok-id_1");
  });

  test("empty or oversized ids after repair fail closed", () => {
    expect(() => repairOpenaiToolCallId("\n\n")).toThrow(BackendFailure);
    expect(() => repairOpenaiToolCallId("x".repeat(129))).toThrow(BackendFailure);
  });

  test("keeps the first tool and drops later parallel ids", () => {
    const state = createNonstandardOpenaiStreamState();
    const first = admitNonstandardOpenaiEvent(
      { type: "tool_start", toolCallId: "one\n", toolName: "lookup" },
      state,
    );
    const extra = admitNonstandardOpenaiEvent(
      { type: "tool_start", toolCallId: "two\n", toolName: "notify" },
      state,
    );
    const again = admitNonstandardOpenaiEvent(
      { type: "tool_complete", toolCallId: "one\n", toolName: "lookup", args: { q: "x" } },
      state,
    );
    expect(first).toMatchObject({ type: "tool_start", toolCallId: "one", toolName: "lookup" });
    expect(extra).toBe("drop");
    expect(again).toMatchObject({ type: "tool_complete", toolCallId: "one" });
  });
});

describe("nonstandard OpenAI stream into Host-shaped events", () => {
  test("LF ids and a second function_call do not reach Host as parallel tools", async () => {
    const events: Array<{ type: string; toolCallId?: string; toolName?: string }> = [];
    await drainSdkStream((async function* () {
      yield { type: "tool-call-streaming-start", toolCallId: "a\n1", toolName: "lookup" };
      yield { type: "tool-call", toolCallId: "a\n1", toolName: "lookup", args: { q: "ping" } };
      yield { type: "tool-call-streaming-start", toolCallId: "b\n2", toolName: "notify" };
      yield { type: "tool-call", toolCallId: "b\n2", toolName: "notify", args: { text: "pong" } };
      yield { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } };
    })(), (event) => {
      events.push(event);
    });
    const tools = events.filter((event) => event.type === "tool_start" || event.type === "tool_complete");
    expect(tools).toEqual([
      { type: "tool_start", toolCallId: "a1", toolName: "lookup" },
      { type: "tool_complete", toolCallId: "a1", toolName: "lookup", args: { q: "ping" } },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "backend_finish", finishReason: "stop" });
  });
});
