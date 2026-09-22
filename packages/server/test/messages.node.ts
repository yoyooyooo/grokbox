import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagementClient, CAPABILITIES, botRef, type MessageEntry } from "@grokbox/client";
import { openRuntimeStore, type ContinuityGateway } from "@grokbox/box-runtime/runtime";
import { applyUse, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { startManagementServer, type AccessGrant, type ManagementNative } from "../src/server.ts";
import { ownedOwnershipReader } from "../../box-runtime/test/ownership-fixture.ts";

const I = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const OWNER = "message-owner";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function nativeGateway(state: { entries: MessageEntry[]; sends: number; failSend: boolean }): ContinuityGateway {
  const discovery = { baseUrl: "http://127.0.0.1:19001", pid: process.pid, startedAt: 1 };
  return {
    rpc: async (method, input) => {
      if (method === "sendPrompt") {
        state.sends++;
        if (state.failSend) throw new Error("native_timeout");
        const nonce = typeof input.clientNonce === "string" ? input.clientNonce : null;
        state.entries.push({ id: "user-" + state.sends, role: "user", text: typeof input.prompt === "string" ? input.prompt : null, observedAtMs: Date.now(), clientNonce: nonce, rootId: "user-" + state.sends, truncated: false });
        return { result: { accepted: true }, discovery };
      }
      if (method === "getAgentTranscriptTail") return { result: { entries: state.entries }, discovery };
      if (method === "listAgents") return { result: [], discovery };
      return { result: {}, discovery };
    },
    listAgents: async timeoutMs => ({ agents: [], discovery }),
    getAgentOwnership: async () => ({ result: {}, discovery }),
    currentStateControl: async () => ({ result: {}, discovery }),
    routineProvision: async () => ({ result: {}, discovery }),
    agentRoutines: async () => ({ result: {}, discovery }),
  };
}

test("message API persists one submission, reads the original request, and associates only a bounded native transcript", async () => {
  const root = await mkdtemp(join("/tmp", "grokbox-message-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const disk = openRuntimeStore(root, {});
  await disk.saveModels(applyUse(parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: {} } }), "stub/echo"));
  const state = { entries: [] as MessageEntry[], sends: 0, failSend: false };
  const gateway = nativeGateway(state);
  const native: ManagementNative = {
    listBots: async () => ({ bots: [{ id: A, name: "Message Bot", title: null, description: null, nativeHarness: "box", hidden: false, running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [] }], source: { kind: "native-gateway", generation: "a".repeat(64), pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" }),
    ownershipRead: async (agentIds, signal) => ownedOwnershipReader(process.pid)(agentIds, signal.aborted ? new AbortController().signal : signal),
    continuityAccess: () => gateway,
  };
  const grants: AccessGrant[] = [{ tokenSha256: digest(OWNER), principalId: "owner", capabilities: [...CAPABILITIES] }];
  const serverOptions = { store: disk, installationId: I, native, readGrants: async () => grants, env: {} };
  let server = await startManagementServer(serverOptions);
  cleanup.push(() => server.close());
  const client = () => new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => OWNER });
  const requestId = randomUUID();
  const nonce = randomUUID();
  const target = botRef(I, A);
  const first = await client().sendMessage({ requestId, botRef: target, text: "hello", clientNonce: nonce });
  assert.equal(first.data.state, "accepted");
  assert.equal(state.sends, 1);
  const replay = await client().sendMessage({ requestId, botRef: target, text: "hello", clientNonce: nonce });
  assert.deepEqual(replay.data, first.data);
  assert.equal(state.sends, 1);
  state.entries.push({ id: "later-unrelated", role: "assistant", text: "unrelated reply", observedAtMs: Date.now(), clientNonce: null, rootId: null, truncated: false });
  const recorded = await client().messageDelivery(requestId);
  assert.equal(recorded.data.state, "recorded");
  state.entries.push({ id: "reply", role: "assistant", text: "reply", observedAtMs: Date.now(), clientNonce: null, rootId: "user-1", truncated: false });
  const replied = await client().messageDelivery(requestId);
  assert.equal(replied.data.state, "response-observed");
  assert.equal(replied.data.operation.association.delivery, "response-observed");
  const readback = await client().messageOperation(requestId);
  assert.equal(readback.data.association.delivery, "response-observed");
  await server.close();
  server = await startManagementServer(serverOptions);
  const afterRestart = await client().messageOperation(requestId);
  assert.equal(afterRestart.data.operationRef, first.data.operationRef);
  assert.equal(state.sends, 1);
});

test("unknown native outcome is retained and a second send never replays it", async () => {
  const root = await mkdtemp(join("/tmp", "grokbox-message-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const disk = openRuntimeStore(root, {});
  await disk.saveModels(applyUse(parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: {} } }), "stub/echo"));
  const state = { entries: [] as MessageEntry[], sends: 0, failSend: true };
  const native: ManagementNative = {
    listBots: async () => ({ bots: [{ id: A, name: "Message Bot", title: null, description: null, nativeHarness: "box", hidden: false, running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [] }], source: { kind: "native-gateway", generation: "a".repeat(64), pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" }),
    ownershipRead: async (agentIds, signal) => ownedOwnershipReader(process.pid)(agentIds, signal.aborted ? new AbortController().signal : signal),
    continuityAccess: () => nativeGateway(state),
  };
  const grants: AccessGrant[] = [{ tokenSha256: digest(OWNER), principalId: "owner", capabilities: [...CAPABILITIES] }];
  const server = await startManagementServer({ store: disk, installationId: I, native, readGrants: async () => grants, env: {} });
  cleanup.push(() => server.close());
  const client = new ManagementClient({ baseUrl: server.url, installationId: I, credential: async () => OWNER });
  const input = { requestId: randomUUID(), botRef: botRef(I, A), text: "uncertain", clientNonce: randomUUID() };
  await assert.rejects(client.sendMessage(input), error => error instanceof Error && "code" in error && error.code === "operation_unknown");
  assert.equal(state.sends, 1);
  await assert.rejects(client.sendMessage(input), error => error instanceof Error && "code" in error && error.code === "operation_unknown");
  assert.equal(state.sends, 1);
});
