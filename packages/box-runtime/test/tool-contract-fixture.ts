import type { ToolDefinition } from "@grokbox/runtime-kernel/contract";

/** Synthetic contracts, not copied native tools or proof of native execution. */
export const agentTool: ToolDefinition = { name: "SendToAgent", inputSchema: {
  type: "object", properties: { target_id: { type: "string" }, message: { type: "string" } },
  required: ["target_id", "message"], additionalProperties: false,
} };
export const contractTools: ToolDefinition[] = [agentTool, { name: "OtherTool", inputSchema: { type: "object" } },
  { name: "SendToUser", inputSchema: { type: "object" } }];
export const correctArgs = { target_id: "synthetic-target", message: "synthetic-message" };
export type FixtureCall = { name: string; args: unknown };
export function contractResponse(api: "chat" | "responses", calls: FixtureCall[], text = "", fragmentation: "all" | "frames" | "bytes" = "frames"): Response {
  const rows: unknown[] = [];
  if (api === "chat") {
    const chunk = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
    if (text) rows.push(chunk({ content: text }));
    for (const [index, call] of calls.entries()) rows.push(chunk({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
    rows.push({ ...chunk({}, calls.length ? "tool_calls" : "stop"), usage: { prompt_tokens: 5, completion_tokens: 3 } });
  } else {
    const common = { id: "response_fixture", model: "fixture", created_at: 1 };
    rows.push({ type: "response.created", response: common });
    if (text) {
      const item = { type: "message", id: "text_fixture", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
      rows.push({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: "response.output_item.done", output_index: 0, item });
    }
    for (const [index, call] of calls.entries()) {
      const output_index = index + (text ? 1 : 0), args = JSON.stringify(call.args);
      const item = { type: "function_call", id: `item_${index}`, call_id: `call_${index}`, name: call.name, arguments: args, status: "completed" };
      rows.push({ type: "response.output_item.added", output_index, item: { ...item, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: args },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: args },
        { type: "response.output_item.done", output_index, item });
    }
    rows.push({ type: "response.completed", response: { ...common, status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  }
  const enc = new TextEncoder(), frames = rows.map(row => enc.encode(`data: ${JSON.stringify(row)}\n\n`));
  if (api === "chat") frames.push(enc.encode("data: [DONE]\n\n"));
  const all = enc.encode(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + (api === "chat" ? "data: [DONE]\n\n" : ""));
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (fragmentation === "frames") { if (i < frames.length) controller.enqueue(frames[i++]!); else controller.close(); }
    else if (i < all.length) { const end = fragmentation === "bytes" ? i + 1 : all.length; controller.enqueue(all.slice(i, end)); i = end; }
    else controller.close();
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
