import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { ManagementClient, CAPABILITIES } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { inferenceMemoryLayer, memoryExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { createManagementGateway, openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import { serveModeld } from "../../../packages/box-runtime/src/internal/modeld/server.node.ts";
import { admitAllAuthorityLayer } from "../../../packages/box-runtime/src/internal/roots/modeld.runtime.ts";
import { dispatchingModelBackendLayer } from "../../../packages/box-runtime/src/internal/backends/dispatch.ts";
import { createLiveBackendAuth } from "../../../packages/box-runtime/src/internal/io/credentials.node.ts";
import { piCompactionAlgorithmLayer } from "../../../packages/box-runtime/src/internal/context/pi-compaction.ts";
import { createHostContextControl } from "../../../packages/box-runtime/src/internal/host/context-control.node.ts";
import { bindHostSessionHook } from "../../../packages/box-runtime/src/internal/host/session-hook.ts";
import { isHostPromptSession } from "../../../packages/box-runtime/src/internal/host/session.ts";
import { ownedNativeSummary } from "../../../packages/box-runtime/test/context-native-fixture.ts";
import { settleJournalWrites } from "../../../packages/box-runtime/src/internal/host/terminal-journal.node.ts";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";
import type { ContinuityStoreHooks } from "../../../packages/box-runtime/src/internal/io/continuity-database.node.ts";
export const C_INSTALL = "11111111-1111-4111-8111-111111111111", C_BOT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", C_SCOPE = "a".repeat(64);
export const C_OWNER = "synthetic-compaction-owner", C_READER = "synthetic-compaction-reader", C_OTHER = "synthetic-compaction-other";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
/** Real management/Gateway HTTP, native manual facade, Unix modeld kernel,
 * SDK, and CONT SQLite. Only account/schema/native shell and the loopback
 * provider are controlled fixtures. Never loads a private Host or calls a Bot. */
export async function compactionFixture(origin: string, options: { small?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "compaction-management-")), runRoot = join(root, "run"), discoveryPath = join(root, "gateway.json");
  const store = openRuntimeStore(root, {}), history = memoryExecutionHistory(), hooks: ContinuityStoreHooks = {};
  const state = { scopeId: C_SCOPE, busy: false, foreign: false, calls: [] as string[], dispatches: 0, summaries: 0, checkpoints: 0, userInputs: 0,
    loseReply: false, slowStatus: false, statusAborted: 0, waitSummary: null as ReturnType<typeof deferred> | null, waitCleanup: null as ReturnType<typeof deferred> | null,
    checkpointUnknown: false, summaryFailure: false, unavailable: false, historyUnavailable: false, started: deferred(),
    grants: [ { principalId: "owner", tokenSha256: hash(C_OWNER), capabilities: [...CAPABILITIES] },
      { principalId: "other", tokenSha256: hash(C_OTHER), capabilities: [...CAPABILITIES] },
      { principalId: "reader", tokenSha256: hash(C_READER), capabilities: ["context.read", "operations.read", "console.grants.create"] } ] as AccessGrant[] };
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = JSON.parse(raw); state.summaries++; state.started.resolve();
    await state.waitSummary?.promise;
    if (res.destroyed) return;
    if (state.summaryFailure) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "PRIVATE_PROVIDER_ERROR" } })); return; }
    const facts = [...new Set(JSON.stringify(body.messages).match(/FACT_[0-9]+=[a-z0-9]+/g) ?? [])];
    const text = `## Critical Context\n${facts.join("\n")}\nContinue the next actual user input.`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: "summary", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening"); const address = provider.address(); if (!address || typeof address === "string") throw Error("fixture-listen");
  const modelId = "fixture/compaction", models = parseModelsFile({ version: 3, models: { [modelId]: { provider: "openai", model: "owned-summary", endpoint: `http://127.0.0.1:${address.port}/v1`, apiKeyRef: "env:OWNED_COMPACTION_KEY", contextWindowTokens: 500000 } }, assignments: { main: null, agents: { [C_BOT]: { modelId } } } });
  await publishConfigFile(join(root, "models.json"), models);
  const auth = createLiveBackendAuth({ OWNED_COMPACTION_KEY: "synthetic-provider-key" }), serviceEpoch = randomUUID();
  const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(Layer.merge(admitAllAuthorityLayer()), Layer.merge(auth.layer),
    Layer.merge(dispatchingModelBackendLayer(fetch, auth.unseal)), Layer.merge(piCompactionAlgorithmLayer), Layer.merge(inferenceMemoryLayer({ serviceEpoch, history })));
  const listening = await Effect.runPromise(Deferred.make<void>());
  const modeld = Effect.runFork(Effect.scoped(serveModeld({ path: join(runRoot, "modeld.sock"), generation: serviceEpoch }).pipe(
    Effect.andThen(Deferred.succeed(listening, undefined)), Effect.andThen(Effect.never), Effect.provide(layer))));
  await Effect.runPromise(Deferred.await(listening).pipe(Effect.timeout("3 seconds")));
  const signal = new AbortController(), binding = { generationId: "a".repeat(64), activationId: "fixture", pid: 1, start: 1, sourceSha: "b".repeat(64), identitySha: "c".repeat(64) };
  const compile = { profileId: "t21-state-root", profileSha256: "e".repeat(64), sourceSha256: binding.sourceSha, transformedSha256: "d".repeat(64) };
  const input = { mode: "route" as const, durableRoot: root, runRoot, binding, compile }, control = createHostContextControl(input), native = ownedNativeSummary();
  let current: unknown[] = [ { role: "system", content: "PRIVATE_SYSTEM preserve facts" },
    ...options.small ? [] : Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `FACT_${i}=value${i}; ${"ordinary history ".repeat(700)}` })),
    { role: "user", content: "PRIVATE_LATEST_INPUT" } ];
  const host = { getConversationId: () => C_BOT, getTranscriptId: () => C_BOT, getConversationState: () => ({ rootPromptMessagesJson: current, pendingToolCalls: [] }) };
  const run = async (prompt: string, args?: Record<string, unknown>) => {
    const operation = control.manualOptions(host, args);
    if (!operation) { state.userInputs++; return; }
    const session = bindHostSessionHook(input)({ agentId: C_BOT, sessionOptions: { agentId: C_BOT, invocationId: operation.operationId }, originalSession: { getExecutor() { throw Error("unexpected-native-fallback"); } } });
    if (!isHostPromptSession(session)) throw Error("fixture-managed-session");
    const executor = session.getExecutor(current);
    try {
      const result = await control.manualAction({ agentId: C_BOT, turnId: operation.operationId, capture: () => ({ ...native, stateHandler: native.state,
        rootPromptExecutor: executor, ctx: { signal: signal.signal }, config: { agentSessionId: "" }, agentId: C_BOT, turnId: operation.operationId,
        normalizeContext: (m: unknown[]) => m, contextFixedMessages: () => [executor.getMessages()[0]], contextTools: () => [],
        contextCheckpoint: async () => { state.checkpoints++; await writeFile(join(root, "synthetic-checkpoint.json"), JSON.stringify(executor.getState()), { mode: 0o600 }); if (state.checkpointUnknown) throw Error("synthetic-lost-checkpoint-ack"); } }) });
      await state.waitCleanup?.promise;
      return result;
    } finally { current = executor.getMessages(); }
  };
  const ordinaryRun = control.wrapRun(host, run, () => state.busy, () => signal.abort()) as typeof run;
  const nativeJobs = new Set<Promise<unknown>>();
  const nativeServer = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer synthetic-native-compaction") { res.writeHead(401); res.end(); return; }
      let text = ""; for await (const c of req) text += c; const body = JSON.parse(text); state.calls.push(req.url!);
      if (state.unavailable) { res.writeHead(503); res.end(); return; }
      res.setHeader("content-type", "application/json");
      const ownership = () => ({ grokboxOwnership: ownedOwnershipSnapshot([C_BOT], { scopeId: state.scopeId, serverHarness: state.foreign ? "temporal" : "box" }) });
      if (req.url === "/api/getHostStatus") { res.end(JSON.stringify(ownership())); return; }
      if (req.url === "/api/grokboxContextControl") {
        if (body.action === "compact") state.dispatches++;
        else if (state.slowStatus) { res.once("close", () => state.statusAborted++); return; }
        const job = control.call(body, async () => ownership()); nativeJobs.add(job);
        let result: unknown; try { result = await job; } finally { nativeJobs.delete(job); }
        if (body.action === "compact" && state.loseReply) { res.destroy(); return; }
        if (body.action === "status" && body.operationId && state.historyUnavailable && (result as any).data) (result as any).data.operationSettlement = "not-retained";
        res.end(JSON.stringify(result)); return;
      }
      res.writeHead(404); res.end();
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  nativeServer.listen(0, "127.0.0.1"); await once(nativeServer, "listening"); const na = nativeServer.address(); if (!na || typeof na === "string") throw Error("fixture-native-listen");
  await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: na.port, pid: 4242, startedAt: 1000, token: "synthetic-native-compaction" });
  await publishConfigFile(join(root, "config.json"), validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled", continuity: { enabled: false } } }));
  const gateway = createManagementGateway({ discoveryPath, configurationRoot: root, timeoutMs: 2000 });
  const serverOptions = { store, installationId: C_INSTALL, native: gateway, env: {}, allowedOrigins: [origin], readGrants: async () => structuredClone(state.grants), port: 0 };
  let server = await startManagementServer(serverOptions, { context: { hooks } }); serverOptions.port = Number(new URL(server.url).port);
  const config = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled", continuity: { enabled: false } }, client: { currentProfile: "default", profiles: { default: { serverUrl: server.url, installationId: C_INSTALL, daemonTokenRef: "env:COMPACTION_MANAGEMENT_TOKEN" } } } });
  await publishConfigFile(join(root, "config.json"), config);
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: C_INSTALL, role: "box", root, daemon: { tokenSha256: hash(C_OWNER) } });
  await publishLayoutAliases(root, root, C_INSTALL);
  return { root, state, models, control, history, hooks, ordinaryRun, serverOptions, current: () => structuredClone(current), get server() { return server; },
    // Tests rebind the exact same port; do not reuse the prior disposable
    // server's idle global socket. This does not change production transport.
    client: (credential = C_OWNER) => new ManagementClient({ baseUrl: server.url, installationId: C_INSTALL, credential: async () => credential, timeoutMs: 30000,
      fetch: (async (url, init) => { const headers = new Headers(init?.headers); headers.set("connection", "close"); return fetch(url, { ...init, headers }); }) as typeof fetch }),
    restart: async () => { await server.close(); server = await startManagementServer(serverOptions, { context: { hooks } }); },
    close: async () => { signal.abort(); state.waitSummary?.resolve(); state.waitCleanup?.resolve(); await server.close();
      await Promise.allSettled([...nativeJobs]);
      await Effect.runPromise(Fiber.interrupt(modeld)); provider.closeAllConnections(); nativeServer.closeAllConnections();
      await Promise.all([new Promise<void>(r => provider.close(() => r())), new Promise<void>(r => nativeServer.close(() => r()))]); await settleJournalWrites(runRoot); await settleJournalWrites(root); await rm(root, { recursive: true, force: true }); }
  };
}
