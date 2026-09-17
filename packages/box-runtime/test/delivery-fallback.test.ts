import { expect, test } from "bun:test";
import { declaredTextEndTurn } from "../src/internal/host/delivery-fallback.ts";
import { createStreamingPromptSession, type SessionTerminal } from "../src/internal/host/session.ts";
import type { ToolDefinition } from "@grokbox/runtime-kernel/contract";

const tool = (endTurn: boolean): ToolDefinition => ({ name: "SendToUser", inputSchema: { type: "object", properties: { type: { const: "text" }, content: { type: "string" }, ...(endTurn ? { end_turn: { type: "boolean" } } : {}) } } });
for (const endTurn of [false, true]) test(`final text fallback preserves reasoning/history and respects declared end_turn=${endTurn}`, async () => {
  let terminal: SessionTerminal | undefined;
  const session = createStreamingPromptSession({ modelId: "fixture", vision: false, parallel: "fail-closed", onTerminal: value => { terminal = value; },
    produce: async function* () {
      yield { type: "reasoning", textDelta: "<think>private synthetic reasoning</think>" };
      yield { type: "text-delta", textDelta: "final visible answer" };
      yield { type: "finish", reason: "stop", usage: { promptTokens: 4, completionTokens: 8, totalTokens: 12 } };
    } });
  const handle = session.stream({ envelope: { version: 1, messages: [{ role: "user", content: "fixture" }], tools: [tool(endTurn)], options: {} } });
  const response = await handle.response;
  expect(response.messages[0]?.content).toEqual([
    { type: "reasoning", text: "<think>private synthetic reasoning</think>" }, { type: "text", text: "final visible answer" },
    { type: "tool-call", toolCallId: expect.any(String), toolName: "SendToUser", args: { type: "text", content: "final visible answer", ...(endTurn ? { end_turn: true } : {}) } },
  ]);
  expect(terminal?.diagnostic?.stream?.counts.syntheticDeliveries).toBe(1);
  expect(terminal?.diagnostic?.stream?.counts.syntheticFinalDeliveries).toBe(endTurn ? 1 : undefined);
  const parts = []; for await (const part of handle.fullStream) parts.push(part);
  const executable = parts.filter(p => p.type === "tool-call"); expect(executable).toHaveLength(1);
  expect(JSON.stringify(executable)).not.toContain("private synthetic reasoning");
});
test("end_turn is granted only by the compatible text schema, not another union alternative", () => {
  expect(declaredTextEndTurn(tool(true))).toBe(true); expect(declaredTextEndTurn(tool(false))).toBe(false);
  expect(declaredTextEndTurn({ name: "SendToUser", inputSchema: { type: "object", oneOf: [
    { type: "object", properties: { type: { const: "text" }, content: { type: "string" } } },
    { type: "object", properties: { type: { const: "widget" }, end_turn: { type: "boolean" } } },
  ] } })).toBe(false);
  expect(declaredTextEndTurn({ name: "SendToUser", inputSchema: { type: "object", anyOf: [tool(true).inputSchema] } })).toBe(true);
});
