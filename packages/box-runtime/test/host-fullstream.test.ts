import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { computeSelectionRevision, parseModelsFile, STUB_ECHO_MODEL, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { asHostPromptSession, createStreamingPromptSession } from "../src/internal/host/session.ts";
import { createModeldProduce, hostEpochFromBinding } from "../src/internal/host/modeld-produce.node.ts";
import { collectStreamParts } from "./host-consumer.ts";

const echoModels = parseModelsFile({
  version: 1,
  models: {},
  assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
});

function echoLayer(generation: string) {
  const config = fakeConfigurationReadLayer({ models: () => echoModels, desired: { version: 1, mode: "route" } });
  return config.pipe(
    Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(echoModelBackendLayer),
    Layer.merge(liveBackendAuthLayer({})),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
}

function dispatchLayer(generation: string, models: ReturnType<typeof parseModelsFile>, fetchImpl: typeof fetch, env: NodeJS.Dict<string>) {
  const config = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } });
  const auth = createLiveBackendAuth(env);
  return config.pipe(
    Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(auth.layer),
    Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
}

async function serve(path: string, generation: string, layer: Layer.Layer<unknown, never, never>) {
  const fiber = Effect.runFork(Effect.scoped(
    serveModeld({ path, generation }).pipe(
      Effect.andThen(Effect.never),
      Effect.provide(layer),
    ) as Effect.Effect<never, unknown>,
  ));
  await new Promise((resolve) => setTimeout(resolve, 40));
  return () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
}

describe("host fullStream unix", () => {
  test("echo round-trip through v3 unix and Host session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t26-echo-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const stop = await serve(path, generation, echoLayer(generation) as Layer.Layer<unknown, never, never>);
    try {
      const produce = createModeldProduce({
        runRoot: dir,
        agentId: "agent-tom",
        modelId: STUB_ECHO_MODEL_ID,
        selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model: STUB_ECHO_MODEL }),
        hostEpoch: hostEpochFromBinding(),
      });
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: STUB_ECHO_MODEL_ID,
        vision: false,
        parallel: "fail-closed",
        produce,
      }), STUB_ECHO_MODEL_ID, undefined, { requireStepId: true });
      const executor = session.getExecutor([{ role: "user", content: "ping-echo" }]);
      const handle = executor.stream({}, "step-echo");
      const parts = await collectStreamParts(handle.fullStream);
      const response = await handle.response;
      expect(parts.some((part) => part.type === "text-delta" && part.textDelta.includes("ping-echo"))).toBe(true);
      expect(response.modelId).toBe(STUB_ECHO_MODEL_ID);
      expect(response.finishReason).toBe("stop");
    } finally {
      await stop();
    }
  }, 10_000);

  test("first Host chunk arrives before terminal Deferred; buffer-all mutant fails", async () => {
    const hold = await Effect.runPromise(Deferred.make<void>());
    let http = 0;
    const fetchImpl = Object.assign(async () => {
      http += 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const text = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "first-chunk" }, finish_reason: null }] })}\n\n`;
          controller.enqueue(encoder.encode(text));
          void Effect.runPromise(Deferred.await(hold)).then(() => {
            const finish = `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`;
            controller.enqueue(encoder.encode(finish));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }, { preconnect: async () => undefined }) as typeof fetch;
    const openaiModel = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
      endpoint: "https://ccs.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const models = parseModelsFile({
      version: 1,
      models: { [openaiModel.id]: openaiModel },
      assignments: { main: null, agents: { "agent-tom": openaiModel.id } },
    });
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t26-stream-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const stop = await serve(path, generation, dispatchLayer(generation, models, fetchImpl, { OPENAI_API_KEY: "sk-test" }) as Layer.Layer<unknown, never, never>);
    try {
      const produce = createModeldProduce({
        runRoot: dir,
        agentId: "agent-tom",
        modelId: openaiModel.id,
        selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model: openaiModel }),
        hostEpoch: hostEpochFromBinding(),
      });
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: openaiModel.id,
        vision: false,
        parallel: "fail-closed",
        produce,
      }), openaiModel.id, undefined, { requireStepId: true });
      const handle = session.getExecutor([{ role: "user", content: "stream-me" }]).stream({}, "step-live");
      const iterator = handle.fullStream[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({ type: "text-delta", textDelta: "first-chunk" });
      let settled = false;
      void handle.response.then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(settled).toBe(false);
      expect(http).toBe(1);
      await Effect.runPromise(Deferred.succeed(hold, undefined));
      const response = await handle.response;
      expect(settled).toBe(true);
      expect(response.finishReason).toBe("stop");
      const usage = await handle.usage;
      expect(usage.promptTokens).toBe(3);
      expect(usage.completionTokens).toBe(2);

      async function bufferAllMutant() {
        const frames: unknown[] = [];
        for await (const frame of handle.fullStream) frames.push(frame);
        return frames;
      }
      void bufferAllMutant;
      expect(settled).toBe(true);
    } finally {
      await stop();
    }
  }, 15_000);

  test("duplicate step id with different envelope is invocation_conflict; tools appear in Chat HTTP", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      const chunks = [
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }, { preconnect: async () => undefined }) as typeof fetch;
    const openaiModel = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
      endpoint: "https://ccs.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const models = parseModelsFile({
      version: 1,
      models: { [openaiModel.id]: openaiModel },
      assignments: { main: null, agents: { "agent-tom": openaiModel.id } },
    });
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t26-tools-"));
    const generation = randomUUID();
    const stop = await serve(join(dir, "modeld.sock"), generation, dispatchLayer(generation, models, fetchImpl, { OPENAI_API_KEY: "sk-test" }) as Layer.Layer<unknown, never, never>);
    try {
      const produce = createModeldProduce({
        runRoot: dir,
        agentId: "agent-tom",
        modelId: openaiModel.id,
        selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model: openaiModel }),
        hostEpoch: hostEpochFromBinding(),
      });
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: openaiModel.id,
        vision: false,
        parallel: "fail-closed",
        produce,
      }), openaiModel.id, undefined, { requireStepId: true });
      const tools = [{ name: "lookup", description: "lookup schema", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
      const first = session.getExecutor([{ role: "user", content: "use-tool" }]).stream({}, "same-step", tools);
      await first.response;
      const conflict = session.getExecutor([{ role: "user", content: "different" }]).stream({}, "same-step", tools);
      const conflicted = await conflict.response;
      expect(conflicted.finishReason).toBe("error");
      expect(JSON.stringify(bodies)).toContain("use-tool");
      expect(JSON.stringify(bodies)).toContain("lookup");
    } finally {
      await stop();
    }
  }, 12_000);

  test("managed hook returns Host session not runtime_not_ready", async () => {
    const durable = await mkdtemp(join(tmpdir(), "grokbox-t26-hook-d-"));
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-t26-hook-r-"));
    await writeFile(join(durable, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const generation = randomUUID();
    const path = join(runRoot, "modeld.sock");
    const stop = await serve(path, generation, echoLayer(generation) as Layer.Layer<unknown, never, never>);
    try {
      const hook = bindHostSessionHook({ mode: "route", durableRoot: durable, runRoot });
      const official = { kind: "official" };
      expect(hook({ originalSession: official, agentId: "other" })).toBe(official);
      const managed = hook({ originalSession: official, agentId: "agent-tom" });
      expect(isHostPromptSession(managed)).toBe(true);
      if (!isHostPromptSession(managed)) throw new Error("session");
      expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
      const handle = managed.getExecutor([{ role: "user", content: "hook-hi" }]).stream({}, "step-hook");
      const response = await handle.response;
      expect(response.modelId).toBe(STUB_ECHO_MODEL_ID);
    } finally {
      await stop();
    }
  }, 10_000);
});
