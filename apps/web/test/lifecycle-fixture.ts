import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES, normalizeLifecycleIntent, type LifecycleKind, type LifecycleIntent, type Capability } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { botSupplement, materialFromBotSupplement, ContinuityFailure, CurrentStateFailure } from "@grokbox/runtime-kernel/continuity";
import { createManagementGateway, createNativeBotLifecycle, openRuntimeStore, openContinuityRecoveryStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
export const L_INSTALL = "11111111-1111-4111-8111-111111111111", L_SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", L_SCOPE = "e".repeat(64);
export const L_OWNER = "synthetic-lifecycle-owner", L_READER = "synthetic-lifecycle-reader", L_LIMITED = "synthetic-lifecycle-limited", L_OTHER = "synthetic-lifecycle-other";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function lifecycleIntent(kind: LifecycleKind = "clone", patch: Partial<LifecycleIntent> = {}) {
  return normalizeLifecycleIntent({ requestId: randomUUID(), kind, sourceBotRef: kind === "spawn" ? null : L_SOURCE, name: "Synthetic new Bot",
    instructions: "PRIVATE_LIFECYCLE_INSTRUCTIONS", ...patch }, L_INSTALL);
}
/** Real HTTP/native planning, original CONT SQLite and publication. The optional
 * creation/initialization endpoints below are synthetic external capabilities,
 * not a second lifecycle program, production fallback or real provider call. */
export async function lifecycleFixture(origin: string) {
  const root = await mkdtemp(join(tmpdir(), "manual-lifecycle-")), discoveryPath = join(root, "gateway.json");
  const state = { calls: [] as string[], policyRevision: "b".repeat(64), sourceName: "Synthetic source", failNative: false, created: 0, loaded: 0,
    initialized: 0, activated: 0, started: 0, handedOver: 0, failBirth: false, failLoad: false, failActivation: false, revokeAfterBirth: false,
    holdCreate: undefined as undefined | ((signal: AbortSignal) => Promise<void>),
    holdCapture: undefined as undefined | ((signal: AbortSignal) => Promise<void>), grants: [
      { principalId: "owner", tokenSha256: hash(L_OWNER), capabilities: [...CAPABILITIES] },
      { principalId: "reader", tokenSha256: hash(L_READER), capabilities: ["operations.read", "console.grants.create"] },
      { principalId: "limited", tokenSha256: hash(L_LIMITED), capabilities: ["operations.read", "lifecycle.write", "console.grants.create"] },
      { principalId: "other", tokenSha256: hash(L_OTHER), capabilities: [...CAPABILITIES] },
    ] as AccessGrant[], targets: [] as string[] };
  const gateway = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer synthetic-lifecycle-native") { res.writeHead(401); res.end(); return; }
      let text = ""; for await (const b of req) text += b.toString(); const input = JSON.parse(text); state.calls.push(req.url!);
      if (state.failNative) { res.writeHead(503); res.end(); return; }
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/grokboxCurrentStateControl" && input.action === "capabilities") {
        res.end(JSON.stringify({ ok: true, data: { scopeId: L_SCOPE, policyRevision: state.policyRevision, observedAtMs: Date.now(),
          qualification: { hostSourceSha: "d".repeat(64), nativeSchema: "synthetic-lifecycle-checkpoint-v1" } } })); return;
      }
      if (req.url === "/api/listAgents") { res.end(JSON.stringify([{ id: L_SOURCE, name: state.sourceName, description: "PRIVATE_SOURCE_DESCRIPTION", title: "Source", isGroup: false, harness: "box" },
        ...state.targets.map(id => ({ id, name: "Synthetic target", isGroup: false, harness: "box" }))])); return; }
      if (req.url === "/api/getAgentAutomations") { res.end("[]"); return; }
      res.writeHead(404); res.end();
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); const address = gateway.address(); if (!address || typeof address === "string") throw Error("fixture-listen");
  await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: address.port, pid: 4242, startedAt: 1000, token: "synthetic-lifecycle-native" });
  const config = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled", continuity: { enabled: false } } });
  await publishConfigFile(join(root, "config.json"), config);
  const native = createManagementGateway({ discoveryPath, configurationRoot: root, timeoutMs: 1000 });
  const create: typeof createNativeBotLifecycle = (context, input) => {
    const adapter = createNativeBotLifecycle(context, input), recovery = openContinuityRecoveryStore({ durableRoot: root, scopeId: L_SCOPE });
    const capture = async (agentId: string, snapshotId: string) => {
      await state.holdCapture?.(context.signal!); context.signal?.throwIfAborted();
      try { const old = await recovery.readSnapshot(snapshotId); return { snapshotId, revision: old.reference.revision, quality: old.manifest.quality, gaps: old.manifest.gaps }; }
      catch (error) { if (!(error instanceof ContinuityFailure && error.code === "not_found")) throw error; }
      const supplement = botSupplement({ version: 1, sourceId: agentId, memory: [{ content: "PRIVATE_MATERIAL", createdAt: 1, kind: "profile" }], history: [], memoryComplete: true, historyComplete: false });
      const material = materialFromBotSupplement(supplement, { agentId, scopeId: L_SCOPE, nativeSchema: "synthetic-lifecycle-checkpoint-v1", contextRevision: "e".repeat(64), capturedAtMs: Date.now(), transcriptThrough: null });
      const result = await recovery.publish({ requestId: snapshotId, ...material });
      return { snapshotId, revision: result.reference.revision, quality: material.manifest.quality, gaps: material.manifest.gaps };
    };
    adapter.native = { ...adapter.native,
      capture: (r, id) => capture(r.sourceId!, id),
      create: async () => { await state.holdCreate?.(context.signal!); context.signal?.throwIfAborted(); state.created++; const agentId = randomUUID(); state.targets.push(agentId);
        if (state.failBirth) throw new CurrentStateFailure("commit_unknown"); return { agentId, created: true, started: false }; },
      load: async (_r, agentId) => { context.signal?.throwIfAborted(); state.loaded++; if (state.failLoad) throw new CurrentStateFailure("native_unavailable"); return { agentId, loaded: true }; },
      compose: (_r, agentId, _s, id) => capture(agentId, id),
      initialize: async (_r, _a, _s, operationId) => { context.signal?.throwIfAborted(); state.initialized++; return { operationId, state: "prepared" }; },
      activate: async () => { context.signal?.throwIfAborted(); if (state.failActivation) throw new CurrentStateFailure("native_unavailable"); state.activated++; return { state: "released", activated: true, started: false }; },
      startup: async () => { context.signal?.throwIfAborted(); state.started++; return { state: "settled", started: true }; },
      handover: async () => { context.signal?.throwIfAborted(); state.handedOver++; return { state: "active_with_handover", remaining: 1 }; },
    };
    return adapter;
  };
  const options = { store: openRuntimeStore(root, {}), installationId: L_INSTALL, native, allowedOrigins: [origin], env: {}, port: 0,
    readGrants: async () => {
      const grants = structuredClone(state.grants);
      if (state.revokeAfterBirth && state.created) grants[0]!.capabilities = grants[0]!.capabilities.filter(c => c !== "lifecycle.write");
      return grants;
    } };
  let server = await startManagementServer(options, { lifecycle: { create } }); options.port = Number(new URL(server.url).port);
  config.client.currentProfile = "default"; config.client.profiles = { default: { serverUrl: server.url, installationId: L_INSTALL, daemonTokenRef: "env:SYNTHETIC_LIFECYCLE_CREDENTIAL" } };
  await publishConfigFile(join(root, "config.json"), config);
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: L_INSTALL, role: "box", root, daemon: { tokenSha256: hash(L_OWNER) } });
  await publishLayoutAliases(root, root, L_INSTALL);
  return { root, native, options, state, get server() { return server; }, create,
    // A restarted management process is reached by a fresh client connection.
    // Do not turn undici's old pooled socket into an automatic write retry.
    client: (token = L_OWNER, transport?: typeof fetch) => new ManagementClient({ baseUrl: server.url, installationId: L_INSTALL, credential: async () => token,
      fetch: transport ?? (async (input, init) => { const headers = new Headers(init?.headers); headers.set("connection", "close"); return fetch(input, { ...init, headers }); }) as typeof fetch }),
    restart: async () => { await server.close(); server = await startManagementServer(options, { lifecycle: { create } }); },
    revoke: (cap: Capability) => { state.grants[0]!.capabilities = state.grants[0]!.capabilities.filter(c => c !== cap); },
    close: async () => { try { await server.close(); } finally { gateway.closeAllConnections(); await new Promise<void>(r => gateway.close(() => r())); await rm(root, { recursive: true, force: true }); } },
  };
}
