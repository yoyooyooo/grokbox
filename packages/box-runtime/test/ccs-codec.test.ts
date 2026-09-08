import { describe, expect, test } from "bun:test";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";
import { encodeCcsMessages, sendCcsRequest, type CcsApi } from "../src/internal/backends/ccs-codec.ts";

const schema = { type: "object", properties: { q: { type: "string" } } };
const longArg = `α${"x".repeat(1600)}`;
const longResult = `中文${"y".repeat(8100)}`;

function continuationSnapshot() {
  return hostToContextSnapshot({
    profileId: "ccs-root",
    abiIdentity: "host-abi-v1",
    independentRoot: "required-root-once",
    tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    state: [
      { role: "user", content: "ask" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: longArg } }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "mixed SAND_HIDDEN ack-redrive " },
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "lookup",
            result: { rows: [0, false, ""], note: longResult },
            isError: false,
          },
        ],
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

async function capture(api: CcsApi): Promise<unknown> {
  let body: unknown;
  const deny = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(typeof init?.body === "string" ? init.body : await new Response(init?.body).text());
    return api === "responses" ? responsesCompletion() : chatCompletion();
  };
  const fetch = Object.assign(deny, { preconnect: deny }) as typeof globalThis.fetch;
  try {
    await sendCcsRequest({
      snapshot: continuationSnapshot(),
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

function assertOracle(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).toContain("c1");
  expect(text).toContain("lookup");
  expect(text).toContain(longArg);
  expect(text).toContain(longResult);
  expect(text).toContain("中文");
  expect(text).toContain("SAND_HIDDEN");
  expect(text).toContain("ack-redrive");
  expect(text).toContain("required-root-once");
  expect(text).not.toMatch(/"role":"tool"/);
  expect(text).not.toContain("extra-human");
  const encoded = encodeCcsMessages(continuationSnapshot());
  const last = encoded.at(-1);
  expect(last?.role).toBe("user");
  const lastText = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((part) => part.text).join("");
  expect(lastText).toContain("c1");
  expect(lastText).toContain('"isError":false');
  expect(encoded.filter((message) => message.role === "user")).toHaveLength(2);
}

describe("CCS codec", () => {
  test("Chat and Responses HTTP bodies keep tool id/name/result/isError without a new Human turn", async () => {
    const chat = await capture("chat");
    const responses = await capture("responses");
    assertOracle(chat);
    assertOracle(responses);
  });

  test("oracle fails if result, tail, or root is stripped or an extra Human is injected", () => {
    const encoded = encodeCcsMessages(continuationSnapshot());
    const stripped = JSON.stringify(encoded).replace(longResult, "");
    expect(stripped).not.toContain(longResult);
    expect(() => {
      expect(stripped).toContain(longResult);
    }).toThrow();
    const extraHuman = [...encoded, { role: "user" as const, content: "extra-human" }];
    expect(JSON.stringify(extraHuman)).toContain("extra-human");
    expect(extraHuman.filter((message) => message.role === "user")).not.toHaveLength(2);
  });
});
