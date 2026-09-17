import { contextSnapshotBody, type ContextSnapshot } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import type { ModelRecord } from "@grokbox/runtime-kernel/selection";
export function reasoningModel(api: "chat" | "responses" = "responses", model = "grok-4.6"): ModelRecord {
  return { id: `fixture/${model}`, provider: api === "responses" ? "openai-responses" : "openai-chat", model,
    endpoint: "https://reasoning.invalid/v1", apiKeyRef: "env:FIXTURE_KEY", contextWindowTokens: 200000,
    capabilities: { vision: false, tools: true, images: false, reasoning: { efforts: ["none", "low", "medium", "high", "xhigh"] } }, dataTypes: ["text", "tools"] };
}
export function reasoningSnapshot(options: ContextSnapshot["options"] = {}): ContextSnapshot {
  const body = contextSnapshotBody({ version: 1, profileId: "t21-independent-root", abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }], messages: [{ role: "user", content: "local fixture" }], tools: [], options });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}
export function reasoningResponse(api: "chat" | "responses", reasoningTokens: number | undefined = 12): Response {
  const details = reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens };
  const common = { id: "resp-reasoning", model: "grok-4.6", object: "response", created_at: 1 };
  const item = { type: "message", id: "msg-1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  const rows = api === "chat" ? [
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
    { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: details } },
  ] : [
    { type: "response.created", response: { ...common, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "ok" },
    { type: "response.output_text.done", item_id: "msg-1", output_index: 0, content_index: 0, text: "ok" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...common, status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: details } } },
  ];
  return new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + (api === "chat" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}
