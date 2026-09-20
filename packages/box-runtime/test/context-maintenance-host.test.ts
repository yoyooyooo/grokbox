import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { admitAllAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { piCompactionAlgorithmLayer } from "../src/internal/context/pi-compaction.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth } from "../src/internal/io/credentials.node.ts";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { bindHostCompactHook, stateSystemCompactHookOptions } from "../src/internal/host/compact.ts";
import { hostContextClient } from "../src/internal/host/context-client.node.ts";
import type { HostWitnessNote } from "@grokbox/runtime-kernel/host-health";

const A = "00000000-0000-4000-8000-000000000001", M = "owned/context-model";
const h = (c: string) => c.repeat(64);
import { ownedNativeSummary } from "./context-native-fixture.ts";

for (const scenario of ["success", "credential-rotation", "summary-503", "main-503"] as const) test(`native-method facade + real Host client + Unix/kernel/SDK: next-input ${scenario}`, async () => {
  const rotateAfterPreflight = scenario === "credential-rotation";
  const dir = await mkdtemp(join(tmpdir(), "gbox-context-host-"));
  const durableRoot = join(dir, "durable"), runRoot = join(dir, "run"); await mkdir(durableRoot);
  const requests: any[] = [];
  const http = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const facts = [...new Set(JSON.stringify(body.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
    const isSummary = body.messages[0]?.content.includes("context summarization assistant");
    if (scenario === "summary-503" && isSummary || scenario === "main-503" && !isSummary) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR_SENTINEL", type: "api_error" } }));
      return;
    }
    const answer = isSummary ? `## Critical Context\n${facts.join("\n")}\nContinue the pending request.` : `Completed ${facts.join(" ")}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  const models = parseModelsFile({ version: 2, models: { [M]: { provider: "openai", model: "owned-model", endpoint: `http://127.0.0.1:${address.port}/v1`,
    apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000, capabilities: { tools: true, vision: false, images: false }, dataTypes: ["text", "tools"] } },
    assignments: { main: null, agents: { [A]: { modelId: M } } } });
  await writeFile(join(durableRoot, "models.json"), JSON.stringify(models));
  const environment = { OWNED_KEY: "not-a-real-credential" };
  const epoch = randomUUID(), auth = createLiveBackendAuth(environment);
  const layers = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } }).pipe(Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(auth.layer), Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)), Layer.merge(piCompactionAlgorithmLayer), Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch })));
  const ready = await Effect.runPromise(Deferred.make<void>());
  const server = Effect.runFork(Effect.scoped(serveModeld({ path: join(runRoot, "modeld.sock"), generation: epoch }).pipe(
    Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never), Effect.provide(layers))));
  let scope: ReturnType<ReturnType<typeof bindHostCompactHook>>;
  const notes: HostWitnessNote[] = [], witness = (note: HostWitnessNote) => { notes.push(note); };
  try {
    await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("2 seconds")));
    const binding = { generationId: h("a"), activationId: "owned", pid: 1, start: 1, sourceSha: h("b"), identitySha: h("c") };
    const compile = { profileId: "t21-state-root", profileSha256: h("e"), sourceSha256: h("b"), transformedSha256: h("d") };
    const turnId = "ordinary-next-turn", stepId = "ordinary-next-step";
    const session = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile, witness })({ agentId: A,
      sessionOptions: { agentId: A, invocationId: turnId }, originalSession: { getExecutor() { throw new Error("official_fallback_forbidden"); } } });
    if (!isHostPromptSession(session)) throw new Error("managed session missing");
    const oldMessages: any[] = [{ role: "system", content: "Keep facts and answer the newest request." },
      ...Array.from({ length: 48 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `FACT_${i}=value${i}; ${"ordinary long history ".repeat(650)}`,
        providerOptions: { owned: { id: i } } })), { role: "assistant", content: "", providerOptions: { owned: { failedStep: "OLD_FAILURE" } } },
      { role: "user", content: "NEXT_INPUT_NONCE: continue using FACT_0.", providerOptions: { owned: { nonce: "NEXT_INPUT_NONCE" } } }];
    const executor = session.getExecutor(oldMessages);
    const root = { getMessages: () => executor.getMessages(), getState: () => executor.getState(), clearMessages: () => executor.clearMessages(), appendMessages: (messages: unknown[]) => executor.appendMessages(messages) };
    const native = ownedNativeSummary(); native.state.lastStepInvocationId = stepId;
    const abort = new AbortController(); let checkpoints = 0;
    scope = bindHostCompactHook({ ...stateSystemCompactHookOptions(), witness, context: hostContextClient({ mode: "route", runRoot, binding, compile, witness }) })({
      ...native, stateHandler: native.state, rootPromptExecutor: root, ctx: { signal: abort.signal }, config: { agentSessionId: "" },
      invocationId: stepId, turnId, agentId: A, stepClosed: () => false, normalizeContext: (messages: unknown[]) => messages,
      contextFixedMessages: () => [root.getMessages()[0]], contextTools: () => [],
      contextCheckpoint: async () => { expect(notes.some(n => n.stage === "checkpoint-settled")).toBe(false); await writeFile(join(dir, "checkpoint.json"), JSON.stringify(root.getState())); checkpoints++; },
    });
    expect(scope?.preflight).toBeDefined();
    if (scenario === "summary-503") {
      const error = await scope!.preflight!().then(() => undefined, error => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
      expect(requests).toHaveLength(1);
      expect(requests[0].messages[0].content).toContain("context summarization assistant");
      expect(root.getMessages()).toEqual(oldMessages);
      expect(checkpoints).toBe(0);
      expect(notes.filter(n => n.stage === "checkpoint-settled")).toHaveLength(0);
      expect(notes.filter(n => n.stage === "preflight-settled")).toMatchObject([{ outcome: "threw", agentId: A, turnId, stepId }]);
      expect(native.state.archive).toHaveLength(0);
      return;
    }
    await scope!.preflight!();
    const summaryCalls = requests.length;
    expect(summaryCalls).toBeGreaterThan(0);
    expect(requests.every(body => body.messages[0].content.includes("context summarization assistant"))).toBe(true);
    expect(checkpoints).toBe(1);
    expect(notes.filter(n => n.stage === "checkpoint-settled")).toMatchObject([{ capability: "context", outcome: "returned", agentId: A, turnId, stepId }]);
    const persisted = JSON.parse(await readFile(join(dir, "checkpoint.json"), "utf8"));
    expect(JSON.stringify(persisted)).toContain("grokboxContextMaintenance");
    expect(JSON.stringify(persisted)).toContain("DURABLE=NATIVE_CARRIER");
    expect(JSON.stringify(persisted)).toContain("FACT_0=value0");
    expect(root.getMessages().at(-1)).toEqual(oldMessages.at(-1));
    if (rotateAfterPreflight) environment.OWNED_KEY = "rotated-synthetic-credential";
    const result = executor.stream({ signal: abort.signal }, stepId, [], { maxTokens: 512 });
    if (rotateAfterPreflight || scenario === "main-503") {
      const response = result.response.catch(error => error);
      await expect((async () => { for await (const _ of result.fullStream) { /* must refuse before another HTTP */ } })()).rejects.toBeDefined();
      const failure = await response;
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("PRIVATE_PROVIDER_ERROR_SENTINEL");
      expect(requests).toHaveLength(summaryCalls + (scenario === "main-503" ? 1 : 0));
      expect(checkpoints).toBe(1);
      expect(root.getMessages().at(-1)).toEqual(oldMessages.at(-1));
      return;
    }
    for await (const _ of result.fullStream) { /* consume the real Host stream */ }
    const response = await result.response;
    expect(response.error).toBeUndefined();
    expect(requests).toHaveLength(summaryCalls + 1);
    const main = requests.at(-1);
    expect(main.max_tokens).toBe(512);
    expect(JSON.stringify(main.messages)).toContain("NEXT_INPUT_NONCE");
    expect(JSON.stringify(main.messages)).toContain("FACT_0=value0");
    expect(JSON.stringify(main.messages).length).toBeLessThan(100000);
    expect(native.state.archive).toHaveLength(1);
    expect(notes.filter(n => n.stage === "terminal-consumed")).toMatchObject([{ outcome: "returned", agentId: A, turnId, stepId }]);
    expect(notes.filter(n => n.stage === "managed-selected")).toHaveLength(1);
  } finally {
    scope?.[Symbol.dispose]();
    await Effect.runPromise(Fiber.interrupt(server));
    await new Promise<void>(resolve => http.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
}, 20000);
