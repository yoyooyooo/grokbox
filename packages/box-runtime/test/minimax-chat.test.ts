import { expect, test } from "bun:test";
import { Effect, Layer, Stream } from "effect";
import { ModelBackend, BackendAuth } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, streamFailureDiagnostic, type ContextSnapshot, type InferenceEvent, type PromptMessage } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { computeSelectionRevision, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeBackendAuthLayer, unsealFakeAuth } from "@grokbox/runtime-kernel/testing";
import { aiSdkModelBackendLayer } from "../src/internal/backends/ai-sdk.ts";
import { chatDialect, InlineThinkingParts } from "../src/internal/backends/chat-dialect.ts";

const record = { id: "fixture/model", provider: "openai-chat", model: "fixture", endpoint: "https://offline.invalid/v1", apiKeyRef: "env:FIXTURE", capabilities: { vision: true, tools: true, images: true }, dataTypes: ["text", "images", "tools"], chatDialect: "minimax-inline-v1" as const };
const chunk = (delta: unknown, finish_reason: string | null = "") => ({ choices: [{ index: 0, delta, finish_reason }] });
const start = (name = "lookup", type = "function") => chunk({ tool_calls: [{ index: 0, id: "fixture-call", type, function: { name, arguments: "" } }] });
const continuation = (arguments_: string, type: string | undefined = "") => chunk({ tool_calls: [{ index: 0, id: "", ...(type !== undefined ? { type } : {}), function: { name: "", arguments: arguments_ } }] });
const end = () => ({ ...chunk({}, "tool_calls"), usage: { prompt_tokens: 4, completion_tokens: 3 } });
function snapshot(messages: PromptMessage[] = [{ role: "user", content: "fixture" }]): ContextSnapshot {
  const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "host-abi-v1", systemMessages: [{ role: "system", content: "fixture system" }], messages,
    tools: [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }], options: {} });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}
async function run(frames: unknown[], options: { standard?: boolean; bytewise?: boolean; multiline?: boolean; messages?: PromptMessage[] } = {}) {
  let requests = 0, body: Record<string, unknown> = {};
  const bytes = new TextEncoder().encode(frames.map(f => JSON.stringify(f, null, options.multiline ? 2 : undefined)
    .split("\n").map(line => `data: ${line}`).join("\r\n") + "\r\n\r\n").join("") + "data: [DONE]\r\n\r\n");
  const fake = Object.assign(async (_input: unknown, init?: RequestInit) => {
    requests++; body = JSON.parse(String(init?.body)); let offset = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      const size = options.bytewise ? 1 : bytes.length;
      controller.enqueue(bytes.slice(offset, offset + size)); offset += size;
    } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream", "content-length": String(bytes.length) } });
  }, { preconnect: async () => undefined }) as typeof fetch;
  const graph = Layer.mergeAll(fakeBackendAuthLayer("fixture-secret"), aiSdkModelBackendLayer(fake, unsealFakeAuth));
  const events: InferenceEvent[] = []; let failure: unknown;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const backend = yield* ModelBackend, auth = yield* BackendAuth;
    const pinned = yield* auth.pin({ apiKeyRef: record.apiKeyRef });
    const prepared = yield* backend.prepare({ ...record, ...(options.standard ? { chatDialect: "standard" } : {}) }, snapshot(options.messages));
    yield* Stream.runForEach(backend.infer({}, prepared, pinned.lease), event => Effect.sync(() => { events.push(event); })).pipe(Effect.catch(error => Effect.sync(() => { failure = error; })));
  }).pipe(Effect.provide(graph))));
  return { events, failure, diagnostic: streamFailureDiagnostic(failure), requests, body };
}

test("MiniMax continuation placeholders pass through the production backend without changing arguments", async () => {
  const r = await run([chunk({ content: "<think>合成思考</think>Answer" }), start(), continuation('{"q":"汉字"}'), end(), chunk({})], { bytewise: true });
  expect(r.failure).toBeUndefined(); expect(r.requests).toBe(1); expect(r.body.reasoning_split).toBe(false);
  expect(r.events.filter(e => e.type === "reasoning_delta").map(e => e.text).join("")).toBe("<think>合成思考</think>");
  expect(r.events.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe("Answer");
  expect(r.events.find(e => e.type === "tool_complete")).toMatchObject({ toolName: "lookup", args: { q: "汉字" } });
  const finish = r.events.find(e => e.type === "backend_finish");
  expect(finish).toMatchObject({ finishReason: "stop", stream: { counts: { normalizedEmptyToolTypes: 1 }, providerFinishReason: "other", sdkFinishReason: "tool-calls", engine: { chatDialect: "minimax-inline-v1", adapterRevision: 4 } } });
  expect(finish?.type === "backend_finish" && finish.stream?.toolIdentity?.firstMismatch).toBeUndefined();
});

test("MiniMax reframing preserves multiline SSE data, including unchanged frames and bytewise UTF-8", async () => {
  const r = await run([chunk({ content: "<think>合成思考</think>Answer" }, null), start(), continuation('{"q":"汉字"}'), end()], { multiline: true, bytewise: true });
  expect(r.failure).toBeUndefined();
  expect(r.events.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe("Answer");
  expect(r.events.filter(e => e.type === "reasoning_delta").map(e => e.text).join("")).toBe("<think>合成思考</think>");
  expect(r.events.find(e => e.type === "tool_complete")).toMatchObject({ toolName: "lookup", args: { q: "汉字" } });
  expect(r.events.filter(e => e.type === "backend_finish")).toHaveLength(1);
  expect(r.requests).toBe(1);
});

test("standard Chat never silently adopts MiniMax semantics", async () => {
  const r = await run([start(), continuation('{"q":"x"}'), end()], { standard: true });
  expect(r.diagnostic).toMatchObject({ normalizeCause: "sdk_schema_mismatch", sdkValidation: { kind: "schema" } });
  expect(r.events.some(e => e.type === "backend_finish")).toBe(false); expect(r.body.reasoning_split).toBeUndefined();
});
for (const [label, frames, cause] of [
  ["first empty type", [start("lookup", ""), continuation('{"q":"x"}'), end()], "sdk_schema_mismatch"],
  ["unknown tool", [start("unknown"), continuation('{"q":"x"}'), end()], "undeclared_tool"],
  ["split tool name", [start("look"), continuation('{"q":"x"}'), end()], "undeclared_tool"],
  ["nonempty invalid type", [start(), continuation('{"q":"x"}', "custom"), end()], "sdk_schema_mismatch"],
  ["incomplete arguments", [start(), continuation('{"q":"x'), end()], "tool_arguments_invalid"],
  ["missing real finish", [chunk({ content: "partial" }), chunk({})], "missing_finish"],
  ["trailing arguments after parseable prefix", [start(), continuation('{"q":"x"}'), continuation("garbage"), end()], "tool_arguments_invalid"],
  ["changed name", [start(), chunk({ tool_calls: [{ index: 0, function: { name: "other", arguments: "{}" } }] }), end()], "tool_identity_conflict"],
  ["conflicting finish", [chunk({ content: "answer" }, "stop"), end()], "conflicting_finish_reason"],
  ["unknown finish", [chunk({ content: "answer" }, "new_reason")], "unsupported_finish_reason"],
  ["unsupported split state", [chunk({ reasoning_details: [{ text: "hidden" }] }), chunk({ content: "answer" }, "stop")], "unsupported_provider_state"],
  ["unterminated reasoning", [chunk({ content: "<think>hidden" }), chunk({}, "stop")], "unterminated_reasoning"],
] as const) {
  test(`${label} remains rejected without successful terminal or extra HTTP`, async () => {
    const r = await run([...frames]); expect(r.diagnostic?.normalizeCause).toBe(cause); expect(r.requests).toBe(1);
    expect(r.events.some(e => e.type === "backend_finish")).toBe(false);
  });
}

test("inline reasoning and assistant text roundtrip in original order, including image input", async () => {
  const content = [{ type: "reasoning" as const, text: "<think>private fixture reasoning</think>" }, { type: "text" as const, text: "Answer" },
    { type: "tool-call" as const, toolCallId: "old", toolName: "lookup", args: { q: "one" } }];
  const r = await run([chunk({ content: "done" }, "stop")], { messages: [
    { role: "user", content: [{ type: "text", text: "image fixture" }, { type: "image", url: "https://example.invalid/image.png", mimeType: "image/png" }] },
    { role: "assistant", content }, { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "lookup", result: { ok: true } }] },
  ] });
  expect(r.failure).toBeUndefined();
  const messages = r.body.messages as Array<Record<string, unknown>>;
  expect(messages.find(m => m.role === "assistant")?.content).toBe("<think>private fixture reasoning</think>Answer");
  expect(JSON.stringify(messages)).toContain("image_url");
});
test("inline parser handles every marker split without losing or duplicating content", () => {
  const raw = "<think>abc中文</think>done";
  for (let split = 0; split <= raw.length; split++) {
    const parser = new InlineThinkingParts();
    const parts = [...parser.map({ type: "text-delta", delta: raw.slice(0, split) }), ...parser.map({ type: "text-delta", delta: raw.slice(split) })] as Array<{ type: string; delta: string }>;
    expect(parts.map(p => p.delta).join("")).toBe(raw);
    expect(parts.filter(p => p.type === "text-delta").map(p => p.delta).join("")).toBe("done");
  }
});
test("dialect selection is origin-qualified, configurable, and binding-revision relevant", () => {
  expect(chatDialect({ endpoint: "https://api.minimaxi.com/v1", provider: "openai-chat" })).toBe("minimax-inline-v1");
  for (const endpoint of ["http://api.minimaxi.com/v1", "https://api.minimaxi.com.evil.invalid/v1", "https://api.minimaxi.com/other", "https://api.minimaxi.com:444/v1"]) expect(chatDialect({ endpoint, provider: "openai-chat" })).toBe("standard");
  expect(chatDialect({ endpoint: "https://api.minimax.io/v1", provider: "openai-chat", chatDialect: "standard" })).toBe("standard");
  const file = parseModelsFile({ version: 3, models: { [record.id]: record } });
  expect(file.models[record.id]?.chatDialect).toBe("minimax-inline-v1");
  expect(computeSelectionRevision({ agentId: "fixture", model: record })).not.toBe(computeSelectionRevision({ agentId: "fixture", model: { ...record, chatDialect: "standard" } }));
  expect(() => parseModelsFile({ version: 3, models: { [record.id]: { ...record, chatDialect: "unknown" } } })).toThrow();
  expect(() => parseModelsFile({ version: 3, models: { [record.id]: { ...record, provider: "openai-responses" } } })).toThrow();
  expect(() => parseModelsFile({ version: 3, models: { "stub/echo": { chatDialect: "minimax-inline-v1" } } })).toThrow();
});
