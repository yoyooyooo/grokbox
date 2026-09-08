import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildModelEnvelope } from "../src/envelope.ts";
import { createModeld, type ModelPin } from "../src/modeld.ts";
import { collectAs1Chunks } from "../src/modeld-as1.ts";
import {
  as1ChunksFromOpenAiEvents,
  createOpenAiModeldDriver,
  envelopeToOpenAiLivePrompt,
  envelopeToOpenAiMessages,
  mapOpenAiStreamEvent,
  openAiAccepts,
  openAiApiMode,
  sanitizeOpenAiError,
} from "../src/modeld-openai.ts";
import { sha256Text } from "../src/hash.ts";
import { STUB_ECHO_MODEL, type ModelsFile } from "../src/models.ts";
import { FAKE_BINDING, submitRequest } from "./modeld-fixture.ts";

const TEST_KEY = "test-key";

const openaiModel = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};
const responsesModel = { ...openaiModel, id: "openai/gpt-4o-mini-responses", provider: "openai-responses" };
const pin: ModelPin = {
  model: openaiModel,
  assignment: "main",
  fingerprint: "a".repeat(64),
  credentialFingerprint: sha256Text(TEST_KEY),
};
const openaiModels: ModelsFile = {
  version: 1,
  models: { [openaiModel.id]: openaiModel },
  assignments: { main: openaiModel.id, agents: {} },
};

describe("OpenAI envelope mapping", () => {
  test("accepts openai chat/responses with http(s) baseURL and never stub/echo", () => {
    expect(openAiApiMode(openaiModel)).toBe("chat");
    expect(openAiApiMode(responsesModel)).toBe("responses");
    expect(openAiAccepts(openaiModel)).toBe(true);
    expect(openAiAccepts(responsesModel)).toBe(true);
    expect(openAiAccepts(STUB_ECHO_MODEL)).toBe(false);
    expect(openAiAccepts({ ...openaiModel, endpoint: "stub:echo" })).toBe(false);
    expect(openAiAccepts({ ...openaiModel, provider: "as1" })).toBe(false);
    expect(openAiAccepts({ ...openaiModel, apiKeyRef: "" })).toBe(false);
  });

  test("maps messages, tools history, and images without execute metadata", () => {
    const envelope = buildModelEnvelope([
      { role: "system", content: "sys" },
      { role: "user", content: [
        { type: "text", text: "see" },
        { type: "image", url: "https://example.test/a.png", mimeType: "image/png" },
      ] },
      { role: "assistant", content: [
        { type: "text", text: "call" },
        { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "x" } },
      ] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", result: { ok: true } }] },
    ], [{ name: "lookup", description: "look", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]);
    expect(envelopeToOpenAiLivePrompt(envelope)).toEqual({
      system: "sys",
      messages: [{ role: "user", content: "see" }],
    });
    expect(envelopeToOpenAiLivePrompt(buildModelEnvelope([
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]))).toEqual({
      system: "sys",
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "again" },
      ],
    });
    const withTools = envelopeToOpenAiLivePrompt(buildModelEnvelope([
      { role: "user", content: "ask" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", result: { ok: true } }] },
      { role: "user", content: "follow" },
    ], [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }]));
    expect(withTools.messages.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
    expect(withTools.messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(withTools.messages)).not.toMatch(/tool-call|tool-result/);
    expect(withTools.messages.at(-1)).toEqual({ role: "user", content: "follow" });
    expect(envelopeToOpenAiMessages(envelope)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: [
        { type: "text", text: "see" },
        { type: "image", image: "https://example.test/a.png", mediaType: "image/png" },
      ] },
      { role: "assistant", content: [
        { type: "text", text: "call" },
        { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "x" } },
      ] },
      { role: "tool", content: [
        { type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "json", value: { ok: true } } },
      ] },
    ]);
  });

  test("keeps early user turns past recent pings; filters noise; SendToUser becomes assistant text", () => {
    const history: Array<Record<string, unknown>> = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 80; i += 1) {
      history.push({ role: "user", content: `topic-${i} remember this` });
      history.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: `s${i}`, toolName: "SendToUser", args: { text: { content: `ack-${i}` } } }],
      });
      history.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: `s${i}`, toolName: "SendToUser", result: { ok: true } }],
      });
    }
    history.push({ role: "user", content: "SAND_HIDDEN ping" });
    history.push({ role: "assistant", content: "The configured model request failed. No fallback model was used." });
    for (let i = 0; i < 30; i += 1) {
      history.push({ role: "user", content: `canary ping ${i}` });
      history.push({ role: "assistant", content: "pong" });
    }
    history.push({ role: "user", content: "list earlier topics" });
    const live = envelopeToOpenAiLivePrompt(buildModelEnvelope(history, [
      { name: "SendToUser", inputSchema: { type: "object", properties: {} } },
    ]));
    expect(live.system).toBe("sys");
    expect(live.messages.length).toBeGreaterThan(24);
    expect(live.messages.some((message) => message.role === "user" && String(message.content).includes("topic-0"))).toBe(true);
    expect(live.messages.some((message) => message.role === "assistant" && String(message.content).includes("ack-0"))).toBe(true);
    expect(live.messages.some((message) => String(message.content).includes("SAND_HIDDEN"))).toBe(false);
    expect(live.messages.some((message) => String(message.content).includes("configured model request failed"))).toBe(false);
    expect(live.messages.some((message) => message.role === "tool")).toBe(false);
    expect(JSON.stringify(live.messages)).not.toMatch(/tool-call|tool-result/);
    expect(live.messages.at(-1)).toEqual({ role: "user", content: "list earlier topics" });
  });

  test("maps SDK stream events including tool streaming into As1 chunks then StreamPart[]", async () => {
    const events = [
      { type: "text-delta", text: "hel" },
      { type: "text-delta", textDelta: "lo" },
      { type: "reasoning-delta", text: "think" },
      { type: "tool-input-start", id: "c1", toolName: "lookup" },
      { type: "tool-input-delta", id: "c1", delta: "{\"q\"" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: "x" } },
      { type: "finish", finishReason: "tool-calls" },
    ];
    expect(as1ChunksFromOpenAiEvents(events)).toEqual([
      { type: "text", text: "hel" },
      { type: "text", text: "lo" },
      { type: "reasoning", text: "think" },
      { type: "tool-call-start", toolCallId: "c1", toolName: "lookup" },
      { type: "tool-call-delta", toolCallId: "c1", toolName: "lookup", argsTextDelta: "{\"q\"" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "x" } },
      { type: "finish", reason: "stop" },
    ]);
    const parts = await collectAs1Chunks((async function* () {
      for (const chunk of as1ChunksFromOpenAiEvents(events)) yield chunk;
    })(), new AbortController().signal);
    expect(parts).toEqual([
      { type: "text-delta", textDelta: "hel" },
      { type: "text-delta", textDelta: "lo" },
      { type: "reasoning", textDelta: "think" },
      { type: "tool-call-streaming-start", toolCallId: "c1", toolName: "lookup" },
      { type: "tool-call-delta", toolCallId: "c1", toolName: "lookup", argsTextDelta: "{\"q\"" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "x" } },
      { type: "finish", reason: "stop" },
    ]);
    expect(mapOpenAiStreamEvent({ type: "start-step" })).toBeNull();
  });

  test("never forwards provider error text; only the local model_error message leaves the mapper", () => {
    const opaque = "syncred_opaque_7c91";
    expect(sanitizeOpenAiError(new Error(`Bearer ${opaque} failed`))).toBe(
      "The configured model request failed. No fallback model was used.",
    );
    expect(sanitizeOpenAiError(opaque)).toBe("The configured model request failed. No fallback model was used.");
    expect(sanitizeOpenAiError(opaque)).not.toContain(opaque);
  });
});

describe("OpenAI ModeldDriver", () => {
  test("hardOff never networks; injected stream buffers S1 without spend", async () => {
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => {
        throw new Error("resolveApiKey must not run when streamEvents is injected");
      },
      hardOff: true,
    });
    await expect(driver.complete({
      pin, envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "s1", agentId: "agent-tom", signal: new AbortController().signal,
    })).rejects.toThrow(/openai-hard-off/);

    const streamed = createOpenAiModeldDriver({
      resolveApiKey: async () => "test-key",
      streamEvents: async function* () {
        yield { type: "text-delta", text: "ok" };
        yield { type: "finish", finishReason: "stop" };
      },
    });
    expect(await streamed.complete({
      pin, envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "s1", agentId: "agent-tom", signal: new AbortController().signal,
    })).toEqual([
      { type: "text-delta", textDelta: "ok" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("mock fetch selects chat vs responses paths and does not log secrets", async () => {
    const urls: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response("nope", { status: 401 });
    }) as typeof globalThis.fetch;
    const chat = createOpenAiModeldDriver({
      resolveApiKey: async () => "test-key",
      fetch,
    });
    const envelope = buildModelEnvelope([{ role: "user", content: "hi" }]);
    await chat.complete({
      pin, envelope, invocationId: "chat-1", agentId: "agent-tom", signal: new AbortController().signal,
    }).catch(() => undefined);
    expect(urls.some((url) => url.includes("/chat/completions"))).toBe(true);
    expect(JSON.stringify(urls)).not.toMatch(/test-key|sk-/);

    urls.length = 0;
    const responses = createOpenAiModeldDriver({
      resolveApiKey: async () => "test-key",
      fetch,
    });
    await responses.complete({
      pin: { ...pin, model: responsesModel },
      envelope, invocationId: "resp-1", agentId: "agent-tom", signal: new AbortController().signal,
    }).catch(() => undefined);
    expect(urls.some((url) => url.includes("/responses"))).toBe(true);
    expect(urls.some((url) => url.includes("/chat/completions"))).toBe(false);
  });

  test("live path forwards Host tool schemas without execute metadata", async () => {
    const bodies: string[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      bodies.push(await request.text());
      return new Response("nope", { status: 401 });
    }) as typeof globalThis.fetch;
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => TEST_KEY,
      fetch,
    });
    const envelope = buildModelEnvelope(
      [
        { role: "system", content: "you are grok with lookup" },
        { role: "user", content: "old ping" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: "x" } }] },
        { role: "user", content: "diag ping — reply with exactly: pong" },
      ],
      [{ name: "lookup", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
    );
    await driver.complete({
      pin, envelope, invocationId: "no-tools", agentId: "agent-tom", signal: new AbortController().signal,
    }).catch(() => undefined);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.join("\n");
    expect(body).toMatch(/lookup/);
    expect(body).toMatch(/diag ping/);
    expect(body).not.toMatch(/"execute"/);
  });

  test("reuses admission kernel; stub stays wrong-model; tools have no execute", async () => {
    let toolsSeen: unknown;
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => "test-key",
      streamEvents: async function* (call) {
        toolsSeen = call.envelope.tools;
        yield { type: "text-delta", text: "hi" };
        yield { type: "finish" };
      },
    });
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => openaiModels,
      credentialFingerprint: () => "c".repeat(64),
      driver,
    });
    try {
      const envelope = buildModelEnvelope(
        [{ role: "user", content: "hi" }],
        [{ name: "lookup", inputSchema: { type: "object", properties: {} } }],
      );
      expect(await kernel.admit(submitRequest(kernel, "openai-step", { envelope }))).toMatchObject({
        ok: true, dispatched: true, modelId: openaiModel.id,
        parts: [{ type: "text-delta", textDelta: "hi" }, { type: "finish", reason: "stop" }],
      });
      expect(toolsSeen).toEqual([{ name: "lookup", inputSchema: { type: "object", properties: {} } }]);
    } finally { kernel.stop(); }

    const stubKernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => ({ version: 1, models: { "stub/echo": STUB_ECHO_MODEL }, assignments: { main: "stub/echo", agents: {} } }),
      driver,
    });
    try {
      expect(await stubKernel.admit(submitRequest(stubKernel, "stub-blocked"))).toMatchObject({ ok: false, code: "wrong-model" });
    } finally { stubKernel.stop(); }
  });
});

describe("OpenAI SDK fence", () => {
  const sdkImport = /(?:from|import\(|require\()\s*["'](ai(?:\/[^"']*)?|@ai-sdk(?:\/[^"']*)?|openai(?:\/[^"']*)?)["']/;
  const srcDir = join(import.meta.dir, "../src");

  test("Host/preload/seam/session/hook and CLI stay SDK-free; openai driver is modeld-only", async () => {
    for (const file of ["preload.ts", "seam.ts", "session.ts", "hook.ts", "transform.ts", "modeld-as1.ts", "modeld-ipc.ts"]) {
      const text = await readFile(join(srcDir, file), "utf8");
      expect(text.match(sdkImport), file).toBeNull();
    }
    const openai = await readFile(join(srcDir, "modeld-openai.ts"), "utf8");
    expect(openai).toMatch(/from "ai"/);
    expect(openai).toMatch(/from "@ai-sdk\/openai"/);
    expect(openai).not.toMatch(/from "\.\/(preload|seam|hook|transform)\.ts"/);
    expect(openai).not.toMatch(/openai\.tools|ToolLoopAgent|maxSteps|execute:/);
    const ipc = await readFile(join(srcDir, "modeld-ipc.ts"), "utf8");
    expect(ipc).not.toContain("createOpenAiModeldDriver");
    expect(ipc).toContain("STUB_ECHO_MODEL_ID");

    const box = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(box.dependencies.ai).toBe("catalog:ai-sdk");
    expect(box.dependencies["@ai-sdk/openai"]).toBe("catalog:ai-sdk");
    const cli = JSON.parse(await readFile(join(import.meta.dir, "../../cli/package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(cli.dependencies?.ai).toBeUndefined();
    expect(cli.dependencies?.["@ai-sdk/openai"]).toBeUndefined();
    const root = JSON.parse(await readFile(join(import.meta.dir, "../../../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(root.dependencies?.ai).toBeUndefined();
    expect(root.dependencies?.["@ai-sdk/openai"]).toBeUndefined();
  });
});
