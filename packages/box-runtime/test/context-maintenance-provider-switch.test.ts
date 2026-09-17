import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { contextMaintenanceKey } from "@grokbox/runtime-kernel/contract";
import { inferenceMemoryLayer, memoryExecutionHistory } from "@grokbox/runtime-kernel/inference";
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
import { ownedNativeSummary } from "./context-native-fixture.ts";

const AGENT = "00000000-0000-4000-8000-000000000715";
const PRIMARY = "owned/primary", FALLBACK = "owned/fallback";
const hex = (c: string) => c.repeat(64);
type RequestBody = { model: string; reasoning_effort?: string; messages: Array<{ role: string; content: string }> };

/** A provider error must not exhaust the whole session. Explicit selection on a
 * new TURN retries the user's new intent, never the failed old STEP. This is a
 * real SDK/Unix/Host integration with two loopback model identities, not live
 * permission to switch an unrelated Bot or to silently fail over. */
for (const failureAt of ["summary", "main"] as const) test(`HTTP 503 at ${failureAt}, then explicit fallback high on a new TURN preserves context and does not replay`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-context-switch-"));
  const durableRoot = join(dir, "durable"), runRoot = join(dir, "run");
  await mkdir(durableRoot);
  const requests: RequestBody[] = [];
  const isSummary = (body: RequestBody) => body.messages[0]?.content.includes("context summarization assistant") === true;
  const http = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as RequestBody; requests.push(body);
    if (body.model === "primary" && (failureAt === "summary" ? isSummary(body) : !isSummary(body))) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: "PRIVATE_503_DETAIL" } }));
      return;
    }
    const facts = [...new Set(JSON.stringify(body.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
    const answer = isSummary(body) ? `## Critical Context\n${facts.join("\n")}\nContinue the newest user request.` : `Completed ${facts.join(" ")}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address(); if (!address || typeof address === "string") throw Error("fixture address missing");
  const modelRecord = (model: string) => ({ provider: "openai", model, endpoint: `http://127.0.0.1:${address.port}/v1`, apiKeyRef: "env:OWNED_KEY",
    contextWindowTokens: 500000, capabilities: { tools: true, vision: false, images: false, reasoning: { efforts: ["high"] } }, dataTypes: ["text", "tools"] });
  const catalog = { [PRIMARY]: modelRecord("primary"), [FALLBACK]: modelRecord("fallback") };
  const select = (modelId: string) => parseModelsFile({ version: 2, models: catalog, assignments: { main: null, agents: {
    [AGENT]: { modelId, ...(modelId === FALLBACK ? { reasoning: { effort: "high" } } : {}) },
  } } });
  let models = select(PRIMARY);
  await writeFile(join(durableRoot, "models.json"), JSON.stringify(models));
  const epoch = randomUUID(), auth = createLiveBackendAuth({ OWNED_KEY: "synthetic-not-a-real-credential" });
  const history = memoryExecutionHistory();
  const layers = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } }).pipe(
    Layer.merge(admitAllAuthorityLayer()), Layer.merge(auth.layer), Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)),
    Layer.merge(piCompactionAlgorithmLayer), Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch, history })),
  );
  const ready = await Effect.runPromise(Deferred.make<void>());
  const server = Effect.runFork(Effect.scoped(serveModeld({ path: join(runRoot, "modeld.sock"), generation: epoch }).pipe(
    Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never), Effect.provide(layers))));
  let scope: ReturnType<ReturnType<typeof bindHostCompactHook>>;
  try {
    await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("2 seconds")));
    const binding = { generationId: hex("a"), activationId: "owned", pid: 1, start: 1, sourceSha: hex("b"), identitySha: hex("c") };
    const compile = { profileId: "t21-state-root", profileSha256: hex("e"), sourceSha256: hex("b"), transformedSha256: hex("d") };
    const original: unknown[] = [{ role: "system", content: "Preserve facts and answer the newest request." },
      ...Array.from({ length: 48 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `FACT_${i}=value${i}; ${"ordinary long history ".repeat(650)}`,
        providerOptions: { owned: { id: i } } })),
      { role: "assistant", content: "", providerOptions: { owned: { failedStep: "PREVIOUS_FAILURE" } } },
      { role: "user", content: "FIRST_NONCE: continue using FACT_0.", providerOptions: { owned: { nonce: "FIRST_NONCE" } } }];
    const native = ownedNativeSummary();
    let checkpoints = 0, current = original;
    const beginTurn = (turnId: string, stepId: string) => {
      scope?.[Symbol.dispose]();
      const session = bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile })({ agentId: AGENT,
        sessionOptions: { agentId: AGENT, invocationId: turnId }, originalSession: { getExecutor() { throw Error("official-fallback-forbidden"); } } });
      if (!isHostPromptSession(session)) throw Error("managed session missing");
      const executor = session.getExecutor(current);
      const root = { getMessages: () => executor.getMessages(), getState: () => executor.getState(), clearMessages: () => executor.clearMessages(),
        appendMessages: (messages: unknown[]) => executor.appendMessages(messages) };
      native.state.lastStepInvocationId = stepId;
      const controller = new AbortController();
      scope = bindHostCompactHook({ ...stateSystemCompactHookOptions(), context: hostContextClient({ mode: "route", runRoot, binding, compile }) })({
        ...native, stateHandler: native.state, rootPromptExecutor: root, ctx: { signal: controller.signal }, config: { agentSessionId: "" },
        invocationId: stepId, turnId, agentId: AGENT, stepClosed: () => false, normalizeContext: (messages: unknown[]) => messages,
        contextFixedMessages: () => [root.getMessages()[0]], contextTools: () => [],
        contextCheckpoint: async () => { await writeFile(join(dir, "checkpoint.json"), JSON.stringify(root.getState())); checkpoints++; },
      });
      if (!scope?.preflight) throw Error("preflight missing");
      return { root, preflight: scope.preflight, main: () => executor.stream({ signal: controller.signal }, stepId, [], { maxTokens: 512 }) };
    };
    const first = beginTurn("first-turn", "first-step");
    if (failureAt === "summary") {
      const error = await first.preflight().then(() => undefined, error => error);
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain("PRIVATE_503_DETAIL");
      expect(requests).toHaveLength(1); expect(checkpoints).toBe(0); expect(first.root.getMessages()).toEqual(original);
    } else {
      await first.preflight();
      const stream = first.main(), response = stream.response.catch(error => error);
      await expect((async () => { for await (const _ of stream.fullStream) { /* error is required */ } })()).rejects.toBeDefined();
      expect(await response).toBeInstanceOf(Error);
      expect(requests.filter(body => !isSummary(body))).toHaveLength(1); expect(checkpoints).toBe(1);
    }
    const oldReceipt = await Effect.runPromise(history.getLatestMaintenance!(AGENT, ""));
    expect(oldReceipt?.state).toBe(failureAt === "summary" ? "failed" : "committed");
    const beforeSwitch = requests.length;
    expect(requests.every(body => body.model === "primary")).toBe(true);
    // No hidden provider failover: only this explicit next-TURN assignment change
    // enables the other model. The same original/native material is carried on.
    current = [...first.root.getMessages(), { role: "user", content: "SECOND_NONCE: use FACT_0 now.", providerOptions: { owned: { nonce: "SECOND_NONCE" } } }];
    const pending = current.at(-1);
    models = select(FALLBACK);
    await writeFile(join(durableRoot, "models.json"), JSON.stringify(models));
    const second = beginTurn("second-turn", "second-step");
    await second.preflight();
    const fallbackSummaries = requests.slice(beforeSwitch).filter(isSummary);
    expect(fallbackSummaries.length > 0).toBe(failureAt === "summary");
    expect(second.root.getMessages().at(-1)).toEqual(pending);
    const result = second.main();
    for await (const _ of result.fullStream) { /* real SDK and Host stream */ }
    expect((await result.response).error).toBeUndefined();
    const afterSwitch = requests.slice(beforeSwitch);
    expect(afterSwitch.every(body => body.model === "fallback" && body.reasoning_effort === "high")).toBe(true);
    expect(afterSwitch.filter(body => !isSummary(body))).toHaveLength(1);
    expect(JSON.stringify(afterSwitch.at(-1)?.messages)).toContain("SECOND_NONCE");
    expect(JSON.stringify(afterSwitch.at(-1)?.messages)).toContain("FACT_0=value0");
    expect(JSON.stringify(afterSwitch.at(-1)?.messages)).not.toContain("PRIVATE_503_DETAIL");
    expect(checkpoints).toBe(1);
    const preserved = await Effect.runPromise(history.getMaintenance!(contextMaintenanceKey(AGENT, "", oldReceipt!.identity.operationId)));
    expect(preserved).toEqual(oldReceipt);
    // A third normal input must not recompact due to the stale 503 evidence.
    current = [...second.root.getMessages(), { role: "user", content: "THIRD_NONCE: brief continuation." }];
    const beforeThird = requests.length, third = beginTurn("third-turn", "third-step");
    await third.preflight();
    expect(requests).toHaveLength(beforeThird); expect(checkpoints).toBe(1);
  } finally {
    scope?.[Symbol.dispose]();
    await Effect.runPromise(Fiber.interrupt(server));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);
