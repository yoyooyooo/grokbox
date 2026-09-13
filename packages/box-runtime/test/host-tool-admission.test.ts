import { expect, test } from "bun:test";
import { buildHostEnvelope } from "../src/internal/host/context-codec.ts";
import { createStreamingPromptSession, type SessionTerminal } from "../src/internal/host/session.ts";
import { projectHostNormalizedTerminal, projectHostStreamRejected } from "../src/internal/host/terminal-journal.node.ts";

for (const requested of [undefined, true, false]) {
  test(`serial Host advertises single-tool policy before producer starts (requested=${requested})`, async () => {
    const envelope = buildHostEnvelope([{ role: "user", content: "test" }], [], requested === undefined ? {} : { parallelToolCalls: requested });
    const session = createStreamingPromptSession({ modelId: "test", vision: false, parallel: "fail-closed",
      produce: async function* (request) {
        expect(request.envelope.options.parallelToolCalls).toBe(false);
        yield { type: "text-delta", textDelta: "completed" };
        yield { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      },
    });
    await session.stream({ envelope }).response;
    expect(envelope.options.parallelToolCalls).toBe(requested);
  });
}

test("provider violating serial contract cannot release either completed tool", async () => {
  const tools = [{ name: "probe", inputSchema: { type: "object", properties: {} } }];
  const terminal: SessionTerminal[] = [];
  const session = createStreamingPromptSession({ modelId: "test", vision: false, parallel: "fail-closed",
    onTerminal: t => terminal.push(t),
    produce: async function* () {
      yield { type: "tool-call", toolCallId: "one", toolName: "probe", args: {} };
      yield { type: "tool-call", toolCallId: "two", toolName: "probe", args: {} };
    },
  });
  const handle = session.stream({ invocationId: "step", envelope: buildHostEnvelope([{ role: "user", content: "test" }], tools) });
  const parts = [];
  for await (const part of handle.fullStream) parts.push(part);
  await expect(handle.response).rejects.toMatchObject({ code: "parallel_tools" });
  expect(parts.filter(p => p.type === "tool-call")).toHaveLength(0);
  expect(terminal).toEqual([{ terminalClass: "error", toolCallCount: 0, invocationId: "step", rejected: true, errorCode: "parallel_tools", stage: "normalize" }]);
});

test("Host terminal projection persists actual failure instead of masking it as a normal terminal", () => {
  const event = { name: "host_normalized_terminal", at: "2026-09-12T07:23:25Z", agentId: "agent", turnId: "turn", stepId: "step", terminalClass: "error", errorCode: "parallel_tools", toolCallCount: 0, modelId: "openai-responses/grok-4.6", rawDetail: "PRIVATE_SENTINEL" };
  expect(projectHostNormalizedTerminal(event)).toMatchObject({ terminalClass: "error", errorCode: "parallel_tools", toolCallCount: 0 });
  expect(JSON.stringify(projectHostNormalizedTerminal(event))).not.toContain("PRIVATE_SENTINEL");
  expect(projectHostNormalizedTerminal({ ...event, terminalClass: "stop" })).toBeNull();
  expect(projectHostStreamRejected({ name: "host_stream_rejected", schemaVersion: 2, at: event.at, mode: "route", agentId: "agent", turnId: "turn", stepId: "step", stage: "normalize", errorCode: "parallel_tools", reason: "terminal-rejected" })).toMatchObject({ stepId: "step", errorCode: "parallel_tools" });
});
