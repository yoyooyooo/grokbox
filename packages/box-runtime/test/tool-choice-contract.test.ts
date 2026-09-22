import { expect, test } from "bun:test";
import { buildModelEnvelope, streamFailureDiagnostic, toolChoiceViolation, type GenerationOptions } from "@grokbox/runtime-kernel/contract";
import { createSdkStreamNormalizer } from "../src/internal/backends/openai-events.ts";
import { createStreamingPromptSession, MANAGED_TOOL_POLICY, type SessionTerminal, type StreamPart } from "../src/internal/host/session.ts";

const tools = ["SendToAgent", "SendToUser"].map(name => ({ name, inputSchema: { type: "object" } }));
const finish: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } };
const call: StreamPart = { type: "tool-call", toolCallId: "one", toolName: "SendToAgent", args: {} };
for (const [choice, parts, reason] of [
  ["none", [call], "forbidden"],
  [{ type: "tool", toolName: "SendToUser" }, [call], "different_tool"],
  ["required", [{ type: "text-delta", textDelta: "answer" }], "missing_call"],
  [{ type: "tool", toolName: "SendToUser" }, [{ type: "text-delta", textDelta: "answer" }], "missing_call"],
] as Array<[GenerationOptions["toolChoice"], StreamPart[], string]>) {
  test(`Host enforces choice ${JSON.stringify(choice)} (${reason}) before batch or synthetic delivery`, async () => {
    let terminal: SessionTerminal | undefined;
    const session = createStreamingPromptSession({ modelId: "fixture", vision: false, parallel: MANAGED_TOOL_POLICY,
      onTerminal: value => { terminal = value; }, produce: async function* () { yield* parts; yield finish; } });
    const handle = session.stream({ envelope: buildModelEnvelope([{ role: "user", content: "fixture" }], tools, { toolChoice: choice }) });
    const error = await handle.response.catch(e => e), output: StreamPart[] = [];
    for await (const p of handle.fullStream) output.push(p);
    expect(error).toBeInstanceOf(Error);
    expect(streamFailureDiagnostic(error)).toMatchObject({ normalizeCause: "tool_choice_mismatch", toolChoice: { reason } });
    expect(output.filter(p => p.type.startsWith("tool-call"))).toEqual([]);
    expect(terminal).toMatchObject({ terminalClass: "error", toolCallCount: 0, diagnostic: { streams: { host: { toolBatchState: "discarded", toolValidationScope: "structure_only" } } } });
  });
}

test("none cannot be bypassed by SendToUser text fallback, while auto still delivers", async () => {
  for (const choice of ["none", "auto"] as const) {
    const session = createStreamingPromptSession({ modelId: "fixture", vision: false, parallel: MANAGED_TOOL_POLICY,
      produce: async function* () { yield { type: "text-delta", textDelta: "answer" }; yield finish; } });
    const response = await session.stream({ envelope: buildModelEnvelope([], tools, { toolChoice: choice }) }).response;
    expect(response.finishReason).toBe(choice === "none" ? "stop" : "tool-calls");
  }
});

test("required with no capability is rejected before constructing a request", () => {
  expect(() => buildModelEnvelope([], [], { toolChoice: "required" })).toThrow("invalid_tools");
});

test("canonical completion checks real completed calls; abort and original failures are not relabelled", () => {
  const normalizer = createSdkStreamNormalizer({ declaredTools: new Set(["SendToAgent"]), toolChoice: "required" });
  expect(() => normalizer.next({ type: "finish", finishReason: "stop" })).toThrow();
  const open = createSdkStreamNormalizer({ declaredTools: new Set(["SendToAgent"]), toolChoice: "required" });
  open.next({ type: "tool-input-start", id: "open", toolName: "SendToAgent" });
  let unfinished: unknown;
  try { open.next({ type: "finish", finishReason: "stop" }); } catch (error) { unfinished = error; }
  expect(streamFailureDiagnostic(unfinished)?.normalizeCause).toBe("open_tools_at_finish");
  const cancelled = createSdkStreamNormalizer({ toolChoice: "required" });
  cancelled.next({ type: "abort" }); expect(cancelled.finish().finishReason).toBe("abort");
  const error = createSdkStreamNormalizer({ toolChoice: "required" });
  error.next({ type: "finish", finishReason: "error" }); expect(error.finish().finishReason).toBe("error");
  const valid = createSdkStreamNormalizer({ declaredTools: new Set(["SendToAgent"]), toolChoice: { type: "tool", toolName: "SendToAgent" } });
  valid.next({ type: "tool-input-start", id: "c", toolName: "SendToAgent" });
  valid.next({ type: "tool-call", toolCallId: "c", toolName: "SendToAgent", input: "{}" });
  valid.next({ type: "finish", finishReason: "tool-calls" }); expect(valid.finish().finishReason).toBe("stop");
});

test("choice is not a parallel tool quota or a fuzzy alias mechanism", () => {
  expect(toolChoiceViolation("required", { completedCalls: 12 }, "host_terminal")).toBeUndefined();
  expect(toolChoiceViolation({ type: "tool", toolName: "SendToAgent" }, { toolName: "sendtoagent" }, "sdk_tool")).toMatchObject({ toolChoice: { reason: "different_tool" } });
  expect(toolChoiceViolation("auto", { toolName: "anything" }, "sdk_tool")).toBeUndefined(); // exact declaration has its own guard
});
