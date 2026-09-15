import { expect, test } from "bun:test";
import { withFakeHttpSession, SYNTHETIC_OPENAI } from "./context-continuity-fixture.ts";
import type { ModelRecord } from "@grokbox/runtime-kernel/selection";

const MODEL: ModelRecord = {
  ...SYNTHETIC_OPENAI, id: "openai-responses/owned-grok", provider: "openai-responses", model: "owned-grok",
};
const TOOLS = [{ name: "lookup", description: "owned lookup", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }];
const SETTINGS = { maxTokens: 128, parallelToolCalls: false };
const REASONING = "Use the owned lookup and retain the user fact.";

function responseStream(number: number): Response {
  const id = `resp-owned-${number}`;
  const common = { id, model: "owned-grok", object: "response", created_at: 1 };
  const rows: unknown[] = [{ type: "response.created", response: { ...common, status: "in_progress", output: [] } }];
  if (number === 1) {
    rows.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-owned", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs-owned", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs-owned", output_index: 0, summary_index: 0, delta: REASONING },
      { type: "response.reasoning_summary_text.done", item_id: "rs-owned", output_index: 0, summary_index: 0, text: REASONING },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs-owned", summary: [{ type: "summary_text", text: REASONING }] } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc-owned", call_id: "call-owned", name: "lookup", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc-owned", output_index: 1, delta: '{"key":"river"}' },
      { type: "response.function_call_arguments.done", item_id: "fc-owned", output_index: 1, arguments: '{"key":"river"}' },
      { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc-owned", call_id: "call-owned", name: "lookup", arguments: '{"key":"river"}', status: "completed" } },
    );
  } else {
    rows.push(
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg-${number}`, role: "assistant", content: [] } },
      { type: "response.content_part.added", item_id: `msg-${number}`, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: `msg-${number}`, output_index: 0, content_index: 0, delta: "RIVER=91" },
      { type: "response.output_text.done", item_id: `msg-${number}`, output_index: 0, content_index: 0, text: "RIVER=91" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg-${number}`, role: "assistant", content: [{ type: "output_text", text: "RIVER=91", annotations: [] }] } },
    );
  }
  rows.push({ type: "response.completed", response: { ...common, status: "completed", output: [], usage: {
    input_tokens: 44, output_tokens: 12, total_tokens: 56,
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 },
  } } });
  return new Response(rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function payloadText(body: unknown): string {
  const input = (body as { input: Array<{ content?: unknown }> }).input;
  return input.flatMap((entry) => typeof entry.content === "string" ? [entry.content]
    : Array.isArray(entry.content) ? entry.content.map((part) => typeof part.text === "string" ? part.text : "") : []).join("");
}

test("Responses reasoning → one owned tool → same TURN continuation → next TURN preserves complete history", async () => {
  await withFakeHttpSession({ turnId: "responses-first-turn", model: MODEL, respond: responseStream,
    fn: async ({ session, requests, makeSession }) => {
      const root = session.getExecutor([{ role: "user", content: "Remember RIVER=91; use lookup once." }]);
      const first = root.stream({}, "step-tool", TOOLS, SETTINGS);
      const released: unknown[] = [];
      for await (const part of first.fullStream) released.push(part);
      const one = await first.response;
      expect(one.finishReason).toBe("tool-calls");
      const message = one.messages[0]!;
      expect(Array.isArray(message.content)).toBe(true);
      const content = message.content as Array<{ type: string; text?: string; toolName?: string; toolCallId?: string; args?: unknown }>;
      expect(content.find((part) => part.type === "reasoning")?.text).toBe(REASONING);
      const calls = content.filter((part) => part.type === "tool-call");
      expect(calls).toEqual([{ type: "tool-call", toolCallId: "call-owned", toolName: "lookup", args: { key: "river" } }]);
      expect(released.filter((part) => part !== null && typeof part === "object" && "type" in part && part.type === "tool-call")).toHaveLength(1);
      let toolEffects = 0;
      // Owned stand-in for a Host tool writer, never a shell/network operation.
      const result = (() => { toolEffects++; return { value: 91, ok: true }; })();
      root.appendMessages(one.messages);
      root.appendMessages([{ role: "tool", content: [{ type: "tool-result", toolCallId: "call-owned", toolName: "lookup", result }] }]);
      const checkpoint = structuredClone(root.getState());
      const second = await root.stream({}, "step-after-tool", TOOLS, SETTINGS).response;
      expect(second.finishReason).toBe("stop");
      expect(second.messages[0]?.content).toEqual([{ type: "text", text: "RIVER=91" }]);
      expect(toolEffects).toBe(1);
      expect(root.getState()).toEqual(checkpoint);
      expect(requests).toHaveLength(2);
      const replay = JSON.stringify(requests[1]!.body);
      expect(replay).toContain(REASONING);
      expect(replay).toContain("call-owned");
      expect(replay).toContain("lookup");
      expect(replay).toContain("river");
      expect(replay).toContain("91");
      root.appendMessages(second.messages);
      const next = makeSession({ turnId: "responses-next-turn", model: MODEL }).getExecutor(root.getState());
      next.appendMessages([{ role: "user", content: "Recall the river value without another lookup." }]);
      const third = await next.stream({}, "step-next-turn", TOOLS, SETTINGS).response;
      expect(third.messages[0]?.content).toEqual([{ type: "text", text: "RIVER=91" }]);
      expect(requests).toHaveLength(3);
      expect(payloadText(requests[2]!.body)).toContain(REASONING);
      expect(payloadText(requests[2]!.body)).toContain("Recall the river value");
      expect(toolEffects).toBe(1);
      for (const { body } of requests) {
        expect(body).toMatchObject({ model: "owned-grok", max_output_tokens: 128, parallel_tool_calls: false });
        expect((body as { tools: unknown[] }).tools).toHaveLength(1);
      }
    },
  });
}, 15_000);
