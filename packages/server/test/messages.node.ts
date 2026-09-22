import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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
  const calls = { send: 0, transcript: 0, sourceChanged: false, interleaved: false, transcriptSourceChanged: false, expectedGenerations: [] as Array<string | undefined> };
  let lastNonce: string | undefined;
  let entries: unknown[] | undefined, sourceUnavailable = false, accepted = true, ack: unknown;
  const transcriptPins: unknown[] = [];
  const signals: AbortSignal[] = [];
  const discovery = { baseUrl: "http://native.invalid", pid: 123, startedAt: 1 };
  const transcript = (nonce?: string) => ({ entries: [
    { id: "u1", kind: "message", role: "user", content: "hello", clientNonce: nonce ?? null, requestId: "native-first", rootId: "root-1", timestampMs: 1 },
    { id: "a1", kind: "send-message", requestId: "native-first", isStreaming: false, message: { type: "user", content: "ack" }, rootId: "root-1", timestampMs: 2 },
  ] });
  const gateway: ContinuityGateway = {
    rpc: async (method, input, options) => {
      if (method === "sendPrompt") {
        calls.send++;
        if (calls.sourceChanged) throw new Error("source_changed");
        lastNonce = typeof input.clientNonce === "string" ? input.clientNonce : undefined;
        return { result: ack ?? { accepted, queued: true, nativeNonce: input.clientNonce }, discovery };
      }
      if (method === "getAgentTranscriptTail") {
        calls.transcript++; transcriptPins.push(options.expectedGeneration);
        calls.expectedGenerations.push(options.expectedGeneration);
        const interleaved = [
          { id: "u1", kind: "message", role: "user", content: "hello", clientNonce: lastNonce, requestId: "native-first" },
          { id: "a-other", kind: "message", role: "assistant", content: "other", clientNonce: randomUUID(), requestId: "other" },
          { id: "u-other", kind: "message", role: "user", content: "other input", clientNonce: randomUUID(), requestId: "other" },
        ];
        return { result: entries ? { entries } : calls.interleaved ? { entries: interleaved } : transcript(lastNonce),
          discovery: calls.transcriptSourceChanged ? { ...discovery, pid: 124 } : discovery };
      }
      if (method === "listAgents") return { result: [{ id: BOT, name: "First", isGroup: false }], discovery };
      throw new Error(`unexpected_${method}`);
    },
    listAgents: async () => { if (sourceUnavailable) throw Error("unavailable");
      return { agents: [{ id: BOT, name: "First", isGroup: false }], discovery }; },
    getAgentOwnership: async () => ({ result: {}, discovery }),
    currentStateControl: async () => ({ result: {}, discovery }),
    routineProvision: async () => ({ result: {}, discovery }),
    agentRoutines: async () => ({ result: {}, discovery }),
  };
  const native: ManagementNative = {
    listBots: async () => ({ bots: [{ id: BOT, name: "First", title: null, description: null, nativeHarness: "box", hidden: false, running: false, runningTurn: false, updatedAt: null, textTruncated: false, truncatedFields: [] }], source: { kind: "native-gateway", generation: "a".repeat(64), pid: process.pid, startedAt: 1, observedAt: Date.now() }, coverage: "current-snapshot" }),
    ownershipRead: async (ids, _signal) => ownedOwnershipReader(process.pid)(ids, new AbortController().signal),
    continuityAccess: signal => { signals.push(signal); return gateway; },
  };
  const grants: AccessGrant[] = [
    { principalId: "owner", tokenSha256: digest(OWNER), capabilities: [...CAPABILITIES] },
    { principalId: "reader", tokenSha256: digest(READER), capabilities: ["messages.read", "bots.read", "operations.read"] },
  ];
  const options = { root, store, native, installationId: INSTALLATION, readGrants: async () => grants };
  const server = await startManagementServer(options, { hostHealth: { enabled: false } });
  cleanup.push(() => server.close());
  const client = (credential = OWNER) => new ManagementClient({ baseUrl: server.url, installationId: INSTALLATION, credential: async () => credential });
  return { root, options, server, client, calls, discovery, transcriptPins, signals,
    setEntries: (rows: unknown[]) => { entries = rows; },
    moveGeneration: () => { discovery.startedAt++; },
    unavailable: () => { sourceUnavailable = true; },
    refuse: () => { accepted = false; },
    setAck: (value: unknown) => { ack = value; },
    botRef: botRef(INSTALLATION, BOT) };
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


const nativeEntries = (nonce: string, requestId = "native-request") => [
  { id: "echo", kind: "message", role: "user", content: "hello", clientNonce: nonce, requestId, timestampMs: 1 },
  { id: "delivery", kind: "send-message", requestId, isStreaming: false, message: { type: "user", content: "reply" }, timestampMs: 2 },
];
const sendInput = (f: Awaited<ReturnType<typeof fixture>>) => ({ requestId: randomUUID(), botRef: f.botRef, text: "hello", clientNonce: randomUUID() });

test("delivery requires an exact native request association, not an adjacent assistant", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input);
  f.setEntries([
    nativeEntries(input.clientNonce)[0],
    { id: "other-user", kind: "message", role: "user", clientNonce: randomUUID(), requestId: "other-request", content: "other" },
    { id: "other-assistant", role: "assistant", text: "not this reply" },
    nativeEntries("other", "other-request")[1],
  ]);
  const reply = await f.client().messageDelivery(input.requestId);
  assert.equal(reply.data.state, "recorded");
  f.setEntries(nativeEntries(input.clientNonce));
  const exact = await f.client().messageDelivery(input.requestId);
  assert.equal(exact.data.state, "response-observed");
  assert.equal(exact.data.association.terminal, "not-observed");
  assert.equal(exact.data.entries.find(e => e.id === "delivery")?.text, "reply");
});

test("streaming, wrong recipient and ambiguous nonce records are not completed delivery", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input);
  const [echo, reply] = nativeEntries(input.clientNonce);
  for (const candidate of [ { ...reply, isStreaming: true }, { ...reply, message: { type: "agent", content: "DM" } } ]) {
    f.setEntries([echo, candidate]);
    assert.equal((await f.client().messageDelivery(input.requestId)).data.state, "recorded");
  }
  f.setEntries([echo, nativeEntries(input.clientNonce, "another-native-request")[0], reply]);
  assert.equal((await f.client().messageDelivery(input.requestId)).data.state, "unknown");
});

test("delivery pins the dispatch generation and refuses a different native generation", async () => {
  const f = await fixture(), input = sendInput(f);
  const op = (await f.client().sendMessage(input)).data;
  f.setEntries(nativeEntries(input.clientNonce)); f.moveGeneration();
  const reply = (await f.client().messageDelivery(input.requestId)).data;
  assert.equal(f.transcriptPins[0], op.nativeGeneration);
  assert.equal(reply.state, "unknown"); assert.deepEqual(reply.entries, []);
  assert.equal(f.calls.send, 1);
});

test("lost submission receipt retains the already observed dispatch generation", async () => {
  const f = await fixture(), input = sendInput(f);
  const expected = digest(JSON.stringify([f.discovery.baseUrl, f.discovery.pid, f.discovery.startedAt]));
  f.calls.sourceChanged = true;
  await assert.rejects(f.client().sendMessage(input));
  assert.equal((await f.client().messageOperation(input.requestId)).data.nativeGeneration, expected);
  f.setEntries(nativeEntries(input.clientNonce));
  assert.equal((await f.client().messageDelivery(input.requestId)).data.state, "response-observed");
  assert.equal((await f.client().messageOperation(input.requestId)).data.state, "unknown");
  assert.equal(f.calls.send, 1);
});

test("original accepted operation remains readable by repeated submission when native discovery is down", async () => {
  const f = await fixture(), input = sendInput(f);
  const op = (await f.client().sendMessage(input)).data;
  f.unavailable();
  assert.deepEqual((await f.client().sendMessage(input)).data, op);
  assert.equal(f.calls.send, 1);
});

test("invalid retained operation is not absence and cannot authorize a second send", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input);
  const path = join(f.root, "messages", "owner", `${input.requestId}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...raw, state: "unrecognized" }));
  await assert.rejects(f.client().sendMessage(input));
  assert.equal(f.calls.send, 1);
});

test("an explicit negative native acknowledgement is not accepted or recorded delivery", async () => {
  const f = await fixture(), input = sendInput(f); f.refuse();
  await assert.rejects(f.client().sendMessage(input));
  const op = (await f.client().messageOperation(input.requestId)).data;
  assert.equal(op.state, "unknown"); assert.equal(op.association.delivery, "unknown");
  assert.equal(f.calls.send, 1);
});


test("concurrent repeated input produces one write and closes its operation-owned gateways", async () => {
  const f = await fixture(), input = sendInput(f);
  const [a, b] = await Promise.all([f.client().sendMessage(input), f.client().sendMessage(input)]);
  assert.deepEqual(a.data, b.data); assert.equal(f.calls.send, 1);
  assert.ok(f.signals.length > 0); assert.ok(f.signals.every(signal => signal.aborted));
  assert.equal(a.data.association.delivery, "unknown");
});

test("retained operations enforce installation and principal binding rather than their embedded identity", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input);
  const path = join(f.root, "messages", "owner", `${input.requestId}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  for (const field of ["principalId", "installationId"]) {
    await writeFile(path, JSON.stringify({ ...raw, [field]: field === "principalId" ? "other-owner" : "33333333-3333-4333-8333-333333333333" }));
    await assert.rejects(f.client().messageOperation(input.requestId));
    await assert.rejects(f.client().sendMessage(input));
  }
  assert.equal(f.calls.send, 1);
});

test("server restart reopens the original unknown receipt and never replays it", async () => {
  const f = await fixture(), input = sendInput(f); f.calls.sourceChanged = true;
  await assert.rejects(f.client().sendMessage(input));
  const original = (await f.client().messageOperation(input.requestId)).data;
  await f.server.close();
  const server = await startManagementServer(f.options, { hostHealth: { enabled: false } });
  cleanup.push(() => server.close());
  const client = new ManagementClient({ baseUrl: server.url, installationId: INSTALLATION, credential: async () => OWNER });
  assert.deepEqual((await client.messageOperation(input.requestId)).data, original);
  await assert.rejects(client.sendMessage(input));
  assert.equal(f.calls.send, 1);
});


test("an accepted-only acknowledgement neither proves queueing nor exposes unrelated native payload", async () => {
  const f = await fixture(), input = sendInput(f);
  f.setAck({ accepted: true, token: "PRIVATE_FIXTURE_SENTINEL", prompt: "PRIVATE_FIXTURE_SENTINEL" });
  const result = (await f.client().sendMessage(input)).data;
  assert.equal(result.association.queue, "not-observed");
  assert.equal(result.association.delivery, "unknown");
  assert.deepEqual(result.nativeReceipt, { accepted: true });
  assert.ok(!JSON.stringify(result).includes("PRIVATE_FIXTURE_SENTINEL"));
});

test("bounded delivery waiting can observe a later exact record without resubmitting", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input); f.setEntries([]);
  const timer = setTimeout(() => f.setEntries(nativeEntries(input.clientNonce)), 40);
  try {
    const result = await f.client().messageDelivery(input.requestId, { waitMs: 1000 });
    assert.equal(result.data.state, "response-observed");
    assert.ok(f.calls.transcript >= 2); assert.equal(f.calls.send, 1);
  } finally { clearTimeout(timer); }
});

test("delivery without retained dispatch identity remains unknown without reading another generation", async () => {
  const f = await fixture(), input = sendInput(f);
  await f.client().sendMessage(input);
  const path = join(f.root, "messages", "owner", `${input.requestId}.json`);
  const raw = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...raw, nativeGeneration: null }));
  const result = (await f.client().messageDelivery(input.requestId)).data;
  assert.equal(result.state, "unknown"); assert.deepEqual(result.entries, []);
  assert.equal(f.calls.transcript, 0); assert.equal(f.calls.send, 1);
});

test("delivery requires a native echo and does not infer an interleaved assistant", async () => {
  const f = await fixture();
  const requestId = randomUUID(), clientNonce = randomUUID();
  const input = { requestId, botRef: f.botRef, text: "hello", clientNonce };
  await f.client().sendMessage(input);
  f.calls.interleaved = true;
  const delivery = await f.client().messageDelivery(requestId);
  assert.equal(delivery.data.state, "recorded");
  assert.equal(delivery.data.association.delivery, "recorded");
  assert.equal(delivery.data.entries.filter(entry => entry.role === "assistant").length, 1);
});

test("delivery carries the original generation and refuses a changed transcript source", async () => {
  const f = await fixture();
  const requestId = randomUUID(), clientNonce = randomUUID();
  await f.client().sendMessage({ requestId, botRef: f.botRef, text: "hello", clientNonce });
  f.calls.transcriptSourceChanged = true;
  const delivery = await f.client().messageDelivery(requestId);
  assert.equal(delivery.data.state, "unknown");
  assert.equal(delivery.data.entries.length, 0);
  assert.equal(delivery.data.association.delivery, "unknown");
  assert.equal(f.calls.expectedGenerations.length, 1);
  assert.equal(f.calls.expectedGenerations[0], digest(JSON.stringify(["http://native.invalid", 123, 1])));
});

