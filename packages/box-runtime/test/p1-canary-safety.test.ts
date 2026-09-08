import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModelEnvelope } from "../src/envelope.ts";
import { sha256Text } from "../src/hash.ts";
import { createModeld } from "../src/modeld.ts";
import {
  as1ChunksFromOpenAiEvents,
  createOpenAiModeldDriver,
  OPENAI_LOCAL_ERROR_MESSAGES,
} from "../src/modeld-openai.ts";
import { createDefaultModeldDriver } from "../src/modeld-default.ts";
import { materializeApiKeyRef } from "../src/modeld-credentials.ts";
import { callStubModeld, startStubModeldServer } from "../src/modeld-ipc.ts";
import { loadModelsFileSync, type ModelsFile } from "../src/models.ts";
import { bindHostSessionHook, createSessionSeam, createStubRouteDriver } from "../src/seam.ts";
import type { HostPromptSession, PromptSession } from "../src/session.ts";
import { FAKE_BINDING, fakeModels, modeldFixture, submitRequest } from "./modeld-fixture.ts";
import { within } from "./scripted-stream.ts";

const GROK_BOT = "00000000-0000-4000-8000-000000000114";
const SYNTHETIC_CREDENTIAL = "syncred_opaque_7c91";
const TEST_KEY = "test-key";
const FIFO_BOUND_MS = 250;

const openaiA = {
  id: "openai/model-a",
  provider: "openai",
  model: "model-a",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};
const openaiB = { ...openaiA, id: "openai/model-b", model: "model-b" };
const openaiModels: ModelsFile = {
  version: 1,
  models: { [openaiA.id]: openaiA },
  assignments: { main: openaiA.id, agents: {} },
};

function officialOff(): PromptSession {
  return { stream() { throw new Error("official session must not run"); } };
}

function mkfifo(path: string): void {
  const result = spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

describe("P1 streamed tool names", () => {
  test("start+delta correlate toolName by toolCallId and never invent tool", async () => {
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => TEST_KEY,
      streamEvents: async function* () {
        yield { type: "tool-input-start", id: "c1", toolName: "lookup" };
        yield { type: "tool-input-delta", id: "c1", delta: "{\"q\":1}" };
        yield { type: "tool-call", toolCallId: "c1", toolName: "lookup", input: { q: 1 } };
        yield { type: "finish", finishReason: "tool-calls" };
      },
    });
    const parts = await driver.complete({
      pin: {
        model: openaiA,
        assignment: "agent",
        fingerprint: "a".repeat(64),
        credentialFingerprint: sha256Text(TEST_KEY),
      },
      envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "step-tool",
      agentId: GROK_BOT,
      signal: new AbortController().signal,
    });
    expect(parts).toEqual([
      { type: "tool-call-streaming-start", toolCallId: "c1", toolName: "lookup" },
      { type: "tool-call-delta", toolCallId: "c1", toolName: "lookup", argsTextDelta: "{\"q\":1}" },
      { type: "tool-call", toolCallId: "c1", toolName: "lookup", args: { q: 1 } },
      { type: "finish", reason: "stop" },
    ]);
    expect(JSON.stringify(parts)).not.toMatch(/"toolName":"tool"/);
  });

  test("unknown toolCallId correlation is invalid_stream, not a fake tool name", () => {
    const chunks = as1ChunksFromOpenAiEvents([
      { type: "tool-input-delta", id: "c1", delta: "{\"q\":1}" },
    ]);
    expect(chunks[0]).toEqual({
      type: "error",
      code: "invalid_stream",
      message: OPENAI_LOCAL_ERROR_MESSAGES.invalid_stream,
    });
    expect(JSON.stringify(chunks)).not.toMatch(/"toolName":"tool"/);
  });
});

describe("P1 opaque provider errors stay off Unix IPC", () => {
  test("injected and live 401 bodies never appear in admit/IPC payloads", async () => {
    const driver = createOpenAiModeldDriver({
      resolveApiKey: async () => TEST_KEY,
      streamEvents: async function* () {
        yield { type: "error", error: `401 ${SYNTHETIC_CREDENTIAL}` };
      },
    });
    const parts = await driver.complete({
      pin: {
        model: openaiA,
        assignment: "main",
        fingerprint: "a".repeat(64),
        credentialFingerprint: sha256Text(TEST_KEY),
      },
      envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      invocationId: "err-parts",
      agentId: GROK_BOT,
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(parts)).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(parts.some((part) => part.type === "error" && part.error.message === OPENAI_LOCAL_ERROR_MESSAGES.model_error)).toBe(true);

    const f = await modeldFixture();
    await f.store.saveModels(openaiModels);
    const env = { OPENAI_API_KEY: "offline-ipc-key" };
    const server = await startStubModeldServer({
      ...f,
      durableRoot: f.durable,
      defaultDriver: {
        env,
        fetch: (async () => new Response(`unauthorized ${SYNTHETIC_CREDENTIAL}`, { status: 401 })) as typeof fetch,
      },
    });
    try {
      const reply = await callStubModeld(f.runRoot, submitRequest(server, "opaque-ipc"));
      const encoded = JSON.stringify(reply);
      expect(encoded).not.toContain(SYNTHETIC_CREDENTIAL);
      expect(encoded).not.toContain("offline-ipc-key");
      expect(encoded).not.toMatch(/sk-|Bearer /);
      if (typeof reply === "object" && reply && "ok" in reply && reply.ok === true && "parts" in reply) {
        expect(encoded).toContain(OPENAI_LOCAL_ERROR_MESSAGES.model_error);
      }
    } finally {
      await server.stop();
    }
  });
});

describe("P1 pin fingerprint vs materialized key", () => {
  test("rotation between pin and materialization causes zero fetch and no secret in the managed error", async () => {
    const env = { OPENAI_API_KEY: "offline-pin-key" };
    let fetches = 0;
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => openaiModels,
      credentialFingerprint: async () => {
        const fingerprint = sha256Text("offline-pin-key");
        env.OPENAI_API_KEY = "offline-rotated-key";
        return fingerprint;
      },
      driver: createDefaultModeldDriver({
        env,
        fetch: (async () => {
          fetches += 1;
          return new Response("nope", { status: 401 });
        }) as typeof fetch,
      }),
    });
    try {
      const result = await kernel.admit(submitRequest(kernel, "rotated"));
      expect(result).toMatchObject({ ok: false, code: "driver-failed", userVisible: true });
      expect(fetches).toBe(0);
      expect(JSON.stringify(result)).not.toContain("offline-pin-key");
      expect(JSON.stringify(result)).not.toContain("offline-rotated-key");
    } finally {
      kernel.stop();
    }
  });
});

describe("P1 FIFO-safe bounded opens", () => {
  test("models.json FIFO returns null within the bound and does not hang the hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-models-fifo-"));
    mkfifo(join(root, "models.json"));
    const started = Date.now();
    const file = loadModelsFileSync(root);
    expect(Date.now() - started).toBeLessThan(FIFO_BOUND_MS);
    expect(file).toBeNull();

    const f = await modeldFixture();
    const official = officialOff();
    const hook = bindHostSessionHook({
      mode: "route", durableRoot: root, runRoot: f.runRoot, binding: FAKE_BINDING,
    });
    const hookStarted = Date.now();
    expect(hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-fifo", inferenceReason: "main" },
    })).toBe(official);
    expect(Date.now() - hookStarted).toBeLessThan(FIFO_BOUND_MS);
  });

  test("credential FIFO fails or cancels within the bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-cred-fifo-"));
    const fifo = join(dir, "key");
    mkfifo(fifo);
    const failed = await within(materializeApiKeyRef(`file:${fifo}`, {}).then(
      () => "unexpected-success",
      (error: unknown) => error,
    ), FIFO_BOUND_MS);
    expect(failed).not.toBe("unexpected-success");

    const ac = new AbortController();
    const pending = materializeApiKeyRef(`file:${fifo}`, {}, ac.signal).then(
      () => "unexpected-success" as const,
      (error: unknown) => error,
    );
    ac.abort();
    const cancelled = await within(pending, FIFO_BOUND_MS);
    expect(cancelled).not.toBe("unexpected-success");
  });
});

describe("P1 first ModelPin for the whole turn", () => {
  test("two sequential steps stay on A after assignment changes to B", async () => {
    let file = fakeModels();
    const seen: string[] = [];
    const kernel = createModeld({
      authority: () => ({ state: "committed", host: FAKE_BINDING }),
      loadModels: () => file,
      credentialFingerprint: () => sha256Text("offline"),
      driver: {
        accepts: () => true,
        complete: ({ pin }) => {
          seen.push(pin.model.id);
          return [{ type: "text-delta", textDelta: pin.model.id }, { type: "finish", reason: "stop" }];
        },
      },
    });
    try {
      const first = await kernel.admit(submitRequest(kernel, "s1", { turnId: "turn-keep" }));
      expect(first).toMatchObject({ ok: true, dispatched: true, modelId: "fake/smart" });
      file = {
        ...file,
        assignments: { main: "fake/fast", agents: { "agent-tom": "fake/fast" } },
      };
      const second = await kernel.admit(submitRequest(kernel, "s2", { turnId: "turn-keep" }));
      expect(second).toMatchObject({ ok: true, dispatched: true, modelId: "fake/smart" });
      expect(seen).toEqual(["fake/smart", "fake/smart"]);
      expect(JSON.stringify([first, second])).not.toContain("fake/fast");
    } finally {
      kernel.stop();
    }
  });

  test("Unix/Host two steps remain on A after reassignment; mismatch never reports B as A", async () => {
    const f = await modeldFixture();
    const catalog: ModelsFile = {
      version: 1,
      models: { [openaiA.id]: openaiA, [openaiB.id]: openaiB },
      assignments: { main: null, agents: { [GROK_BOT]: openaiA.id } },
    };
    await f.store.saveModels(catalog);
    const seen: string[] = [];
    const server = await startStubModeldServer({
      ...f,
      durableRoot: f.durable,
      ports: { credentialFingerprint: () => sha256Text("offline") },
      driver: {
        accepts: (model) => model.provider === "openai",
        complete: ({ pin }) => {
          seen.push(pin.model.id);
          return [{ type: "text-delta", textDelta: pin.model.id }, { type: "finish", reason: "stop" }];
        },
      },
    });
    try {
      const official = officialOff();
      const hook = bindHostSessionHook({
        mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING,
      });
      const session = hook({
        originalSession: official, agentId: GROK_BOT,
        sessionOptions: { invocationId: "turn-keep-host", inferenceReason: "main" },
      }) as HostPromptSession;
      expect(session).not.toBe(official);
      const first = await session.getExecutor([]).stream({}, "step-a").response;
      expect(first.error).toBeUndefined();
      expect(first.modelId).toBe(openaiA.id);
      expect(JSON.stringify(first.messages)).toContain(openaiA.id);

      await f.store.saveModels({
        ...catalog,
        assignments: { main: null, agents: { [GROK_BOT]: openaiB.id } },
      });
      const second = await session.getExecutor([]).stream({}, "step-b").response;
      expect(second.error).toBeUndefined();
      expect(second.modelId).toBe(openaiA.id);
      expect(JSON.stringify(second.messages)).toContain(openaiA.id);
      expect(seen).toEqual([openaiA.id, openaiA.id]);
      expect(JSON.stringify([first, second])).not.toContain(openaiB.id);
    } finally {
      await server.stop();
    }

    const dir = (await modeldFixture()).durable;
    const driver = createStubRouteDriver([]);
    driver.submit = async () => ({
      dispatched: true,
      assignment: "agent",
      modelId: openaiB.id,
      parts: [{ type: "text-delta", textDelta: "from-b" }, { type: "finish", reason: "stop" }],
    });
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "agent", modelId: openaiA.id, driver, now: () => "2026-01-01T00:00:00.000Z",
    });
    const official = officialOff();
    const session = seam.hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-mismatch", inferenceReason: "main" },
    }) as HostPromptSession;
    const mismatched = await session.getExecutor([]).stream({}, "step-mismatch").response;
    expect(mismatched.error).toMatchObject({
      userVisible: true, agentId: GROK_BOT, invocationId: "step-mismatch", stage: "normalize", code: "model_error",
    });
    expect(mismatched.modelId).toBe(openaiA.id);
    expect(JSON.stringify(mismatched)).not.toContain("from-b");
    expect(driver.officialCalls).toBe(0);
  });
});
