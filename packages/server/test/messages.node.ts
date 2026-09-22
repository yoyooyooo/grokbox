import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagementClient, CAPABILITIES, botRef } from "@grokbox/client";
import { openRuntimeStore, type ContinuityGateway } from "@grokbox/box-runtime/runtime";
import { parseModelsFile, applyUse } from "@grokbox/runtime-kernel/selection";
import { startManagementServer, type AccessGrant, type ManagementNative } from "../src/server.ts";
import { ownedOwnershipReader } from "../../box-runtime/test/ownership-fixture.ts";

const INSTALLATION = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OWNER = "message-owner";
const READER = "message-reader";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grokbox-message-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = openRuntimeStore(root, {});
  await store.saveModels(applyUse(parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: {} } }), "stub/echo"));
  const calls = { send: 0, transcript: 0, sourceChanged: false };
  let lastNonce: string | undefined;
  const discovery = { baseUrl: "http://native.invalid", pid: 123, startedAt: 1 };
  const transcript = (nonce?: string) => ({ entries: [
    { id: "u1", role: "user", text: "hello", clientNonce: nonce ?? null, rootId: "root-1", observedAtMs: 1 },
    { id: "a1", role: "assistant", text: "ack", rootId: "root-1", observedAtMs: 2 },
  ] });
  const gateway: ContinuityGateway = {
    rpc: async (method, input) => {
      if (method === "sendPrompt") {
        calls.send++;
        if (calls.sourceChanged) throw new Error("source_changed");
        lastNonce = typeof input.clientNonce === "string" ? input.clientNonce : undefined;
        return { result: { accepted: true, queued: true, nativeNonce: input.clientNonce }, discovery };
      }
      if (method === "getAgentTranscriptTail") { calls.transcript++; return { result: transcript(lastNonce), discovery }; }
      if (method === "listAgents") return { result: [{ id: BOT, name: "First", isGroup: false }], discovery };
      throw new Error(`unexpected_${method}`);
    },
    listAgents: async () => ({ agents: [{ id: BOT, name: "First", isGroup: false }], discovery }),
    getAgentOwnership: async () => ({ result: {}, discovery }),
    currentStateControl: async () => ({ result: {}, discovery }),
    routineProvision: async () => ({ result: {}, discovery }),
    agentRoutines: async () => ({ result: {}, discovery }),
  };
  const native: ManagementNative = {
    listBots: async () => ({ bots: [{ id: BOT, name: "First", title: null, description: null, nativeHarness: "box", hidden: false, running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [] }], source: { kind: "native-gateway", generation: "a".repeat(64), pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" }),
    ownershipRead: async (ids, _signal) => ownedOwnershipReader(process.pid)(ids, new AbortController().signal),
    continuityAccess: () => gateway,
  };
  const grants: AccessGrant[] = [
    { principalId: "owner", tokenSha256: digest(OWNER), capabilities: [...CAPABILITIES] },
    { principalId: "reader", tokenSha256: digest(READER), capabilities: ["messages.read", "bots.read", "operations.read"] },
  ];
  const options = { root, store, native, installationId: INSTALLATION, readGrants: async () => grants };
  const server = await startManagementServer(options, { hostHealth: { enabled: false } });
  cleanup.push(() => server.close());
  const client = (credential = OWNER) => new ManagementClient({ baseUrl: server.url, installationId: INSTALLATION, credential: async () => credential });
  return { root, options, server, client, calls, botRef: botRef(INSTALLATION, BOT) };
}

test("message input persists one submission, supports original lookup, and observes bounded delivery", async () => {
  const f = await fixture();
  const requestId = randomUUID(), clientNonce = randomUUID();
  const input = { requestId, botRef: f.botRef, text: "hello", clientNonce };
  const first = await f.client().sendMessage(input);
  assert.equal(first.data.state, "accepted");
  assert.equal(first.data.operationRef, `message-operation:${INSTALLATION}:${BOT}:${requestId}`);
  assert.equal(first.data.submissionRef, `submission:${INSTALLATION}:${BOT}:${requestId}`);
  assert.equal(first.data.association.queue, "queued");
  assert.equal(first.data.association.turn, "not-observed");
  assert.equal(first.data.association.run, "not-observed");
  const second = await f.client().sendMessage(input);
  assert.deepEqual(second.data, first.data);
  assert.equal(f.calls.send, 1);
  const lookup = await f.client().messageOperation(requestId);
  assert.deepEqual(lookup.data, first.data);
  const delivery = await f.client().messageDelivery(requestId);
  assert.equal(delivery.data.state, "response-observed");
  assert.equal(delivery.data.association.queue, "queued");
  assert.equal(delivery.data.association.terminal, "not-observed");
  assert.ok(delivery.data.entries.length <= 200);
  assert.ok(f.calls.transcript >= 1);
});

test("message uncertainty and idempotency never replay the native write", async () => {
  const f = await fixture();
  const requestId = randomUUID(), clientNonce = randomUUID();
  const input = { requestId, botRef: f.botRef, text: "hello", clientNonce };
  await f.client().sendMessage(input);
  await assert.rejects(f.client().sendMessage({ ...input, text: "different" }), error => {
    assert.equal((error as { code?: string }).code, "idempotency_conflict"); return true;
  });
  assert.equal(f.calls.send, 1);
  assert.equal((await f.client().messageOperation(requestId)).data.requestId, requestId);
});

test("generation or receipt uncertainty is retained and never replayed", async () => {
  const f = await fixture();
  const input = { requestId: randomUUID(), botRef: f.botRef, text: "hello", clientNonce: randomUUID() };
  f.calls.sourceChanged = true;
  await assert.rejects(f.client().sendMessage(input), error => {
    assert.equal((error as { code?: string }).code, "operation_unknown"); return true;
  });
  assert.equal(f.calls.send, 1);
  assert.equal((await f.client().messageOperation(input.requestId)).data.state, "unknown");
  await assert.rejects(f.client().sendMessage(input), error => {
    assert.equal((error as { code?: string }).code, "operation_unknown"); return true;
  });
  assert.equal(f.calls.send, 1);
});

test("message writes enforce capability before the native owner", async () => {
  const f = await fixture();
  await assert.rejects(f.client(READER).sendMessage({ requestId: randomUUID(), botRef: f.botRef, text: "hello", clientNonce: randomUUID() }), error => {
    assert.equal((error as { code?: string }).code, "permission_denied"); return true;
  });
  assert.equal(f.calls.send, 0);
});
