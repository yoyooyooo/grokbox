import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementClient, CAPABILITIES, type ContextChange } from "@grokbox/client";
import { defaultConfig, validateConfig } from "@grokbox/runtime-kernel/config";
import { createManagementGateway, openRuntimeStore, publishConfigFile, publishLayoutAliases } from "@grokbox/box-runtime/runtime";
import { createNativeCurrentStateOwner } from "../../../packages/box-runtime/src/internal/host/native-current-state-owner.ts";
import { createNativeCurrentStateRpc } from "../../../packages/box-runtime/src/internal/host/native-current-state-rpc.ts";
import { createNativeCheckpointWorker, type NativeCheckpointWorkerStore } from "../../../packages/box-runtime/src/internal/host/native-checkpoint-worker.ts";
import type { NativeCheckpointSchema } from "../../../packages/box-runtime/src/internal/host/native-checkpoint.ts";
import { ownedOwnershipSnapshot } from "../../../packages/box-runtime/test/ownership-fixture.ts";
import { startManagementServer, type AccessGrant } from "@grokbox/server";

export const C_INSTALL = "11111111-1111-4111-8111-111111111111", C_SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", C_TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C_SCOPE = "e".repeat(64);
export const C_OWNER = "synthetic-context-owner", C_OTHER = "synthetic-context-other", C_READER = "synthetic-context-reader", C_WRITER = "synthetic-context-writer";
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const bytes = (v: string) => new TextEncoder().encode(v), hex = (v: Uint8Array) => Buffer.from(v).toString("hex");
const rootId = bytes("slot"), leafId = bytes("leaf"), qualification = { hostSourceSha: "d".repeat(64), nativeSchema: "synthetic-context-worker-v1" };
/** Synthetic native schema and account, but the actual project owner, RPC,
 * checkpoint worker, SQLite transactions and management program are executed.
 * No live Host/private vendor source/provider or source-file fallback is used. */
export async function contextFixture(origin: string) {
  const root = await mkdtemp(join(tmpdir(), "context-management-")), discoveryPath = join(root, "gateway.json");
  const owner = createNativeCurrentStateOwner({ qualification, generation: "synthetic-context-generation" });
  function agent(id: string, populated: boolean) {
    const db = new DatabaseSync(join(root, `${id}.sqlite`)); db.exec("CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT)");
    const readKv = (key: string): string | null => (db.prepare("SELECT value FROM kv WHERE key=?").get(key) as any)?.value ?? null;
    const writeKv = (key: string, value: string) => { db.prepare("INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); return true; };
    const workerStore: NativeCheckpointWorkerStore = { db: { exec: sql => db.exec(sql), prepare: sql => db.prepare(sql) as never }, isClosed: false,
      blobLengthStmt: db.prepare("SELECT length(data) len FROM blobs WHERE id=?") as never,
      getBlob: key => (db.prepare("SELECT data FROM blobs WHERE id=?").get(hex(key)) as any)?.data,
      setBlob: (key, value) => { db.prepare("INSERT INTO blobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(hex(key), value); } };
    const message = (raw: Uint8Array) => {
      const isSeed = raw.byteLength === 0 || new TextDecoder().decode(raw).startsWith('{"ownedSeed":');
      const parsed = raw.byteLength && isSeed ? JSON.parse(new TextDecoder().decode(raw)) : null;
      let refs: Uint8Array[] = isSeed ? (parsed?.refs ?? []).map((r: string) => Uint8Array.from(Buffer.from(r, "hex"))) : [leafId];
      return { get messages() { return refs; }, get rootPromptMessagesJson() { return refs; }, set rootPromptMessagesJson(v: Uint8Array[]) { refs = v; }, pendingToolCalls: [],
        toBinary: () => isSeed ? bytes(JSON.stringify({ ownedSeed: true, refs: refs.map(hex) })) : Uint8Array.from(raw),
        getType: () => ({ typeName: "agent.v1.ConversationStateStructure", fields: { list: () => [{ localName: "messages", kind: "scalar", repeated: true }] }, runtime: { bin: { listUnknownFields: () => [] } } }) };
    };
    const schema: NativeCheckpointSchema = { root: { fromBinary: message }, isMessage: () => true, referenceTypes: {},
      referenceMetadata: () => ({ fields: [{ localFieldName: "messages", protoFieldName: "messages", blobReferenceType: "json" }] }) };
    const worker = createNativeCheckpointWorker({ store: workerStore, schema, qualification, agentId: id });
    const entries: any[] = populated ? [{ id: "private-history-1", kind: "message", role: "user", content: "PRIVATE_CONTEXT_HISTORY", timestampMs: 1 }] : [];
    const memories: any[] = populated ? [{ content: "PRIVATE_CONTEXT_MEMORY", kind: "profile", createdAt: 1 }] : [];
    let loaded = message(new Uint8Array());
    if (populated) { workerStore.setBlob(rootId, bytes("PRIVATE_NATIVE_ROOT")); workerStore.setBlob(leafId, bytes('{"role":"user","content":"PRIVATE_NATIVE_LEAF"}')); writeKv("root", hex(rootId)); loaded = message(bytes("PRIVATE_NATIVE_ROOT")); }
    const metadata = { readKv, writeKv, deleteKv: (key: string) => db.prepare("DELETE FROM kv WHERE key=?").run(key),
      historyPosition: (entry: string | null) => entry === null ? entries.length : entries.findIndex(e => e.id === entry) < 0 ? null : entries.findIndex(e => e.id === entry) + 1,
      getTranscriptTail: (_q: unknown) => ({ entries }), getPendingAutomationCompletions: () => [],
      compareAndSetLatestRootBlobId: (v: { expectedRoot: Uint8Array; nextRoot: Uint8Array }) => { if ((readKv("root") ?? "") !== hex(v.expectedRoot)) return false; writeKv("root", hex(v.nextRoot)); return true; } };
    const store = { getMetadata: () => Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")), getConversationStateStructure: () => loaded,
      resetFromDb: async () => { const key = Uint8Array.from(Buffer.from(readKv("root") ?? "", "hex")); loaded = message(key.length ? workerStore.getBlob(key) ?? new Uint8Array() : new Uint8Array()); },
      getBlobStore: () => ({ grokboxCurrentState: async (action: "capture" | "compose" | "prepare" | "apply" | "observe" | "release", value: unknown) => worker[action](value) }) };
    owner.register(id, { store, metadata, ctx: {}, rootId, source: qualification, valid: () => true, material: {
      memory: { listMemories: (n: number) => memories.slice(0, n), countMemories: () => memories.length,
        addMemory: (content: string, createdAt: number, kind: string) => { if (!memories.some(m => m.content === content)) memories.push({ content, createdAt, kind }); } },
      history: { getTranscriptTail: (q: { limit: number }) => ({ entries: entries.slice(-q.limit) }), getEntryById: (key: string) => entries.find(e => e.id === key),
        appendTranscriptEntries: (values: unknown[]) => { for (const e of values as any[]) if (!entries.some(v => v.id === e.id)) entries.push(structuredClone(e)); return true; } } } });
    return { store, metadata, workerStore, memories, entries, close: () => db.close() };
  }
  const source = agent(C_SOURCE, true), target = agent(C_TARGET, false), nativeRpc = createNativeCurrentStateRpc(owner, "c".repeat(64));
  const state = { calls: [] as string[], failNative: false, loseAfter: "", slowAction: "", stallAfter: "", stalled: 0, aborted: 0, badHead: false, ownershipAge: 0, temporal: false,
    grants: [ { principalId: "owner", tokenSha256: hash(C_OWNER), capabilities: [...CAPABILITIES] },
      { principalId: "other", tokenSha256: hash(C_OTHER), capabilities: [...CAPABILITIES] },
      { principalId: "reader", tokenSha256: hash(C_READER), capabilities: ["context.read", "operations.read", "console.grants.create"] },
      { principalId: "writer", tokenSha256: hash(C_WRITER), capabilities: ["context.read", "context.write", "operations.read", "console.grants.create"] } ] as AccessGrant[] };
  const ownership = () => ({ grokboxOwnership: ownedOwnershipSnapshot([C_SOURCE, C_TARGET], { scopeId: C_SCOPE, nowMs: Date.now() - state.ownershipAge,
    serverHarness: state.temporal ? "temporal" : "box", localHarness: state.temporal ? "temporal" : "box" }) });
  const gateway = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer synthetic-context-native") { res.writeHead(401); res.end(); return; }
      let text = ""; for await (const b of req) text += b.toString(); const input = JSON.parse(text);
      const action = req.url === "/api/grokboxCurrentStateControl" ? String(input.action) : req.url!; state.calls.push(action);
      if (state.failNative) { res.writeHead(503); res.end(); return; }
      if (action === state.slowAction) { state.stalled++; res.once("close", () => state.aborted++); return; }
      const result: any = req.url === "/api/getHostStatus" ? ownership() : req.url === "/api/grokboxCurrentStateControl" ? await nativeRpc(input, async () => ownership()) : { unsupported: true };
      if (state.stallAfter === action) { state.stalled++; res.once("close", () => state.aborted++); return; }
      if (state.loseAfter === action) { state.loseAfter = ""; res.destroy(); return; }
      if (state.badHead && action === "head" && result?.data?.head) result.data.head.agentId = randomUUID();
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); const address = gateway.address(); if (!address || typeof address === "string") throw Error("fixture-listen");
  await publishConfigFile(discoveryPath, { scheme: "http", host: "127.0.0.1", port: address.port, pid: 4242, startedAt: 1000, token: "synthetic-context-native" });
  const config = validateConfig({ ...defaultConfig(), runtime: { desiredMode: "disabled", continuity: { enabled: false } } }); await publishConfigFile(join(root, "config.json"), config);
  const native = createManagementGateway({ discoveryPath, configurationRoot: root, timeoutMs: 1000 });
  const hooks: NonNullable<NonNullable<Parameters<typeof startManagementServer>[1]>["context"]>["hooks"] = {};
  const options = { store: openRuntimeStore(root, {}), installationId: C_INSTALL, native, allowedOrigins: [origin], env: {}, port: 0, readGrants: async () => structuredClone(state.grants) };
  let server = await startManagementServer(options, { hostHealth: { enabled: false }, context: { hooks } }); options.port = Number(new URL(server.url).port);
  config.client.currentProfile = "default"; config.client.profiles = { default: { serverUrl: server.url, installationId: C_INSTALL, daemonTokenRef: "env:SYNTHETIC_CONTEXT_CREDENTIAL" } };
  await publishConfigFile(join(root, "config.json"), config); await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: C_INSTALL, role: "box", root, daemon: { tokenSha256: hash(C_OWNER) } });
  await publishLayoutAliases(root, root, C_INSTALL);
  const client = (token = C_OWNER, transport?: typeof fetch) => new ManagementClient({ baseUrl: server.url, installationId: C_INSTALL, credential: async () => token,
    fetch: transport ?? (async (url, init) => { const headers = new Headers(init?.headers); headers.set("connection", "close"); return fetch(url, { ...init, headers }); }) as typeof fetch });
  return { root, state, source, target, owner, native, options, hooks, get server() { return server; }, client,
    declaration: async (action: ContextChange["action"], bot = C_SOURCE, snapshotRef?: string) => ({ requestId: randomUUID(), botRef: bot, scopeId: C_SCOPE, expectedRevision: (await client().context(bot)).data.revision,
      confirmed: true, action, ...(snapshotRef ? { snapshotRef } : {}) }) as ContextChange,
    restart: async () => { await server.close(); server = await startManagementServer(options, { hostHealth: { enabled: false }, context: { hooks } }); },
    close: async () => { try { await server.close(); } finally { gateway.closeAllConnections(); await new Promise<void>(r => gateway.close(() => r())); source.close(); target.close(); await rm(root, { recursive: true, force: true }); } } };
}
