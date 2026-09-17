import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeAdmissionAuthorityLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { sameConnectionHostCompactLayer } from "../src/internal/modeld/same-connection-compact.ts";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { bindHostCompactHook, isHostManagedRootActive, resetHostCompactSlotForTests, stateSystemCompactHookOptions } from "../src/internal/host/compact.ts";
import { HOST_COMPACT_SYMBOL, HOST_MANAGED_STEP_SYMBOL, transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { decodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";

// Owned native-order fixture. Only public interoperability anchors are shared with
// LIVE_SLICE_PATCHES. It does not execute a real Host or copy native summary policy.
const SOURCE = `
var requestIdKey = "turn";
function __addDisposableResource23(env, value) { env.stack.push(value); }
module.exports = async function run(input) {
  const env_2 = { stack: [] };
  const ctx = input.ctx;
  const stateHandler = input.stateHandler;
  const rootPromptExecutor = input.root;
  const requestContext = {};
  const invocationId = input.stepId;
  const startBackgroundSummary = async () => { input.observed.background++; };
  try {
    let result;
        result = rootPromptExecutor.executeToolStream(
          ctx
        );
        await startBackgroundSummary();
    let stepClosed = false;
      const responseSummaryLaunch = result.extendedUsage.then((currentUsage) => {
        input.observed.responseSummary++;
        return currentUsage;
      });
      let response, extendedUsage, usage, finalInvocationId;
      const consumed = (async () => {
        for await (const part of result.fullStream) input.parts.push(part);
      })();
        [response, extendedUsage, usage, finalInvocationId] = await Promise.all([
          result.response, result.extendedUsage, result.usage, result.invocationId,
          responseSummaryLaunch, consumed
        ]);
    stepClosed = true;
    return response;
  } finally {
    for (const resource of env_2.stack.reverse()) resource[Symbol.dispose]();
  }
};
`;

const AGENT = "owned-pipeline-agent";
const MODEL = "openai/owned-model";
const SYSTEM = "A synthetic Host root. Preserve the supplied fact.";
const TOOLS = [{ name: "owned_lookup", description: "Read the owned test fact", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
const OPTIONS = { temperature: 0.2, maxTokens: 512 };
const LONG_INPUT = `FACT=alpine-41; ${"synthetic history ".repeat(400)}`;
const SUMMARY = "FACT=alpine-41; retained by the owned Host summary fixture";
const hex = (ch: string) => ch.repeat(64);

function sseAnswer() {
  const rows = [
    { id: "owned-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "alpine-41" }, finish_reason: null }] },
    { id: "owned-response", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 32, completion_tokens: 4, total_tokens: 36 } },
  ];
  return new Response(`${rows.map((row) => `data: ${JSON.stringify(row)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

for (const errorStatus of [400, 401] as const) {
  test(`actual Host client + Unix/kernel + SDK ${errorStatus}: native-order recovery does not manufacture a resume`, async () => {
    resetHostCompactSlotForTests();
    const TURN = `owned-pipeline-turn-${errorStatus}`;
    const STEP = `owned-pipeline-step-${errorStatus}`;
    const dir = await mkdtemp(join(tmpdir(), "gbox-compact-pipeline-"));
    const runRoot = join(dir, "run");
    const durableRoot = join(dir, "durable");
    await mkdir(durableRoot);
    const models = parseModelsFile({
      version: 1,
      models: { [MODEL]: {
        provider: "openai", model: "owned-model", endpoint: "https://compact-fixture.invalid/v1",
        apiKeyRef: "env:OWNED_TEST_KEY", capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"], contextWindowTokens: 200000,
      } },
      assignments: { main: null, agents: { [AGENT]: MODEL } },
    });
    await writeFile(join(durableRoot, "models.json"), JSON.stringify(models), { mode: 0o600 });
    const requests: Array<Record<string, unknown>> = [];
    const incomingFrames: Array<Record<string, unknown>> = [];
    const observed = { compact: 0, background: 0, responseSummary: 0, terminal: 0 };
    const fetchImpl = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe("https://compact-fixture.invalid/v1/chat/completions");
      if (url !== "https://compact-fixture.invalid/v1/chat/completions") throw new Error("external_network_forbidden");
      if (typeof init?.body !== "string") throw new Error("expected_sdk_encoded_request");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: "owned structured rejection" } }), {
          status: errorStatus, headers: { "content-type": "application/json" },
        });
      }
      // The Fake only succeeds after receiving the correct Host-generated snapshot
      // via the actual resume frame and actual SDK encoder, not a canned client reply.
      expect(body.messages).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: SUMMARY }]);
      expect(body.model).toBe("owned-model");
      // Compact replaces the Host window, never the already admitted STEP's tools/options.
      expect(body.tools).toEqual(requests[0]?.tools);
      expect(body.tools).toHaveLength(1);
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(512);
      expect(body.parallel_tool_calls).toBe(false);
      return sseAnswer();
    }, { preconnect: async () => undefined }) as typeof fetch;
    const generation = randomUUID();
    const auth = createLiveBackendAuth({ OWNED_TEST_KEY: "owned-noncredential" });
    const layer = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } }).pipe(
      Layer.merge(fakeAdmissionAuthorityLayer()), Layer.merge(auth.layer),
      Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const ready = await Effect.runPromise(Deferred.make<void>());
    const terminalRecorded = await Effect.runPromise(Deferred.make<void>());
    const resources = emptyResourceCounts();
    const fiber = Effect.runFork(Effect.scoped(serveModeld({
      path: join(runRoot, "modeld.sock"), generation, counts: resources,
      compactForIncoming: (incoming) => sameConnectionHostCompactLayer(incoming),
      observeStep: () => Effect.gen(function* () {
        observed.terminal++;
        yield* Deferred.succeed(terminalRecorded, undefined);
      }),
    }).pipe(Effect.tap((listening) => Effect.sync(() => {
      listening.server.on("connection", (socket) => {
        let buffered = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          for (;;) {
            const next = decodeModeldFrame(buffered);
            if (!next || "error" in next) return;
            buffered = Buffer.from(next.rest);
            if (next.value && typeof next.value === "object") incomingFrames.push(next.value as Record<string, unknown>);
          }
        });
      });
    })), Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never), Effect.provide(layer))) as Effect.Effect<never, unknown>);
    try {
      await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("2 seconds")));
      const session = bindHostSessionHook({
        mode: "route", durableRoot, runRoot,
        binding: { generationId: hex("a"), activationId: "owned-op", pid: 1, start: 1, sourceSha: hex("b"), identitySha: hex("c") },
        compile: { profileId: "t21-state-root", profileSha256: hex("e"), sourceSha256: hex("b"), transformedSha256: hex("d") },
      })({ agentId: AGENT, sessionOptions: { agentId: AGENT, invocationId: TURN }, originalSession: {
        getExecutor() { throw new Error("official_main_fallback_forbidden"); },
      } });
      if (!isHostPromptSession(session)) throw new Error("managed_session_missing");
      expect(session.getModelId()).toBe(MODEL);
      const executor = session.getExecutor([{ role: "system", content: SYSTEM }, { role: "user", content: LONG_INPUT }]);
      const root = {
        getState: () => executor.getState(), getMessages: () => executor.getMessages(),
        clearMessages: () => executor.clearMessages(),
        appendMessages: (messages: unknown[]) => executor.appendMessages(messages),
        executeToolStream: (ctx: unknown) => executor.stream(ctx, STEP, TOOLS, OPTIONS),
      };
      const stateHandler = { backgroundSummarizationPromiseInfo: null, lastStepInvocationId: STEP };
      const applied = transformUnchecked(SOURCE, LIVE_SLICE_PATCHES.filter((slice) => slice.id.startsWith("compact-")));
      if (!applied.ok) throw new Error(`owned_fixture_patch_failed: ${applied.code}`);
      const module = { exports: undefined as unknown as (input: unknown) => Promise<unknown> };
      runInContext(applied.source, createContext({ module, Symbol, fromRedactedCoreMessages: (value: unknown) => value,
        PrivacyCapability: { UNSAFE_ALWAYS_ALLOWED: "owned-test" }, globalThis: {
        [Symbol.for(HOST_COMPACT_SYMBOL)]: bindHostCompactHook(stateSystemCompactHookOptions()),
        [Symbol.for(HOST_MANAGED_STEP_SYMBOL)]: isHostManagedRootActive,
      } }));
      const parts: unknown[] = [];
      const owner = {
        config: { conversationGroupId: AGENT }, interactionListener: {}, resourceAccessor: {},
        orchestrator: { async handleSummarization(_ctx: unknown, _state: unknown, guarded: typeof root) {
          observed.compact++;
          expect(requests).toHaveLength(1);
          expect(guarded.getMessages()).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: LONG_INPUT }]);
          guarded.clearMessages();
          guarded.appendMessages([
            { role: "system", content: SYSTEM },
            { role: "user", content: SUMMARY, providerOptions: { host: { isSummary: true } }, id: "summary-carrier" },
          ]);
          return SUMMARY;
        } },
      };
      const running = module.exports.call(owner, { root, stateHandler, observed, parts, stepId: STEP, ctx: { get: () => TURN, signal: { aborted: false } } });
      if (errorStatus === 400) {
        const response = await running as { modelId: string; finishReason: string };
        expect(response.modelId).toBe(MODEL);
        expect(response.finishReason).toBe("stop");
        expect(requests).toHaveLength(2);
        expect(observed.compact).toBe(1);
        expect(root.getState()).toEqual([
          { role: "system", content: SYSTEM },
          { role: "user", content: SUMMARY, providerOptions: { host: { isSummary: true } }, id: "summary-carrier" },
        ]);
        const resumes = incomingFrames.filter((frame) => frame.method === "resume-step");
        expect(resumes).toHaveLength(1);
        expect(resumes[0]).toMatchObject({ agentId: AGENT, turnId: TURN, stepId: STEP });
        expect(parts.some((part) => part !== null && typeof part === "object" && "type" in part && part.type === "text-delta"
          && "textDelta" in part && part.textDelta === "alpine-41")).toBe(true);
      } else {
        let rejected: unknown;
        try { await running; } catch (error) { rejected = error; }
        expect(rejected).toBeDefined();
        if (requests.length === 0) throw new Error(`owned fixture did not reach SDK: ${rejected instanceof Error ? rejected.message : "unknown"}; methods=${incomingFrames.map((frame) => frame.method).join(",")}`);
        expect(requests).toHaveLength(1);
        expect(observed.compact).toBe(0);
        expect(incomingFrames.filter((frame) => frame.method === "resume-step")).toHaveLength(0);
        expect(root.getState()).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: LONG_INPUT }]);
      }
      expect(requests[0]?.model).toBe("owned-model");
      expect(requests[0]?.tools).toHaveLength(1);
      expect(requests[0]?.temperature).toBe(0.2);
      expect(requests[0]?.max_tokens).toBe(512);
      expect(requests[0]?.parallel_tool_calls).toBe(false);
      expect(requests[0]?.messages).toEqual([{ role: "system", content: SYSTEM }, { role: "user", content: LONG_INPUT }]);
      expect(observed.background).toBe(0);
      expect(observed.responseSummary).toBe(0);
      await Effect.runPromise(Deferred.await(terminalRecorded).pipe(Effect.timeout("1 second")));
      expect(observed.terminal).toBe(1);
      expect(incomingFrames.filter((frame) => frame.method === "run-step")).toHaveLength(1);
      expect(isHostManagedRootActive(root)).toBe(false);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
      resetHostCompactSlotForTests();
      expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
}
