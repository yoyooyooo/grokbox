import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { serveModeld } from "../../src/internal/modeld/server.node.ts";
import { admitAllAuthorityLayer } from "../../src/internal/roots/modeld.runtime.ts";
import { piCompactionAlgorithmLayer } from "../../src/internal/context/pi-compaction.ts";
import { dispatchingModelBackendLayer } from "../../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth } from "../../src/internal/io/credentials.node.ts";
import { PACKED_SESSION_SYMBOL } from "../../src/internal/host/profile.ts";
import { ownedNativeSummary } from "../context-native-fixture.ts";

const [mode, directory, preload] = process.argv.slice(2);
assert(mode === "exercise" || mode === "reopen"); assert(directory && preload);
createRequire(import.meta.url)(preload);
const factory = (globalThis as Record<symbol, any>)[Symbol.for(PACKED_SESSION_SYMBOL)];
assert(factory?.bindHostCompactHook && factory?.hostContextClient && factory?.bindHostSessionHook, "real packed context factory unavailable");
const A = "00000000-0000-4000-8000-000000000001", M = "owned/context-model", hex = (c: string) => c.repeat(64);
const durableRoot = join(directory, "durable"), runRoot = join(directory, "run"), checkpoint = join(directory, "root.json");
await mkdir(durableRoot, { recursive: true, mode: 0o700 });
const bodies: any[] = [];
const http = createServer(async (req, res) => {
  let text = ""; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); bodies.push(body);
  const facts = [...new Set(JSON.stringify(body.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
  const summary = body.messages[0]?.content.includes("context summarization assistant");
  const answer = summary ? `## Critical Context\n${facts.join("\n")}\nContinue pending work.` : `MAIN_OK ${facts.join(" ")}`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const address = http.address(); assert(address && typeof address !== "string");
const models = parseModelsFile({ version: 3, models: { [M]: { provider: "openai", model: "owned-model", endpoint: `http://127.0.0.1:${address.port}/v1`,
  apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000, capabilities: { tools: true, vision: false, images: false }, dataTypes: ["text", "tools"] } },
  assignments: { main: null, agents: { [A]: { modelId: M } } } });
await writeFile(join(durableRoot, "models.json"), JSON.stringify(models), { mode: 0o600 });
const policy = { windowTokens: 32000, compaction: { reserveTokens: 4096, keepRecentTokens: 1024 } };
await writeFile(join(durableRoot, "config.json"), JSON.stringify({ schemaVersion: 4, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } }, runtime: { desiredMode: "route", context: policy } }), { mode: 0o600 });
const epoch = randomUUID(), auth = createLiveBackendAuth({ OWNED_KEY: "not-a-real-credential" });
const layers = fakeConfigurationReadLayer({ models: () => models, context: policy, desired: { version: 1, mode: "route" } }).pipe(
  Layer.merge(admitAllAuthorityLayer()), Layer.merge(auth.layer), Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)),
  Layer.merge(piCompactionAlgorithmLayer), Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch })));
const ready = await Effect.runPromise(Deferred.make<void>());
const server = Effect.runFork(Effect.scoped(serveModeld({ path: join(runRoot, "modeld.sock"), generation: epoch }).pipe(
  Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never), Effect.provide(layers))));
const binding = { generationId: hex("a"), activationId: "owned", pid: 1, start: 1, sourceSha: hex("b"), identitySha: hex("c") };
const compile = { profileId: "t21-state-root", profileSha256: hex("e"), sourceSha256: hex("b"), transformedSha256: hex("d") };
let compactions = 0, checkpoints = 0, activities = 0;
const source = mode === "exercise" ? [
  { role: "system", content: "Keep facts and pending user instructions." },
  { role: "user", content: "FACT_0=initial; " + "initial history ".repeat(18000) },
  { role: "assistant", content: "", providerOptions: { owned: { failedStep: "OLD_FAILED_STEP" } } },
] : JSON.parse(await readFile(checkpoint, "utf8"));
assert(Array.isArray(source));
let messages: any[] = source;
try {
  await Effect.runPromise(Deferred.await(ready).pipe(Effect.timeout("5 seconds")));
  for (let cycle = 0; cycle < (mode === "exercise" ? 10 : 1); cycle++) {
    const turnId: string = `${mode}-turn-${cycle}`, stepId: string = `${mode}-step-${cycle}`;
    if (mode === "exercise" && cycle > 0) messages.push({ role: "assistant", content: `FACT_${cycle}=value${cycle}; ${"additional result ".repeat(9500)}` });
    const pending: { role: string; content: string; providerOptions: unknown } = { role: "user", content: `NEXT_INPUT_${mode}_${cycle}`, providerOptions: { owned: { nonce: `${mode}-${cycle}` } } };
    messages.push(pending);
    const session: any = factory.bindHostSessionHook({ mode: "route", durableRoot, runRoot, binding, compile })({ agentId: A,
      sessionOptions: { agentId: A, invocationId: turnId }, originalSession: { getExecutor() { throw Error("official fallback forbidden"); } } });
    assert(session && typeof session.getExecutor === "function");
    const executor = session.getExecutor(messages);
    const root = { getMessages: () => executor.getMessages(), getState: () => executor.getState(), clearMessages: () => executor.clearMessages(), appendMessages: (rows: unknown[]) => executor.appendMessages(rows) };
    const native = ownedNativeSummary(); native.state.lastStepInvocationId = stepId;
    const activity: boolean[] = [];
    const before = bodies.length;
    const scope: { preflight?: () => Promise<void>; [Symbol.dispose]: () => void } | undefined = factory.bindHostCompactHook({ ...factory.stateSystemCompactHookOptions(), context: factory.hostContextClient({ mode: "route", runRoot, binding, compile }) })({
      ...native, stateHandler: native.state, rootPromptExecutor: root, ctx: { signal: new AbortController().signal }, config: { agentSessionId: "" },
      invocationId: stepId, turnId, agentId: A, stepClosed: () => false, normalizeContext: (rows: unknown[]) => rows,
      contextFixedMessages: () => [root.getMessages()[0]], contextTools: () => [], contextActivity: async (active: boolean) => { activity.push(active); },
      contextCheckpoint: async () => { await writeFile(`${checkpoint}.tmp`, JSON.stringify(root.getState()), { mode: 0o600 }); await rename(`${checkpoint}.tmp`, checkpoint); checkpoints++; },
    });
    assert(scope?.preflight);
    try {
      await scope.preflight();
      if (mode === "exercise") { assert(bodies.length > before); compactions++; assert.deepEqual(activity, [true, false]); activities++; }
      else assert.equal(bodies.length, before, "new process must not regenerate a saved summary");
      assert.deepEqual(root.getMessages().at(-1), pending);
      const main = executor.stream({}, stepId, [], { maxTokens: 512 });
      for await (const _ of main.fullStream) { /* real packaged Host stream */ }
      assert.equal((await main.response).error, undefined);
      const request = bodies.at(-1);
      assert(!request.messages[0].content.includes("context summarization assistant"));
      assert(JSON.stringify(request.messages).includes("FACT_0=initial"));
      assert(JSON.stringify(request.messages).includes(pending.content));
      assert(JSON.stringify(request.messages).length < 100000);
      messages = root.getState();
      if (mode === "exercise") assert.equal(native.state.archive.length, 1);
    } finally { scope[Symbol.dispose](); }
  }
  const saved = await readFile(checkpoint, "utf8");
  const mainRequests = bodies.filter(body => !body.messages[0].content.includes("context summarization assistant")).length;
  process.stdout.write(JSON.stringify({ node: process.version, pid: process.pid, mode, compactions, checkpoints, activities,
    mainRequests, summaryRequests: bodies.length - mainRequests, checkpointDigest: createHash("sha256").update(saved).digest("hex"),
    initialFact: saved.includes("FACT_0=initial"), lastFact: saved.includes("FACT_9=value9"), packedFactory: true }) + "\n");
} finally { await Effect.runPromise(Fiber.interrupt(server)); await new Promise<void>(resolve => http.close(() => resolve())); }
