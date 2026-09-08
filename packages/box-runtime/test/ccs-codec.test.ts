import { describe, expect, test } from "bun:test";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";
import { sendCcsRequest, type CcsApi } from "../src/internal/backends/ccs-codec.ts";

const schema = { type: "object", properties: { q: { type: "string" } } };
const longArg = `α${"x".repeat(1600)}`;
const longResult = `中文${"y".repeat(8100)}`;
const mixedText = "mixed SAND_HIDDEN ack-redrive ";
const root = "required-root-once";
const oracle = {
  toolCallId: "c1",
  toolName: "lookup",
  argsQ: longArg,
  result: { rows: [0, false, ""] as const, note: longResult },
  isError: false,
  mixedText,
  root,
  userTurns: 2,
};

function userContainedSnapshot() {
  return hostToContextSnapshot({
    profileId: "ccs-user-contained",
    abiIdentity: "host-abi-v1",
    independentRoot: root,
    tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    state: [
      { role: "user", content: "ask" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: oracle.toolCallId, toolName: oracle.toolName, args: { q: longArg } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: mixedText },
          {
            type: "tool-result",
            toolCallId: oracle.toolCallId,
            toolName: oracle.toolName,
            result: { rows: [0, false, ""], note: longResult },
            isError: false,
          },
        ],
      },
    ],
  });
}

function toolRoleSnapshot() {
  return hostToContextSnapshot({
    profileId: "ccs-tool-role",
    abiIdentity: "host-abi-v1",
    independentRoot: root,
    tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    state: [
      { role: "user", content: "" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: oracle.toolCallId, toolName: oracle.toolName, args: { q: longArg } }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: oracle.toolCallId,
          toolName: oracle.toolName,
          result: { rows: [0, false, ""], note: longResult },
          isError: false,
        }],
      },
    ],
  });
}

function chatCompletion(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function responsesCompletion(): Response {
  return new Response(JSON.stringify({
    id: "resp_test",
    object: "response",
    status: "completed",
    output: [{
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function walkStrings(value: unknown, acc: string[]): void {
  if (typeof value === "string") acc.push(value);
  else if (Array.isArray(value)) for (const entry of value) walkStrings(entry, acc);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) walkStrings(entry, acc);
}

function rolesOf(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const list = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : [];
  return list.map((entry) => {
    if (!entry || typeof entry !== "object" || !("role" in entry)) return "";
    return String((entry as { role: unknown }).role);
  });
}

function parseToolResults(body: unknown): Array<{ toolCallId: string; toolName?: string; result: unknown; isError: boolean }> {
  const strings: string[] = [];
  walkStrings(body, strings);
  const found: Array<{ toolCallId: string; toolName?: string; result: unknown; isError: boolean }> = [];
  for (const text of strings) {
    try {
      const value = JSON.parse(text) as { type?: unknown; toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown };
      if (value && value.type === "tool-result" && typeof value.toolCallId === "string") {
        found.push({
          toolCallId: value.toolCallId,
          toolName: typeof value.toolName === "string" ? value.toolName : undefined,
          result: value.result,
          isError: value.isError === true,
        });
      }
    } catch {
      /* not a tool-result payload */
    }
  }
  return found;
}

function assertHttpOracle(body: unknown, extras: { mixed?: boolean } = { mixed: true }): void {
  expect(body).toBeTruthy();
  const text = JSON.stringify(body);
  expect(text).toContain(oracle.toolCallId);
  expect(text).toContain(oracle.toolName);
  expect(text).toContain(longArg);
  expect(text).toContain(longResult);
  expect(text).toContain("中文");
  expect(text).toContain(root);
  if (extras.mixed !== false) {
    expect(text).toContain("SAND_HIDDEN");
    expect(text).toContain("ack-redrive");
    expect(text).toContain(mixedText.trim());
  }
  expect(text).not.toMatch(/"role":"tool"/);
  expect(text).not.toContain("extra-human");
  const roles = rolesOf(body);
  expect(roles.filter((role) => role === "user")).toHaveLength(oracle.userTurns);
  expect(roles).not.toContain("tool");
  const results = parseToolResults(body);
  expect(results).toHaveLength(1);
  expect(results[0]).toEqual({
    toolCallId: oracle.toolCallId,
    toolName: oracle.toolName,
    result: { rows: [0, false, ""], note: longResult },
    isError: false,
  });
}

async function capture(api: CcsApi, snapshot = userContainedSnapshot()): Promise<unknown> {
  let body: unknown;
  const deny = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : await new Response(init?.body).text());
    return api === "responses" ? responsesCompletion() : chatCompletion();
  };
  const fetch = Object.assign(deny, { preconnect: deny }) as typeof globalThis.fetch;
  try {
    await sendCcsRequest({
      snapshot,
      api,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL: "https://ccs.test/v1",
      fetch,
    });
  } catch {
    /* T21 oracle is the request body, not provider response parse. */
  }
  return body;
}

describe("CCS codec", () => {
  test("Chat and Responses HTTP bodies keep user-contained tool id/name/result/isError without a new Human turn", async () => {
    const chat = await capture("chat");
    const responses = await capture("responses");
    assertHttpOracle(chat);
    assertHttpOracle(responses);
  });

  test("tool-role results fold into user.content, never raw role=tool", async () => {
    const chat = await capture("chat", toolRoleSnapshot());
    const responses = await capture("responses", toolRoleSnapshot());
    assertHttpOracle(chat, { mixed: false });
    assertHttpOracle(responses, { mixed: false });
  });

  test("HTTP oracle fails if result, tail, or root is stripped or extra Human/raw-tool is injected", async () => {
    const chat = await capture("chat");
    assertHttpOracle(chat);
    const strippedResult = JSON.parse(JSON.stringify(chat).replace(longResult, "")) as unknown;
    expect(() => assertHttpOracle(strippedResult)).toThrow();
    const strippedRoot = JSON.parse(JSON.stringify(chat).replace(root, "")) as unknown;
    expect(() => assertHttpOracle(strippedRoot)).toThrow();
    const extraHuman = JSON.parse(JSON.stringify(chat)) as { messages?: unknown[]; input?: unknown[] };
    const list = extraHuman.messages ?? extraHuman.input;
    expect(Array.isArray(list)).toBe(true);
    list!.push({ role: "user", content: "extra-human" });
    expect(() => assertHttpOracle(extraHuman)).toThrow();
    const rawTool = JSON.parse(JSON.stringify(chat)) as { messages?: unknown[]; input?: unknown[] };
    (rawTool.messages ?? rawTool.input)!.push({ role: "tool", content: "raw-tool" });
    expect(() => assertHttpOracle(rawTool)).toThrow();
  });
});
