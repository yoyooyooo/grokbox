import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { computeSelectionRevision, parseModelsFile, STUB_ECHO_MODEL, STUB_ECHO_MODEL_ID, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { admitAllAuthorityLayer, startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { asHostPromptSession, createStreamingPromptSession } from "../src/internal/host/session.ts";
import { createModeldProduce } from "../src/internal/host/modeld-produce.node.ts";
import { bindCompiledHost, type HostBinding } from "../src/internal/host/host-binding.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";
import { hostEventsPath } from "../src/internal/host/terminal-journal.node.ts";
import { collectStreamParts } from "./host-consumer.ts";

const HEX = (ch: string) => ch.repeat(64);
const TEST_BINDING: HostBinding = {
  generationId: HEX("a"),
  activationId: "op-1",
  pid: 1,
  start: 1,
  sourceSha: HEX("b"),
  identitySha: HEX("c"),
};
const ROOT = {
  profileId: "t21-independent-root",
  abiIdentity: "host-abi-v1",
  independentRoot: "root-from-host",
  bridgeDigest: HEX("d"),
};
const echoModels = parseModelsFile({
  version: 1,
  models: {},
  assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
});

const TEST_COMPILE = {
  profileId: "patch-profile",
  profileSha256: HEX("e"),
  sourceSha256: HEX("b"),
  transformedSha256: HEX("d"),
};

const PRODUCTION_COMPILE = { profileId: "p", profileSha256: HEX("e"), sourceSha256: HEX("e"), transformedSha256: HEX("e") };
const PRODUCTION_IDENTITY = { pid: process.pid, uid: 1, ppid: 1, start: 1, exe: "/bin/test", cmdline: ["node"], ancestry: [1] };
const PRODUCTION_BINDING = bindCompiledHost(PRODUCTION_IDENTITY, "op-1", PRODUCTION_COMPILE);

function produceFor(runRoot: string, turnId: string, model: ModelRecord = STUB_ECHO_MODEL, binding = TEST_BINDING, bridgeDigest = ROOT.bridgeDigest) {
  return createModeldProduce({
    runRoot,
    agentId: "agent-tom",
    modelId: model.id,
    selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model }),
    binding,
    bridgeDigest,
    turnId,
    profileId: ROOT.profileId,
    abiIdentity: ROOT.abiIdentity,
    independentRoot: ROOT.independentRoot,
  }).produce;
}

async function waitReady(runRoot: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 2_000) {
    if (await probeModeldHealth(runRoot, 200)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("modeld not ready");
}

async function waitJournal(runRoot: string, match: (text: string) => boolean): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 1_000) {
    const text = await readFile(hostEventsPath(runRoot), "utf8").catch(() => "");
    if (match(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return await readFile(hostEventsPath(runRoot), "utf8").catch(() => "");
}

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
  await waitReady(join(path, ".."));
  return () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
}

describe("host fullStream unix", () => {
  test("echo round-trip through v3 unix and Host session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t26-echo-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const stop = await serve(path, generation, echoLayer(generation) as Layer.Layer<unknown, never, never>);
    try {
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: STUB_ECHO_MODEL_ID,
        vision: false,
        parallel: "fail-closed",
        produce: produceFor(dir, "HOST_TURN_ECHO"),
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
      contextWindowTokens: 200000,
    };
    const durable = await mkdtemp(join(tmpdir(), "grokbox-t26-stream-d-"));
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-t26-stream-r-"));
    await writeFile(join(durable, "models.json"), `${JSON.stringify({
      version: 1,
      models: { [openaiModel.id]: openaiModel },
      assignments: { main: null, agents: { "agent-tom": openaiModel.id } },
    })}\n`);
    await mkdir(join(durable, "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(durable, "config.json"), JSON.stringify({ schemaVersion: 2, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
    const sha = HEX("e");
    await writeAttestation(runRoot, {
      mode: "route",
      coverage: "attested",
      modeld: true,
      diskSha: sha,
      pid: process.pid,
      start: 1,
      identity: { pid: process.pid, uid: 1, ppid: 1, start: 1, exe: "/bin/test", cmdline: ["node"], ancestry: [1] },
      at: new Date().toISOString(),
      profileId: "p",
      transformedSha: sha,
      operationId: "op-1",
      launchMode: "direct-launch",
      compile: { profileId: "p", profileSha256: sha, sourceSha256: sha, transformedSha256: sha },
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    const started = await startModeldProcess({ durableRoot: durable, runRoot, env: { OPENAI_API_KEY: "sk-test" }, ownershipRead: ownedOwnershipReader(process.pid) });
    await waitReady(runRoot);
    try {
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: openaiModel.id,
        vision: false,
        parallel: "fail-closed",
        produce: produceFor(runRoot, "HOST_TURN_STREAM", openaiModel, PRODUCTION_BINDING, PRODUCTION_COMPILE.transformedSha256),
      }), openaiModel.id, undefined, { requireStepId: true, contextWindowTokens: 200000 });
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
    } finally {
      globalThis.fetch = previousFetch;
      await started.stop();
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
      contextWindowTokens: 200000,
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
      const session = asHostPromptSession(createStreamingPromptSession({
        modelId: openaiModel.id,
        vision: false,
        parallel: "fail-closed",
        produce: produceFor(dir, "HOST_TURN_TOOLS", openaiModel),
      }), openaiModel.id, undefined, { requireStepId: true, contextWindowTokens: 200000 });
      const tools = [{ name: "lookup", description: "lookup schema", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
      const first = session.getExecutor([{ role: "user", content: "use-tool" }]).stream({}, "same-step", tools);
      await first.response;
      const conflict = session.getExecutor([{ role: "user", content: "different" }]).stream({}, "same-step", tools);
      await expect(conflict.response).rejects.toMatchObject({ name: "RetriableError" });
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
      const hook = bindHostSessionHook({
        mode: "route", durableRoot: durable, runRoot, binding: TEST_BINDING, compile: TEST_COMPILE,
      });
      const official = { kind: "official" };
      expect(hook({ originalSession: official, agentId: "other" })).toBe(official);
      let notified = 0;
      const managed = hook({
        originalSession: official,
        agentId: "agent-tom",
        onRequestId: () => { notified += 1; },
        sessionOptions: { invocationId: "HOST_TURN_HOOK" },
      });
      expect(isHostPromptSession(managed)).toBe(true);
      if (!isHostPromptSession(managed)) throw new Error("session");
      expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
      const handle = managed.getExecutor([
        { role: "system", content: "state-root-once" },
        { role: "user", content: "hook-hi" },
      ]).stream({}, "step-hook");
      const response = await handle.response;
      expect(response.modelId).toBe(STUB_ECHO_MODEL_ID);
      expect(notified).toBe(1);
      const journal = await waitJournal(runRoot, (text) => text.includes("host_normalized_terminal"));
      expect(journal).toContain("host_normalized_terminal");
      expect(journal).toContain("HOST_TURN_HOOK");
      expect(journal).not.toContain("host-step");
      expect(journal).not.toContain("turn_seam_terminal");

      const missingTurn = hook({ originalSession: official, agentId: "agent-tom" });
      if (!isHostPromptSession(missingTurn)) throw new Error("session");
      const refused = missingTurn.getExecutor([{ role: "user", content: "no-turn" }]).stream({}, "step-x");
      await expect(refused.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    } finally {
      await stop();
    }
  }, 10_000);

  test("two Host TURNs bind independently; missing root does not invent fixture text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t26-turns-"));
    const generation = randomUUID();
    const stop = await serve(join(dir, "modeld.sock"), generation, echoLayer(generation) as Layer.Layer<unknown, never, never>);
    try {
      const sessionA = asHostPromptSession(createStreamingPromptSession({
        modelId: STUB_ECHO_MODEL_ID, vision: false, parallel: "fail-closed",
        produce: produceFor(dir, "HOST_TURN_A"),
      }), STUB_ECHO_MODEL_ID, undefined, { requireStepId: true });
      const sessionB = asHostPromptSession(createStreamingPromptSession({
        modelId: STUB_ECHO_MODEL_ID, vision: false, parallel: "fail-closed",
        produce: produceFor(dir, "HOST_TURN_B"),
      }), STUB_ECHO_MODEL_ID, undefined, { requireStepId: true });
      const a = await sessionA.getExecutor([{ role: "user", content: "turn-a" }]).stream({}, "step-a").response;
      const b = await sessionB.getExecutor([{ role: "user", content: "turn-b" }]).stream({}, "step-b").response;
      expect(a.finishReason).toBe("stop");
      expect(b.finishReason).toBe("stop");

      const noRoot = createModeldProduce({
        runRoot: dir,
        agentId: "agent-tom",
        modelId: STUB_ECHO_MODEL_ID,
        selectionRevision: computeSelectionRevision({ agentId: "agent-tom", model: STUB_ECHO_MODEL }),
        binding: TEST_BINDING,
        bridgeDigest: ROOT.bridgeDigest,
        turnId: "HOST_TURN_NOROOT",
      }).produce;
      const missing = asHostPromptSession(createStreamingPromptSession({
        modelId: STUB_ECHO_MODEL_ID, vision: false, parallel: "fail-closed", produce: noRoot,
      }), STUB_ECHO_MODEL_ID, undefined, { requireStepId: true });
      const denied = missing.getExecutor([{ role: "user", content: "no-root" }]).stream({}, "step-noroot");
      await expect(denied.response).rejects.toMatchObject({ name: "RetriableError" });
    } finally {
      await stop();
    }
  }, 10_000);

  test("production root + ready barrier + Host consumer + missing STEP writes J13 rejection", async () => {
    const durable = await mkdtemp(join(tmpdir(), "grokbox-t26-prod-d-"));
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-t26-prod-r-"));
    await writeFile(join(durable, "models.json"), `${JSON.stringify({
      version: 1, models: {}, assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    await mkdir(join(durable, "state"), { recursive: true, mode: 0o700 });
    await writeFile(join(durable, "config.json"), JSON.stringify({ schemaVersion: 2, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route" } }), { mode: 0o600 });
    const sha = HEX("e");
    await writeAttestation(runRoot, {
      mode: "route",
      coverage: "attested",
      modeld: true,
      diskSha: sha,
      pid: process.pid,
      start: 1,
      identity: { pid: process.pid, uid: 1, ppid: 1, start: 1, exe: "/bin/test", cmdline: ["node"], ancestry: [1] },
      at: new Date().toISOString(),
      profileId: "p",
      transformedSha: sha,
      operationId: "op-1",
      launchMode: "direct-launch",
      compile: { profileId: "p", profileSha256: sha, sourceSha256: sha, transformedSha256: sha },
    });
    const started = await startModeldProcess({ durableRoot: durable, runRoot, env: {}, ownershipRead: ownedOwnershipReader(process.pid) });
    await waitReady(runRoot);
    try {
      const hook = bindHostSessionHook({
        mode: "route", durableRoot: durable, runRoot, binding: PRODUCTION_BINDING, compile: PRODUCTION_COMPILE,
      });
      const managed = hook({
        originalSession: { kind: "official" },
        agentId: "agent-tom",
        sessionOptions: { invocationId: "HOST_TURN_PROD" },
      });
      if (!isHostPromptSession(managed)) throw new Error("session");
      const missing = managed.getExecutor([
        { role: "system", content: "state-root-once" },
        { role: "user", content: "x" },
      ]).stream({});
      await expect(missing.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
      const journal = await waitJournal(runRoot, (text) => text.includes("host_stream_rejected"));
      const rows = journal.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { name?: string; reason?: string; turnId?: string });
      expect(rows.some((row) => row.name === "host_stream_rejected" && row.reason === "missing-step-id" && row.turnId === "HOST_TURN_PROD")).toBe(true);
      const ok = await managed.getExecutor([
        { role: "system", content: "state-root-once" },
        { role: "user", content: "prod-hi" },
      ]).stream({}, "J13_REAL_STEP").response;
      expect(ok.finishReason).toBe("stop");
      const observed = await waitJournal(runRoot, (text) => text.includes('"stage":"first_chunk"'));
      const stages = observed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stage?: string; stepId?: string });
      expect(stages.filter((row) => row.stage === "first_chunk" && row.stepId === "J13_REAL_STEP")).toHaveLength(1);
      expect(stages.some((row) => row.stage === "stream_enter" && row.stepId === "J13_REAL_STEP")).toBe(true);
      const image = managed.getExecutor([
        { role: "system", content: "state-root-once" },
        { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
      ]).stream({}, "STEP_UNSUPPORTED_IMAGE");
      await expect(image.response).rejects.toMatchObject({ name: "RetriableError", code: "unsupported_image" });
      const after = await waitJournal(runRoot, (text) => text.includes("STEP_UNSUPPORTED_IMAGE"));
      expect(after).toContain("STEP_UNSUPPORTED_IMAGE");
      const stepRows = after.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { stepId?: string; name?: string });
      expect(stepRows.filter((row) => row.name === "host_normalized_terminal" && row.stepId === "J13_REAL_STEP")).toHaveLength(1);
      expect(stepRows.some((row) => row.stepId === "STEP_UNSUPPORTED_IMAGE")).toBe(true);
    } finally {
      await started.stop();
    }
  }, 12_000);
});
