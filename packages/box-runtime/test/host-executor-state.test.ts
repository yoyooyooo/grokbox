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

  test("content index accessors and pooled Array species cannot alias executor windows", () => {
    const { session: host } = session();
    let reads = 0;
    const indexed = [{ type: "text", text: "placeholder" }];
    Object.defineProperty(indexed, 0, { enumerable: true, configurable: true, get() { reads += 1; return { type: "text", text: "secret" }; } });
    const fromAccessor = host.getExecutor([{ role: "user", content: indexed }]);
    expect(reads).toBe(0);
    expect(() => fromAccessor.getState()).toThrow(InvalidHostStateError);

    const pool: unknown[] = [];
    const parts = [{ type: "text", text: "first" }];
    Object.defineProperty(parts, "constructor", {
      value: { [Symbol.species]: function Species(this: unknown[]) { return pool; } },
    });
    const a = host.getExecutor([{ role: "user", content: parts }]);
    parts[0]!.text = "second";
    const b = host.getExecutor([{ role: "user", content: parts }]);
    expect(a).not.toBe(b);
    expect((a.getState() as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text).toBe("first");
    expect((b.getState() as Array<{ content: Array<{ text: string }> }>)[0]!.content[0]!.text).toBe("second");
  });

  test("unsupported or inherited roots are not successful empty windows", () => {
    const { session: host, calls } = session();
    expect(host.getExecutor({}).getState()).toEqual([]);
    expect(host.getExecutor({ messages: [] }).getState()).toEqual([]);

    class Hidden {
      #window = [{ role: "user", content: "hidden" }];
    }
    const inherited = Object.create({ messages: [{ role: "user", content: "inherited" }] });
    const wrongType = {};
    Object.defineProperty(wrongType, "messages", { enumerable: false, value: "not-an-array" });
    for (const root of [new Hidden(), inherited, new Map([["messages", [{ role: "user", content: "map" }]]]), wrongType]) {
      const executor = host.getExecutor(root);
      expect(() => executor.getState()).toThrow(InvalidHostStateError);
      expect(() => JSON.stringify(executor.getMessages())).toThrow();
    }
    expect(calls()).toBe(0);
  });

  test("legacy toolCalls aliases are assistant-only and must agree with content", () => {
    const { session: host } = session();
    const equal = host.getExecutor([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", args: { q: 1 } }],
      toolCalls: [{ id: "c", name: "lookup", args: { q: 1 } }],
    }]);
    expect(equal.getState()).toEqual([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", args: { q: 1 } }],
      toolCalls: [{ id: "c", name: "lookup", args: { q: 1 } }],
    }]);
    expect(JSON.stringify(equal.getState())).toContain("lookup");

    const userAlias = host.getExecutor([{
      role: "user", content: "bad-tool-role",
      toolCalls: [{ id: "c", name: "lookup", args: {} }],
    }]);
    expect(() => userAlias.getState()).toThrow(InvalidHostStateError);
    const conflict = host.getExecutor([{
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c", toolName: "lookup", args: { q: 1 } }],
      toolCalls: [{ id: "c", name: "lookup", args: { q: 2 } }],
    }]);
    expect(() => conflict.getMessages()).toThrow(EnvelopeError);
    expect(() => JSON.stringify(conflict.getState())).toThrow();
  });

  test("stream/tool errors do not poison an already valid window", async () => {
    const { session: host } = session();
    const executor = host.getExecutor([{ role: "user", content: "keep" }]);
    await expect(executor.stream({}, "step-tools", [{ name: "lookup", get inputSchema() { return { type: "object" }; } }]).response)
      .rejects.toMatchObject({ name: "RetriableError" });
    expect(executor.getState()).toEqual([{ role: "user", content: "keep" }]);
  });

  test("supported optional fields may be undefined in memory and after JSON roundtrip", () => {
    const { session: host } = session();
    const input = [{
      role: "assistant" as const,
      id: undefined,
      content: [
        { type: "text" as const, text: "note", providerOptions: undefined },
        { type: "tool-call" as const, toolCallId: "c", toolName: "lookup", args: {} },
      ],
      providerOptions: undefined,
      isSummary: undefined,
    }, {
      role: "user" as const,
      content: [{ type: "image" as const, data: "AAAA", mimeType: undefined }],
    }, {
      role: "tool" as const,
      content: [{ type: "tool-result" as const, toolCallId: "c", result: { ok: true }, isError: undefined }],
    }];
    const live = host.getExecutor(input);
    const restored = host.getExecutor(JSON.parse(JSON.stringify(input)) as unknown);
    expect(live.getState()).toEqual(restored.getState());
    expect((live.getState() as Array<{ id?: string }>)[0]!.id).toBeUndefined();
    expect(() => host.getExecutor([{ role: "user", get content() { return "x"; } }]).getState()).toThrow(EnvelopeError);
    expect(() => host.getExecutor([{ role: "user", content: "x", isSummary: "yes" }]).getState()).toThrow(EnvelopeError);
  });

  test("providerOptions prototype check does not execute constructor name getters", async () => {
    const { session: host, requests } = session();
    let reads = 0;
    const proto = Object.create(null);
    Object.defineProperty(proto, "constructor", {
      value: { get name() { reads += 1; return "Object"; } },
    });
    const spoofed = Object.assign(Object.create(proto), { cursor: { isSummary: true } });
    const refused = host.getExecutor([{ role: "user", content: "x", providerOptions: spoofed }]);
    expect(reads).toBe(0);
    expect(() => refused.getState()).toThrow(InvalidHostStateError);

    const ok = host.getExecutor([{
      role: "user",
      content: "x",
      providerOptions: { cursor: { isSummary: true } },
    }]);
    expect(ok.getState()).toEqual([{ role: "user", content: "x", providerOptions: { cursor: { isSummary: true } } }]);
    const nullProto = Object.assign(Object.create(null), { cursor: { inferenceReason: "main" } });
    expect(host.getExecutor([{ role: "user", content: "y", providerOptions: nullProto }]).getState())
      .toEqual([{ role: "user", content: "y", providerOptions: { cursor: { inferenceReason: "main" } } }]);
    await ok.stream({}, "step-options").response;
    expect(JSON.stringify(requests.at(-1)!.messages)).not.toContain("isSummary");
  });
});
