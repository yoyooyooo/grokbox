import { describe, expect, test } from "bun:test";
import { EnvelopeError } from "@grokbox/runtime-kernel/contract";
import { hostToContextSnapshot } from "../src/internal/host/context-codec.ts";
import { encodeOpenaiPrompt, sendOpenaiPrompt, type OpenaiPromptApi } from "../src/internal/backends/openai-prompt-adapter.ts";

const schema = { type: "object", properties: { q: { type: "string" } } };
const longArg = `α${"x".repeat(1600)}`;
const longResult = `中文${"y".repeat(8100)}`;
const mixedText = "mixed SAND_HIDDEN ack-redrive ";
const root = "required-root-once";
const imageSentinel = "https://ccs.test/image-sentinel.png";
const reasonSentinel = "reason-sentinel";
const textSentinel = "text-sentinel";

const options = {
  temperature: 0.2,
  topP: 0.7,
  maxTokens: 11,
  seed: 17,
  stopSequences: ["STOP_SENTINEL"],
  parallelToolCalls: false,
  toolChoice: "none" as const,
};

function continuationState(resultRole: "user" | "tool") {
  const resultPart = {
    type: "tool-result" as const,
    toolCallId: "c1",
    toolName: "lookup",
    result: { rows: [0, false, ""], note: longResult },
    isError: false,
  };
  return [
    { role: "user" as const, content: resultRole === "user" ? "ask" : "" },
    {
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "lookup", args: { q: longArg } }],
    },
    resultRole === "user"
      ? { role: "user" as const, content: [{ type: "text" as const, text: mixedText }, resultPart] }
      : { role: "tool" as const, content: [resultPart] },
  ];
}

function snapshot(state: unknown, extra?: { options?: Partial<typeof options> & { toolChoice?: "none" | "auto" | "required" }; tools?: unknown }) {
  return hostToContextSnapshot({
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    independentRoot: root,
    tools: extra?.tools ?? [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    options: extra?.options,
    state,
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

function history(body: unknown): unknown[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.messages)) return record.messages;
  if (Array.isArray(record.input)) return record.input;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return asRecord(value);
  } catch {
    return null;
  }
}

function contentStrings(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (!rec) continue;
    if (typeof rec.text === "string") out.push(rec.text);
    if (typeof rec.image_url === "string") out.push(rec.image_url);
    const image = asRecord(rec.image_url);
    if (image && typeof image.url === "string") out.push(image.url);
    if (typeof rec.image === "string") out.push(rec.image);
    if (typeof rec.url === "string") out.push(rec.url);
  }
  return out;
}

function parsePayloads(content: unknown, type: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const text of contentStrings(content)) {
    const rec = parseJsonObject(text);
    if (rec?.type === type) found.push(rec);
  }
  return found;
}

function systemRoots(body: unknown): string[] {
  const rec = asRecord(body);
  if (!rec) return [];
  const roots: string[] = [];
  if (typeof rec.instructions === "string" && rec.instructions.length > 0) roots.push(rec.instructions);
  for (const entry of history(body)) {
    const item = asRecord(entry);
    if (item?.role === "system" && typeof item.content === "string") roots.push(item.content);
  }
  return roots;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function assistantCalls(item: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  if (item.type === "function_call" || item.type === "tool_call") {
    calls.push({
      type: "tool-call",
      toolCallId: item.call_id ?? item.id,
      toolName: item.name,
      args: parseArgs(item.arguments),
    });
  }
  const listed = item.tool_calls;
  if (Array.isArray(listed)) {
    for (const call of listed) {
      const rec = asRecord(call);
      const fn = rec ? asRecord(rec.function) : null;
      if (!rec) continue;
      calls.push({
        type: "tool-call",
        toolCallId: rec.id ?? rec.call_id,
        toolName: fn?.name ?? rec.name,
        args: parseArgs(fn?.arguments ?? rec.arguments),
      });
    }
  }
  return calls;
}

function toolResults(item: Record<string, unknown>): Array<Record<string, unknown>> {
  if (item.role === "tool" || item.type === "function_call_output") {
    const raw = item.content ?? item.output;
    return [{
      type: "tool-result",
      toolCallId: item.tool_call_id ?? item.call_id,
      result: parseArgs(raw),
    }];
  }
  return [];
}

function sequence(body: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const entry of history(body)) {
    const item = asRecord(entry);
    if (!item || item.role === "system") continue;
    const calls = assistantCalls(item);
    if (calls.length > 0) {
      out.push({ kind: "assistant-calls", calls });
      continue;
    }
    const results = toolResults(item);
    if (results.length > 0) {
      out.push({ kind: "tool-results", results });
      continue;
    }
    const role = String(item.role ?? item.type ?? "unknown");
    const text = contentStrings(item.content).join("");
    if (role === "assistant" && text.length === 0) continue;
    out.push({ kind: role === "message" ? String(item.role ?? "user") : role, text });
  }
  return out;
}

function toolDefinitions(body: unknown): Array<{ name: unknown; description: unknown; parameters: unknown }> {
  const rec = asRecord(body);
  const tools = rec && Array.isArray(rec.tools) ? rec.tools : [];
  return tools.map((tool) => {
    const item = asRecord(tool);
    const fn = item ? asRecord(item.function) : null;
    const source = fn ?? item;
    return {
      name: source?.name,
      description: source?.description,
      parameters: source?.parameters,
    };
  });
}

function toolChoiceOf(body: unknown): unknown {
  const rec = asRecord(body);
  return rec?.tool_choice ?? rec?.toolChoice;
}

function expectedSequence(mixed: boolean): Array<Record<string, unknown>> {
  const call = {
    kind: "assistant-calls",
    calls: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: longArg } }],
  };
  const result = {
    kind: "tool-results",
    results: [{ type: "tool-result", toolCallId: "c1", result: { rows: [0, false, ""], note: longResult } }],
  };
  if (mixed) {
    return [{ kind: "user", text: "ask" }, call, { kind: "user", text: mixedText }, result];
  }
  return [{ kind: "user", text: "" }, call, result];
}

function assertHttpOracle(body: unknown, extras: { mixed?: boolean } = { mixed: true }): void {
  expect(body).toBeTruthy();
  const rec = asRecord(body);
  expect(rec).toBeTruthy();
  expect(systemRoots(body)).toEqual([root]);
  expect(sequence(body)).toEqual(expectedSequence(extras.mixed !== false));
  expect(toolDefinitions(body)).toEqual([{ name: "lookup", description: "lookup schema", parameters: schema }]);
  const text = JSON.stringify(body);
  expect(text).toContain(longArg);
  expect(text).toContain(longResult);
  expect(text).toContain("中文");
  if (extras.mixed !== false) {
    expect(text).toContain("SAND_HIDDEN");
    expect(text).toContain("ack-redrive");
  }
}

async function capture(api: OpenaiPromptApi, snap = snapshot(continuationState("user"))): Promise<{ body: unknown; http: number }> {
  let http = 0;
  let body: unknown;
  const deny = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    http += 1;
    body = JSON.parse(typeof init?.body === "string" ? init.body : await new Response(init?.body).text());
    return api === "responses" ? responsesCompletion() : chatCompletion();
  };
  const fetch = Object.assign(deny, { preconnect: deny }) as typeof globalThis.fetch;
  try {
    await sendOpenaiPrompt({
      snapshot: snap,
      api,
      model: "gpt-4o-mini",
      apiKey: "test-key",
      baseURL: "https://ccs.test/v1",
      fetch,
    });
  } catch {
    /* request body is the oracle */
  }
  return { body, http };
}

describe("openai prompt adapter", () => {
  test("Chat and Responses HTTP bodies keep ordered call/result, root once, and tools schema", async () => {
    const chat = await capture("chat");
    const responses = await capture("responses");
    expect(chat.http).toBe(1);
    expect(responses.http).toBe(1);
    assertHttpOracle(chat.body);
    assertHttpOracle(responses.body);
  });

  test("tool-role results use Chat/Responses tool result items, not JSON-in-user-text", async () => {
    const chat = await capture("chat", snapshot(continuationState("tool")));
    const responses = await capture("responses", snapshot(continuationState("tool")));
    assertHttpOracle(chat.body, { mixed: false });
    assertHttpOracle(responses.body, { mixed: false });
  });

  test("generation options reach Chat and Responses bodies, including tool_choice none", async () => {
    const chatSnap = snapshot(continuationState("user"), { options });
    const chat = await capture("chat", chatSnap);
    expect(chat.http).toBe(1);
    const chatBody = asRecord(chat.body)!;
    expect(chatBody.temperature).toBe(0.2);
    expect(chatBody.top_p).toBe(0.7);
    expect(chatBody.max_tokens).toBe(11);
    expect(chatBody.seed).toBe(17);
    expect(chatBody.stop).toEqual(["STOP_SENTINEL"]);
    expect(chatBody.parallel_tool_calls).toBe(false);
    expect(toolChoiceOf(chat.body)).toBe("none");

    const responsesSnap = snapshot(continuationState("user"), {
      options: { temperature: 0.2, topP: 0.7, maxTokens: 11, parallelToolCalls: false, toolChoice: "none" },
    });
    const responses = await capture("responses", responsesSnap);
    expect(responses.http).toBe(1);
    const responsesBody = asRecord(responses.body)!;
    expect(responsesBody.temperature).toBe(0.2);
    expect(responsesBody.top_p).toBe(0.7);
    expect(responsesBody.max_output_tokens).toBe(11);
    expect(responsesBody.parallel_tool_calls).toBe(false);
    expect(toolChoiceOf(responses.body)).toBe("none");

    const rejected = await capture("responses", chatSnap);
    expect(rejected.http).toBe(0);
  });

  test("mixed images and plain reasoning history survive SDK HTTP projection without fake provider IDs", async () => {
    const mixedImage = snapshot([
      { role: "user", content: [{ type: "text", text: textSentinel }, { type: "image", url: imageSentinel }] },
    ]);
    const mixedReason = snapshot([
      { role: "user", content: textSentinel },
      { role: "assistant", content: [{ type: "reasoning", text: reasonSentinel }, { type: "text", text: textSentinel }] },
    ]);
    const loneImage = snapshot([{ role: "user", content: [{ type: "image", url: imageSentinel }] }]);
    const loneReason = snapshot([
      { role: "user", content: "ask" },
      { role: "assistant", content: [{ type: "reasoning", text: reasonSentinel }] },
    ]);
    for (const api of ["chat", "responses"] as const) {
      const imageChat = await capture(api, mixedImage);
      expect(imageChat.http).toBe(1);
      expect(JSON.stringify(imageChat.body)).toContain(imageSentinel);
      expect(JSON.stringify(imageChat.body)).toContain(textSentinel);
      const lone = await capture(api, loneImage);
      expect(lone.http).toBe(1);
      expect(JSON.stringify(lone.body)).toContain(imageSentinel);
      const reason = await capture(api, mixedReason);
      expect(reason.http).toBe(1);
      expect(JSON.stringify(reason.body)).toContain(textSentinel);
      expect(JSON.stringify(reason.body)).not.toContain("item_reference");
      const loneR = await capture(api, loneReason);
      expect(loneR.http).toBe(1);
      expect(encodeOpenaiPrompt(loneReason).messages.at(-1)).toEqual({
        role: "assistant", content: [{ type: "reasoning", text: reasonSentinel }],
      });
    }
  });

  test("HTTP oracle fails on reorder, missing tools, duplicate root, dropped schema, and duplicated results", async () => {
    const chat = await capture("chat");
    const responses = await capture("responses");
    for (const body of [chat.body, responses.body]) {
      assertHttpOracle(body);
      const rec = asRecord(JSON.parse(JSON.stringify(body)))!;
      const list = (Array.isArray(rec.messages) ? rec.messages : rec.input) as unknown[];
      const rest = list.filter((entry) => asRecord(entry)?.role !== "system");
      const system = list.filter((entry) => asRecord(entry)?.role === "system");
      const reordered = [...system, rest[0], ...rest.slice(1).reverse()];
      if (Array.isArray(rec.messages)) rec.messages = reordered;
      else rec.input = reordered;
      expect(() => assertHttpOracle(rec)).toThrow();

      const noTools = asRecord(JSON.parse(JSON.stringify(body)))!;
      delete noTools.tools;
      expect(() => assertHttpOracle(noTools)).toThrow();

      const dup = asRecord(JSON.parse(JSON.stringify(body)))!;
      const hist = history(dup);
      if (typeof dup.instructions === "string") dup.instructions = `${dup.instructions}${root}`;
      else hist.unshift({ role: "system", content: root });
      if (Array.isArray(dup.messages) && !dup.instructions) dup.messages = hist;
      else if (Array.isArray(dup.input) && !dup.instructions) dup.input = hist;
      expect(() => assertHttpOracle(dup)).toThrow();

      const noSchema = asRecord(JSON.parse(JSON.stringify(body)))!;
      const tools = Array.isArray(noSchema.tools) ? noSchema.tools : [];
      const firstTool = asRecord(tools[0]);
      const fn = firstTool ? asRecord(firstTool.function) : null;
      if (fn) delete fn.parameters;
      else if (firstTool) delete firstTool.parameters;
      expect(() => assertHttpOracle(noSchema)).toThrow();

      const dupResult = asRecord(JSON.parse(JSON.stringify(body)))!;
      const resultHist = history(dupResult);
      const extraResults = resultHist.filter((entry) => {
        const item = asRecord(entry);
        return item?.role === "tool" || item?.type === "function_call_output";
      });
      expect(extraResults.length).toBeGreaterThan(0);
      const doubled = [...resultHist, ...extraResults];
      if (Array.isArray(dupResult.messages)) dupResult.messages = doubled;
      else dupResult.input = doubled;
      expect(() => assertHttpOracle(dupResult)).toThrow();
    }
  });

  test("state-root mixed system image is rejected before provider", async () => {
    const snap = hostToContextSnapshot({
      profileId: "t21-state-root",
      abiIdentity: "host-abi-v1",
      state: [
        { role: "system", content: [{ type: "text", text: "root-text" }, { type: "image", url: imageSentinel }] },
        { role: "user", content: "hello" },
      ],
      tools: [{ name: "lookup", description: "lookup schema", inputSchema: schema }],
    });
    expect(snap.systemMessages).toEqual([{
      role: "system",
      content: [{ type: "text", text: "root-text" }, { type: "image", url: imageSentinel }],
    }]);
    expect(() => encodeOpenaiPrompt(snap)).toThrow(EnvelopeError);
    for (const api of ["chat", "responses"] as const) {
      const captured = await capture(api, snap);
      expect(captured.http).toBe(0);
      expect(captured.body).toBeUndefined();
    }
  });
});
