import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { BackendAuth, ModelBackend } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, type PromptMessage, type GenerationOptions } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { assertIndependentGoldenInHttp, type HostWindowMessage } from "./context-continuity-fixture.ts";

const tool = { name: "lookup", description: "owned schema", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
const sse = (rows: unknown[]) => new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
function answer(api: "chat" | "responses") {
  if (api === "chat") return sse([
    { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
  ]);
  const response = { id: "resp-owned", model: "synthetic", object: "response", created_at: 1 };
  return sse([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "m", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_text.done", item_id: "m", output_index: 0, content_index: 0, text: "ok" },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
    { type: "response.completed", response: { ...response, status: "completed", output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]);
}
async function capture(api: "chat" | "responses", messages: PromptMessage[], options: GenerationOptions = {}) {
  let http = 0, captured: Record<string, unknown> | undefined;
  const fetch = Object.assign(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    http++; captured = JSON.parse(String(init?.body)); return answer(api);
  }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1", systemMessages: [{ role: "system", content: "owned-root-once" }], messages, tools: [tool], options });
  const events = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* BackendAuth, backend = yield* ModelBackend;
    const pin = yield* auth.pin({ apiKeyRef: "env:OPENAI_API_KEY" });
    const prepared = yield* backend.prepare({ id: "synthetic/model", provider: api === "chat" ? "openai-chat" : "openai-responses", model: "synthetic", endpoint: "https://owned.invalid/v1", apiKeyRef: "env:OPENAI_API_KEY", contextWindowTokens: 200000, capabilities: { tools: true, vision: true, images: true } }, { ...body, snapshotDigest: computeSnapshotDigest(body) });
    return yield* Stream.runCollect(backend.infer({}, prepared, pin.lease));
  }).pipe(Effect.provide(testSdkBackendLayer({ fetch, env: { OPENAI_API_KEY: "synthetic-only" } })))));
  expect(http).toBe(1); expect(events.some(e => e.type === "backend_finish")).toBe(true);
  return captured!;
}
const calls: PromptMessage = { role: "assistant", content: [
  { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "first" } },
  { type: "tool-call", toolCallId: "c2", toolName: "lookup", args: { q: "second" } },
] };
const r1 = { type: "tool-result" as const, toolCallId: "c1", toolName: "lookup", result: { rows: [0, false, "中文"] } };
const r2 = { type: "tool-result" as const, toolCallId: "c2", toolName: "lookup", result: { rows: [2] } };
for (const api of ["chat", "responses"] as const) {
  for (const [label, parts] of [
    ["result then user instruction", [r1, { type: "text" as const, text: "after-result" }, r2]],
    ["text result text result", [{ type: "text" as const, text: "before" }, r1, { type: "text" as const, text: "between" }, r2]],
  ] as const) {
    test(`production ${api}: ${label} is order-preserving in actual HTTP`, async () => {
      const messages: PromptMessage[] = [{ role: "user", content: "question" }, calls, { role: "user", content: [...parts] }];
      const body = await capture(api, messages, { temperature: 0.2, topP: 0.7, maxTokens: 32, parallelToolCalls: false, toolChoice: "none" });
      assertIndependentGoldenInHttp(body, messages as HostWindowMessage[], "owned-root-once");
      expect(body.parallel_tool_calls).toBe(false); expect(body.tool_choice).toBe("none");
      expect(body.temperature).toBe(0.2); expect(body.top_p).toBe(0.7);
      expect(body[api === "chat" ? "max_tokens" : "max_output_tokens"]).toBe(32);
      expect(JSON.stringify(body.tools)).toContain("owned schema");
      expect(JSON.stringify(body.tools)).toContain('"q"');
      const mutated = structuredClone(body);
      const key = Array.isArray(mutated.messages) ? "messages" : "input";
      (mutated[key] as unknown[]).reverse();
      expect(() => assertIndependentGoldenInHttp(mutated, messages as HostWindowMessage[], "owned-root-once")).toThrow();
    });
  }
  test(`production ${api}: images and plain reasoning use the same qualified projection`, async () => {
    const image = "data:image/png;base64,iVBORw0KGgo=";
    const body = await capture(api, [
      { role: "user", content: [{ type: "text", text: "image-label" }, { type: "image", data: image, mimeType: "image/png" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "reason-history" }, { type: "text", text: "answer-history" }] },
      { role: "user", content: "next-question" },
    ]);
    const json = JSON.stringify(body);
    expect(json).toContain(image); expect(json).toContain("reason-history"); expect(json).toContain("answer-history");
    expect(json).not.toContain('"itemId"'); expect(json).not.toContain('"encrypted_content"');
    const bare = await capture(api, [{ role: "user", content: [{ type: "image", data: image.split(",")[1]!, mimeType: "image/png" }] }]);
    expect(JSON.stringify(bare)).toContain(image);
  });
}
