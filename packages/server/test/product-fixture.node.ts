import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES, normalizeProductIntent, type ProductIntent, type Capability } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { createManagementGateway, openRuntimeStore, publishConfigFile, publishLayoutAliases, type ProductManagementHooks } from "@grokbox/box-runtime/runtime";
import { startManagementServer, type AccessGrant } from "@grokbox/server";
import { ownedOwnershipSnapshot } from "../../box-runtime/test/ownership-fixture.ts";
export const P_INSTALL = "11111111-1111-4111-8111-111111111111", P_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  P_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", P_GROUP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", P_SCOPE = "e".repeat(64);
export const P_OWNER = "synthetic-product-owner", P_OTHER = "synthetic-product-other", P_READER = "synthetic-product-reader";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const productRow = (id: string, group = false): Record<string, any> => ({ id, name: group ? "Synthetic group" : id === P_A ? "First" : "Second",
  description: "Synthetic instructions", title: "", avatarShape: "", avatarColor: "", isGroup: group,
  ...(group ? { memberIds: [P_A] } : { harness: "box" }), isHiddenFromSidebar: false, notifyOnUpdatesEnabled: false });
export function productCommand(action: ProductIntent["action"] = "create", kind: ProductIntent["kind"] = "bot", patch: Record<string, unknown> = {}): ProductIntent {
  return normalizeProductIntent({ requestId: randomUUID(), action, kind, ...(action === "create" ? {
    profile: { name: "New product", description: "Declared instructions" }, ...(kind === "bot" ? { harness: "box", deferStart: true } : { memberIds: [P_A, P_B] }),
  } : { targetId: kind === "bot" ? P_A : P_GROUP,
    ...(action === "update" ? { profile: { name: "Updated product" } } : action === "members" ? { memberIds: [P_A, P_B] } : action === "hidden" || action === "notify" ? { value: true } : {}),
  }), ...patch });
}
const WRITE = new Set(["createAgent", "createGroup", "updateAgent", "deleteAgent", "duplicateAgent", "setGroupMembers", "setAgentNotifyOnUpdates", "setAgentHiddenFromSidebar"]);
/** Actual native HTTP + management HTTP + original SQLite. Native facts and
 * delete cleanup are synthetic capabilities; no installed Host, Bot or VNC is used. */
export async function productFixture() {
  const root = await mkdtemp(join(tmpdir(), "native-product-")), discoveryPath = join(root, "gateway.json");
  const state = { rows: new Map<string, Record<string, any>>([[P_A, productRow(P_A)], [P_B, productRow(P_B)], [P_GROUP, productRow(P_GROUP, true)]]),
    calls: [] as Array<{ method: string; input: any }>, writes: 0, cleanupCalls: 0, scopeId: P_SCOPE, owner: true,
    token: "synthetic-product-native", startedAt: 1000, failNative: false, failAfterWrite: false, failWriteStatus: 503, failReadBack: false,
    filterMembers: false, failCleanup: false, nativeCleanup: false, routines: [] as unknown[], transcript: [] as unknown[],
    holdWrite: undefined as undefined | (() => Promise<void>), afterWrite: undefined as undefined | (() => Promise<void>),
    beforeCommit: undefined as undefined | ((label: string) => Promise<void>), afterCommit: undefined as undefined | ((label: string) => Promise<void>),
    grants: [
      { principalId: "owner", tokenSha256: hash(P_OWNER), capabilities: [...CAPABILITIES] },
      { principalId: "other", tokenSha256: hash(P_OTHER), capabilities: [...CAPABILITIES] },
      { principalId: "reader", tokenSha256: hash(P_READER), capabilities: ["products.read", "operations.read", "messages.read", "routines.read"] },
    ] as AccessGrant[],
  };
  const gateway = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${state.token}`) { response.writeHead(401).end("{}"); return; }
      let text = ""; for await (const bytes of request) text += bytes.toString();
      const input = JSON.parse(text || "{}"), method = (request.url ?? "").slice("/api/".length);
      state.calls.push({ method, input }); response.setHeader("content-type", "application/json");
      if (state.failNative) { response.writeHead(503).end("{}"); return; }
      let output: unknown;
      if (method === "listAgents") {
        if (state.failReadBack && state.writes > 0) { response.writeHead(503).end("{}"); return; }
        output = [...state.rows.values()];
      } else if (method === "getHostStatus") {
        const proof = ownedOwnershipSnapshot(input.grokboxOwnershipAgentIds, { scopeId: state.scopeId });
        for (const row of proof.agents) {
          if (!state.rows.has(row.agentId) || state.rows.get(row.agentId)!.isGroup) {
            Object.assign(row, { serverEvidence: "not_returned", server: null, local: { before: null, after: null, stable: true } });
          } else {
            row.server.viewerIsOwner = state.owner;
            const harness = state.rows.get(row.agentId)!.harness;
            row.server.harness = harness; row.local.before.harness = harness; row.local.after.harness = harness;
          }
        }
        output = { grokboxOwnership: proof };
      } else if (method === "getAgentAutomations") output = state.routines;
      else if (method === "getAgentTranscriptTail") output = { entries: state.transcript, nextBeforeSeq: null };
      else if (WRITE.has(method)) {
        await state.holdWrite?.(); state.writes++;
        const row = state.rows.get(input.id);
        if (method === "createAgent" || method === "createGroup") {
          const id = randomUUID(), group = method === "createGroup";
          const created = { ...productRow(id, group), ...Object.fromEntries(["name", "description", "title", "avatarShape", "avatarColor"].filter(k => k in input).map(k => [k, input[k]])),
            ...(group ? { memberIds: input.memberAgentIds.filter((member: string) => state.rows.has(member)).slice(0, 6) } : { harness: input.harness }) };
          state.rows.set(id, created); output = { agent: created, transcript: [] };
        } else if (method === "duplicateAgent") {
          if (!row) { response.writeHead(404).end("{}"); return; }
          const id = randomUUID(), created = { ...structuredClone(row), id }; state.rows.set(id, created); output = { agent: created, transcript: [] };
        } else if (method === "deleteAgent") {
          state.rows.delete(input.id);
          for (const value of state.rows.values()) if (value.isGroup) value.memberIds = value.memberIds.filter((id: string) => id !== input.id);
          output = { transcript: [], ...(state.nativeCleanup ? { desktop: { display: 3, outcome: "stopped" } } : {}) };
        } else if (method === "updateAgent") { if (row) Object.assign(row, input.profile); output = row ?? null; }
        else if (method === "setGroupMembers") {
          const members = input.memberAgentIds.filter((id: string) => state.rows.has(id) && !state.rows.get(id)!.isGroup).slice(0, state.filterMembers ? 1 : 6);
          if (row && members.length) row.memberIds = members; output = row ?? null;
        } else if (method === "setAgentHiddenFromSidebar") { if (row) row.isHiddenFromSidebar = input.isHidden; output = null; }
        else if (method === "setAgentNotifyOnUpdates") { if (row) row.notifyOnUpdatesEnabled = input.isEnabled; output = null; }
        await state.afterWrite?.();
        if (state.failAfterWrite) { response.writeHead(state.failWriteStatus).end("{}"); return; }
      } else { response.writeHead(404).end("{}"); return; }
      response.end(JSON.stringify(output));
    } catch { if (!response.destroyed) response.writeHead(500).end("{}"); }
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); const address = gateway.address(); if (!address || typeof address === "string") throw Error("product-native-listen");
  const publishDiscovery = () => publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: address.port, pid: 4242, startedAt: state.startedAt, token: state.token });
  await publishDiscovery();
  const config = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled", continuity: { enabled: false } } });
  await publishConfigFile(join(root, "config.json"), config);
  const native = createManagementGateway({ discoveryPath, configurationRoot: root, timeoutMs: 1500 });
  const hooks: ProductManagementHooks = { store: { beforeCommit: label => state.beforeCommit?.(label) ?? Promise.resolve(), afterCommit: label => state.afterCommit?.(label) ?? Promise.resolve() },
    cleanup: async () => { state.cleanupCalls++; if (state.failCleanup) throw Error("synthetic-cleanup-failed"); return { display: 3, outcome: "stopped" }; } };
  const options = { store: openRuntimeStore(root, {}), installationId: P_INSTALL, native, allowedOrigins: ["https://products.example.test"], env: {}, port: 0,
    readGrants: async () => structuredClone(state.grants) };
  let server = await startManagementServer(options, { products: hooks }); options.port = Number(new URL(server.url).port);
  config.client.currentProfile = "default"; config.client.profiles = { default: { serverUrl: server.url, installationId: P_INSTALL, daemonTokenRef: "env:SYNTHETIC_PRODUCT_CREDENTIAL" } };
  await publishConfigFile(join(root, "config.json"), config);
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: P_INSTALL, role: "box", root, daemon: { tokenSha256: hash(P_OWNER) } });
  await publishLayoutAliases(root, root, P_INSTALL);
  return { root, native, options, state, hooks, get server() { return server; },
    client: (token = P_OWNER, transport?: typeof fetch) => new ManagementClient({ baseUrl: server.url, installationId: P_INSTALL, credential: async () => token,
      fetch: transport ?? (async (input, init) => { const headers = new Headers(init?.headers); headers.set("connection", "close"); return fetch(input, { ...init, headers }); }) as typeof fetch }),
    restart: async () => { await server.close(); server = await startManagementServer(options, { products: hooks }); },
    rotateToken: async () => { state.token = "synthetic-product-rotated"; await publishDiscovery(); },
    revoke: (cap: Capability) => { state.grants[0]!.capabilities = state.grants[0]!.capabilities.filter(c => c !== cap); },
    close: async () => { try { await server.close(); } finally { gateway.closeAllConnections(); await new Promise<void>(r => gateway.close(() => r())); await rm(root, { recursive: true, force: true }); } },
  };
}
