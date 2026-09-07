import { describe, expect, test } from "bun:test";
import { buildModelEnvelope, ENVELOPE_MAX_BYTES, type ModelEnvelope, type PromptMessage } from "../src/envelope.ts";
import { asHostPromptSession, createStreamingPromptSession, type StreamPart } from "../src/session.ts";
import { collectStreamParts, hasMeaningfulResponseMessageContent } from "./host-consumer.ts";

const FINISH: StreamPart = { type: "finish", reason: "stop", usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 } };
const history = (): PromptMessage[] => [
  { role: "system", content: "system-sentinel" },
  { role: "user", content: [{ type: "text", text: "user-sentinel" }] },
  { role: "assistant", content: [
    { type: "reasoning", text: "reasoning-sentinel" },
    { type: "tool-call", toolCallId: "call:one/α", toolName: "lookup", args: { query: "history-sentinel" } },
  ] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call:one/α", toolName: "lookup", result: { rows: [1, "result-sentinel"] }, isError: false }] },
];
const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };

function fixture(vision = false) {
  const requests: Array<{ envelope: ModelEnvelope; invocationId?: string; abortSignal: AbortSignal }> = [];
  const calls = { count: 0 };
  const session = asHostPromptSession(createStreamingPromptSession({ modelId: "fake/envelope", vision, parallel: "allow", providerCalls: calls,
    produce: (request) => {
      requests.push(request);
      return { async *[Symbol.asyncIterator]() { yield { type: "text-delta" as const, textDelta: "accepted" }; yield FINISH; } };
    },
  }), "fake/envelope");
  return { session, requests, calls };
}

describe("Host messages/state/tools/options envelope", () => {
  test("text, system, history, tool schema/result/id and options reach a detached, provider-neutral boundary", async () => {
    const f = fixture();
    const state = history();
    const before = structuredClone(state);
    const executor = f.session.getExecutor({ messages: state });
    state[0]!.content = "mutated after bind";
    let executions = 0;
    const parameters = { jsonSchema: structuredClone(schema) };
    const options = { temperature: 0.2, topP: 0.9, maxTokens: 123, seed: 7, stopSequences: ["stop-sentinel"],
      parallelToolCalls: false, toolChoice: { type: "tool", toolName: "lookup" } };
    const controller = new AbortController();
    const result = executor.stream({ signal: controller.signal, privateContext: "never-forward-context" }, "inv-envelope",
      [{ name: "lookup", description: "lookup schema", parameters, execute: () => { executions += 1; } }], options);
    expect(result).not.toBeInstanceOf(Promise);
    parameters.jsonSchema.properties.query.type = "number";
    options.stopSequences[0] = "mutated";
    (executor.getState()[0] as { content: unknown }).content = "mutated getter";
    expect(executor.getMessages()).toEqual(before);
    executor.clearMessages();
    const response = await result.response;
    expect(response.modelId.trim()).toBe("fake/envelope");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.envelope).toEqual({ version: 1, messages: before,
      tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
      options: { temperature: 0.2, topP: 0.9, maxTokens: 123, seed: 7, stopSequences: ["stop-sentinel"],
        parallelToolCalls: false, toolChoice: { type: "tool", toolName: "lookup" } },
    });
    expect(f.requests[0]!.invocationId).toBe("inv-envelope");
    expect(Object.isFrozen(f.requests[0]!.envelope.messages[0])).toBe(true);
    expect(Object.isFrozen(f.requests[0]!.envelope.tools[0]!.inputSchema)).toBe(true);
    expect(Object.isFrozen(f.requests[0]!.envelope.options)).toBe(true);
    expect(JSON.stringify(f.requests[0]!.envelope)).not.toContain("never-forward-context");
    expect(f.calls.count).toBe(1);
    expect(executions).toBe(0);
    expect(executor.getState()).toEqual([]); // no automatic response/Transcript writer
    const parts = await collectStreamParts(result.fullStream);
    expect(parts.at(-1)).toMatchObject({ type: "finish", response, usage: await result.usage });
    expect(await result.extendedUsage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(await result.providerMetadata).toEqual({});
    expect(await result.invocationId).toBe("inv-envelope");
  });

  test.each(["parameters", "inputSchema", "schema"])("%s tool wrappers normalize without executing Host tool implementations", (key) => {
    let called = 0;
    const tools = { lookup: { [key]: key === "parameters" ? { jsonSchema: schema } : schema,
      execute: () => { called += 1; } } };
    expect(buildModelEnvelope([], tools).tools).toEqual([{ name: "lookup", inputSchema: schema }]);
    expect(called).toBe(0);
  });

  test("legacy internal toolCalls and Host content blocks coalesce once, preserving ids verbatim", () => {
    const call = { type: "tool-call" as const, toolCallId: "call:one/α", toolName: "lookup", args: { query: "q" } };
    const envelope = buildModelEnvelope([
      { role: "assistant", content: [call], toolCalls: [{ id: call.toolCallId, name: call.toolName, args: call.args }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, result: "done" }] },
    ]);
    expect(envelope.messages[0]!.content).toEqual([call]);
    expect(envelope.messages[1]!.content).toEqual([{ type: "tool-result", toolCallId: "call:one/α", result: "done" }]);
  });

  test.each([
    ["unknown block", [{ role: "user", content: [{ type: "file", url: "private-file-sentinel" }] }]],
    ["opaque text", [{ role: "user", content: [{ type: "text", text: { value: "private-redacted-sentinel" } }] }]],
    ["hidden attachment", [{ role: "user", content: "hello", attachments: ["private-attachment"] }]],
    ["missing tool call", [{ role: "tool", content: [{ type: "tool-result", toolCallId: "missing", result: "private-result" }] }]],
    ["wrong tool result name", [...history().slice(0, 3), { role: "tool", content: [{ type: "tool-result", toolCallId: "call:one/α", toolName: "other", result: "private-result" }] }]],
    ["too large", [{ role: "user", content: "x".repeat(ENVELOPE_MAX_BYTES + 1) }]],
  ])("%s fails visibly before dispatch and never leaks input in its error", async (_name, messages) => {
    const f = fixture();
    const result = f.session.getExecutor(messages).stream({}, "inv-refused", [], {});
    const response = await result.response;
    expect(f.calls.count).toBe(0);
    expect(f.requests).toEqual([]);
    expect(response.error?.userVisible).toBe(true);
    expect(hasMeaningfulResponseMessageContent(response.messages)).toBe(true);
    expect(JSON.stringify(response)).not.toContain("private-");
    expect((await collectStreamParts(result.fullStream)).at(-1)).toMatchObject({ type: "finish", reason: "error", response });
  });

  test.each([
    ["non-object schema", [{ name: "lookup", inputSchema: { type: "array" } }], {}],
    ["opaque registry", new Map([["lookup", { schema }]]), {}],
    ["duplicate tool name", [{ name: "lookup", schema }, { name: "lookup", schema }], {}],
    ["unsupported options", [], { vendorCredential: "private-secret-sentinel" }],
    ["invalid number", [], { temperature: NaN }],
    ["invalid abort signal", [], { abortSignal: "not-a-signal" }],
    ["missing selected tool", [], { toolChoice: { type: "tool", toolName: "missing" } }],
  ])("%s is refused, not dropped", async (_name, tools, options) => {
    const f = fixture();
    const result = f.session.getExecutor([{ role: "user", content: "hello" }]).stream({}, "inv-options", tools, options);
    expect((await result.response).error?.userVisible).toBe(true);
    expect(f.calls.count).toBe(0);
  });

  test("schema accessors are refused without invoking Host code", async () => {
    const f = fixture();
    let reads = 0;
    const tool = { name: "lookup", get inputSchema() { reads += 1; return schema; } };
    const response = await f.session.getExecutor([]).stream({}, "inv-schema-accessor", [tool]).response;
    expect(response.error?.code).toBe("invalid_tools");
    expect(reads).toBe(0);
    expect(f.calls.count).toBe(0);
  });

  test("unsupported image is meaningful to the Host; vision preserves data without fetching it", async () => {
    const image = { type: "image" as const, data: "synthetic-image-data", mimeType: "image/png" };
    const f = fixture();
    const failed = f.session.getExecutor([{ role: "user", content: [image] }]).stream({}, "inv-image");
    expect((await failed.response).error?.code).toBe("unsupported_image");
    expect(hasMeaningfulResponseMessageContent((await failed.response).messages)).toBe(true);
    expect(f.calls.count).toBe(0);
    const vision = fixture(true);
    await vision.session.getExecutor([{ role: "user", content: [image] }]).stream({}, "inv-vision").response;
    expect(vision.calls.count).toBe(1);
    expect(vision.requests[0]!.envelope.messages[0]!.content).toEqual([image]);
  });

  test("state array accessors are not executed and sparse history is not silently dropped", async () => {
    for (const accessor of [true, false]) {
      const f = fixture();
      let reads = 0;
      const state = new Array(1);
      if (accessor) Object.defineProperty(state, "0", { enumerable: true, get: () => { reads += 1; return { role: "user", content: "private-getter" }; } });
      const response = await f.session.getExecutor(state).stream().response;
      expect(reads).toBe(0);
      expect(f.calls.count).toBe(0);
      expect(response.error?.userVisible).toBe(true);
    }
  });

  test("invalid state still gives an Array state and a synchronous visible failure", async () => {
    const f = fixture();
    const executor = f.session.getExecutor({ transcript: "private-state" });
    expect(executor.getState()).toEqual([]);
    const handle = executor.stream({}, "inv-state");
    expect(handle).not.toBeInstanceOf(Promise);
    expect((await handle.response).error?.userVisible).toBe(true);
    expect(f.calls.count).toBe(0);
  });
});
