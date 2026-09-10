import { describe, expect, test } from "bun:test";
import { EnvelopeError } from "@grokbox/runtime-kernel/contract";
import { asHostPromptSession, createStreamingPromptSession, InvalidHostStateError, type StreamPart } from "../src/internal/host/session.ts";

const FINISH: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
const echo = async function* () {
  yield { type: "text-delta" as const, textDelta: "ok" };
  yield FINISH;
};

function session(onRequestId?: (id: string) => void) {
  let calls = 0;
  const requests: Array<{ messages: unknown }> = [];
  return {
    calls: () => calls,
    requests,
    session: asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "allow",
      providerCalls: { get count() { return calls; }, set count(value) { calls = value; } },
      produce: (request) => {
        requests.push({ messages: request.envelope.messages });
        return echo();
      },
    }), "stub/echo", onRequestId),
  };
}

const window = [
  {
    role: "system" as const,
    id: "sys-1",
    content: "root-once",
    providerOptions: { cursor: { inferenceReason: "system" } },
  },
  {
    role: "user" as const,
    id: "u-1",
    isSummary: true,
    content: [{ type: "text" as const, text: "summarized-intent", providerOptions: { cursor: { userInfoSummarizationEpoch: 3 } } }],
    providerOptions: { cursor: { isSummary: true, userInfoSummarizationEpoch: 3 } },
  },
  {
    role: "assistant" as const,
    id: "a-1",
    content: [{ type: "tool-call" as const, toolCallId: "call-1", toolName: "lookup", args: { q: "seed" } }],
  },
  {
    role: "user" as const,
    id: "tr-1",
    content: [{ type: "tool-result" as const, toolCallId: "call-1", toolName: "lookup", result: { rows: [1] }, isError: false }],
  },
];

describe("F1 executor factory isolation and Host metadata", () => {
  test("each getExecutor/untracked accessor is a fresh window; parameterless starts empty", () => {
    const { session: host } = session();
    const main = host.getExecutor(window);
    const empty = host.getExecutor();
    const untracked = host.getExecutorWithoutResolvedModelTracking(window);
    expect(main).not.toBe(empty);
    expect(main).not.toBe(untracked);
    expect(untracked).not.toBe(host.getExecutorWithoutResolvedModelTracking(window));
    expect(empty.getState()).toEqual([]);
    empty.appendMessages([{ role: "user", content: "aux-only" }]);
    expect(empty.getMessages()).toEqual([{ role: "user", content: "aux-only" }]);
    expect(main.getState()).toEqual(window);
    const copy = main.getMessages() as Array<{ content: unknown }>;
    copy[0]!.content = "mutated-copy";
    copy.push({ content: "alias" });
    expect(main.getMessages()).toEqual(window);
  });

  test("bind/append/clear stay on one executor and do not rewrite sibling factories", () => {
    const { session: host } = session();
    const keep = host.getExecutor(window);
    const other = host.getExecutor([{ role: "user", content: "other-start" }]);
    other.appendMessages([{ role: "assistant", content: "other-more" }]);
    other.clearMessages();
    other.appendMessages([{ role: "user", content: "other-rebuilt" }]);
    expect(keep.getState()).toEqual(window);
    expect(other.getState()).toEqual([{ role: "user", content: "other-rebuilt" }]);
  });

  test("provider envelope still drops Host control metadata", async () => {
    const { session: host, requests } = session();
    const executor = host.getExecutor(window);
    await executor.stream({}, "step-meta").response;
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("sys-1");
    expect(JSON.stringify(requests[0]!.messages)).not.toContain("userInfoSummarizationEpoch");
    expect(executor.getState()).toEqual(window);
  });
});

describe("F2 invalid windows are not checkpoint-serializable", () => {
  test("failed bind does not expose [] and leaves a valid sibling unchanged", () => {
    const { session: host, calls } = session();
    const keep = host.getExecutor(window);
    const bad = host.getExecutor({
      messages: [
        { role: "user", content: "keep-me" },
        { role: "user", content: [{ type: "file", url: "private-file" }] },
      ],
    });
    expect(() => bad.getState()).toThrow(InvalidHostStateError);
    expect(() => bad.getMessages()).toThrow(EnvelopeError);
    expect(() => JSON.stringify(bad.getState())).toThrow();
    expect(keep.getState()).toEqual(window);
    expect(calls()).toBe(0);
  });

  test("append batch is atomic; getters throw until Host clear plus a full legal window", () => {
    const { session: host } = session();
    const executor = host.getExecutor([{ role: "user", content: "legal-start" }]);
    executor.appendMessages([
      { role: "assistant", content: "legal-mid" },
      { role: "user", content: [{ type: "file", url: "private-tail" }] },
    ]);
    expect(() => executor.getState()).toThrow(InvalidHostStateError);
    expect(() => executor.getMessages()).toThrow(InvalidHostStateError);
    executor.appendMessages([{ role: "user", content: "ignored-while-invalid" }]);
    expect(() => executor.getState()).toThrow(InvalidHostStateError);
    executor.clearMessages();
    expect(executor.getState()).toEqual([]);
    executor.appendMessages(window);
    expect(executor.getState()).toEqual(window);
  });

  test("invalid executor refuses provider effect; accessors are not executed", async () => {
    let reads = 0;
    const { session: host, calls } = session();
    const hot = [{
      role: "user",
      get content() { reads += 1; return "private-getter"; },
    }];
    const executor = host.getExecutor(hot);
    expect(reads).toBe(0);
    expect(() => executor.getState()).toThrow(EnvelopeError);
    await expect(executor.stream({}, "step-invalid").response).rejects.toMatchObject({ name: "RetriableError" });
    expect(calls()).toBe(0);
    expect(reads).toBe(0);
  });
});
