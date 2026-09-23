import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { botRef } from "@grokbox/client";
import type { ContinuityGateway } from "../../src/runtime.ts";
import { messageApplication } from "../../../server/src/messages.ts";
import { requireCapability, type Principal } from "../../../server/src/access.ts";
import { nativeMessageCode } from "./native-message-code.ts";
import { bindHostOwnershipRead, HOST_OWNERSHIP_READ_SYMBOL } from "../../src/internal/host/ownership-read.ts";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function call(target: Record<string, any>, method: string, ...args: unknown[]): any {
  try { assert.equal(typeof target[method], "function"); return target[method](...args); }
  catch (error) { throw Error("native_message_execution:" + (error instanceof Error ? error.message : "unknown")); }
}
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const INSTALLATION = "11111111-1111-4111-8111-111111111111";
let reported = false;
async function fixture(active = true) {
  const root = await mkdtemp(join(tmpdir(), "owned-native-message-"));
  let database: Record<string, any>;
  let account = "a".repeat(64);
  const auth = { peekAccessToken: () => account, getAccessToken: async () => "SYNTHETIC_ONLY", getTeamId: async () => 7, getMachineId: async () => "owned-machine" };
  const extensions = { api: (name: string) => name === "auth" ? auth : name === "host-upgrade" ? { getVersionState: () => ({}) }
    : name === "resume-ownership" ? { getSettledHostWindow: () => ({ kind: "inactive" }) }
    : name === "turn-execution" ? { isLocalWorkAllowed: true, canExecute: true } : { reportMessageSent: () => undefined } };
  const native = nativeMessageCode({
    [Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)]: bindHostOwnershipRead(),
    BASE_HOST_CAPABILITIES: [], GrokBotService: {}, tokenSubjectScope: (token: string) => token,
    createSandCursorBackendClient: () => ({ listGrokBotAgents: async () => ({ agents: [{ agentId: BOT, id: "owned-server", harness: "box", viewerIsOwner: true }] }) }),
    getSandAgentsRootDir: () => "/owned", getSandProfilePath: (path: string) => path,
    readSandProfileHarness: () => "box", readSandProfileServerId: () => "owned-server",
    getTranscript: () => call(database, "getTranscriptEntries"),
    updateEntry: (_id: string, update: () => unknown) => update(),
  }) as Record<string, any>;
  const file = join(root, "transcript.sqlite");
  let sqlite = new DatabaseSync(file);
  sqlite.exec("CREATE TABLE transcript_entries (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, entry TEXT NOT NULL)");
  database = { ...native.database, agentDirName: BOT, isClosed: false,
    runWrite: (_operation: string, write: () => unknown) => { write(); return true; },
    statements: native.prepare(sqlite), db: sqlite };
  const session = { id: BOT, db: database };
  const effects = { pipeline: 0, other: 0, appended: 0, rpc: 0, observedIds: [] as string[] };
  const noop = () => undefined;
  const tm: Record<string, any> = { sessions: { activeSession: active ? session : { id: OTHER } },
    roster: { applyAgentUpdateToOutline: noop, emit: noop, emitAgentUpdate: noop },
    runLifecycle: { activeRunSession: session, lastRequestIdBySession: new Map(), trackComposingFromUpdate: noop,
      trackRetryingFromUpdate: noop, trackActivityFromUpdate: noop }, voiceCalls: { overhear: noop },
    sessionStore: { markSessionActivity: noop }, ackObligations: { fulfillAckObligation: noop },
    widgetResponses: { scheduleCredentialRequestExpiry: noop, requestCredentialAutoFill: noop },
    appendEntry: (entry: unknown) => { effects.appended++; return call(database, "appendTranscriptEntry", entry); } };
  tm.sendPipeline = { ...native.pipeline, tm, boxRequests: { trackBoxRequestEntry: () => { effects.pipeline++; } },
    validateAiReplyTarget: (message: unknown) => message, applyAutoReplyThread: (message: unknown) => message,
    claimSendAttachmentBatchId: noop };
  const turn = { ...native.turn, tm, activeTurnUserMessageIds: new Map(), activeTurnRequestIds: new Map(),
    activeRequestSources: new Map(), forkTurnSessions: new Set() };
  const reader = { ...native.session, resolveLiveSession: (id: string) => id === BOT ? session : undefined,
    tm: { sessionStore: { readAgentTranscriptTail: (id: string) => { effects.other++; return { entries: [], requestedAgent: id }; } } } };
  const raw = () => call(database, "getTranscriptTail", { limit: 100 });
  const echo = (nonce: string, id = "t0u") => {
    call(database, "appendTranscriptEntry", call(native, "createUserMessage", id, "owned-input", { clientNonce: nonce }));
    turn.activeTurnUserMessageIds.set(BOT, [id]);
  };
  const associate = (request = "native-request") => {
    turn.activeTurnRequestIds.set(BOT, request);
    call(turn, "associateTurnUserMessages", session, request);
  };
  const send = (content = "owned-reply") => call(turn, "handleAgentUpdate",
    { type: "send-message", message: { type: "text", content }, timestampMs: 100 }, session);
  const discovery = { baseUrl: "http://owned.invalid", pid: 123, startedAt: 1 };
  let rejectSend = false;
  let sendBarrier: Promise<void> | undefined;
  const manager = { getActiveAgentId: () => { throw Error("active_target_forbidden"); },
    listAgentsSync: () => [{ id: BOT }],
    sendPrompt: async (_prompt: string, options: Record<string, unknown>) => {
      effects.rpc++; if (sendBarrier) await sendBarrier;
      assert.equal(options.awaitTurn, false); assert.equal(options.agentId, BOT); assert.equal(typeof options.clientNonce, "string");
      if (rejectSend) throw Error("owned_original_rejection");
      echo(String(options.clientNonce));
    },
    getAgentTranscriptTail: (id: string, query: unknown) => { effects.observedIds.push(id); return call(reader, "getAgentTranscriptTail", id, query); } };
  const api = native.gateway(manager, { rosterBookkeeping: {}, extensions, getHealth: () => ({ isBusy: false }), environment: { sendAcceptReturnDisabled: false } });
  const gateway: ContinuityGateway = {
    rpc: async (method, input) => {
      if (method === "sendPrompt" || method === "getAgentTranscriptTail") return { result: await call(api, method, input), discovery };
      throw Error("owned_unexpected_rpc");
    },
    listAgents: async () => ({ agents: [{ id: BOT, name: "owned", harness: "box" }], discovery }),
    getAgentOwnership: async ids => ({ result: (await call(api, "getHostStatus", { grokboxOwnershipAgentIds: ids })).grokboxOwnership, discovery }), currentStateControl: async () => ({ result: {}, discovery }),
    routineProvision: async () => ({ result: {}, discovery }), agentRoutines: async () => ({ result: {}, discovery }),
  };
  const principal: Principal = { id: "owned-principal", capabilities: ["messages.read", "messages.write"] };
  const domain = { root, installationId: INSTALLATION, continuity: () => gateway,
    authorize: async (_signal: AbortSignal, capability: Principal["capabilities"][number]) => { requireCapability(principal, capability); } };
  const submit = async () => {
    const requestId = randomUUID(), clientNonce = randomUUID();
    const request = { requestId, botRef: botRef(INSTALLATION, BOT), clientNonce, text: "owned-input" };
    const operation: unknown = await Effect.runPromise(messageApplication(domain, principal, "POST", new URL("http://owned.invalid/v1/messages"), request));
    return { request, operation };
  };
  const delivery = async (requestId: string): Promise<Record<string, any>> => {
    const result: unknown = await Effect.runPromise(messageApplication(domain, principal, "GET", new URL("http://owned.invalid/v1/message-deliveries/" + requestId)));
    assert.ok(record(result) && Array.isArray(result.entries)); return result;
  };
  if (!reported) { console.log(JSON.stringify({ nativeMessageSource: native.sourceSha, declarations: native.dependencyHashes, fullHostExecuted: false })); reported = true; }
  return { root, native, api, database, turn, reader, session, raw, echo, associate, send, submit, delivery, effects, discovery,
    changeAccount: () => { account = "b".repeat(64); },
    rejectSend: () => { rejectSend = true; },
    holdSend: (barrier: Promise<void>) => { sendBarrier = barrier; },
    reopen: () => { sqlite.close(); sqlite = new DatabaseSync(file); database.db = sqlite; database.statements = native.prepare(sqlite); },
    close: async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const active of [true, false]) test(`original ${active ? "active" : "inactive"} Bot RPC -> request association -> writer -> reopened tail -> management delivery`, async () => {
  const f = await fixture(active);
  try {
    const { request, operation } = await f.submit();
    assert.ok(record(operation)); assert.equal(operation.state, "accepted");
    assert.equal(operation.association.queue, "not-observed"); assert.equal(operation.association.delivery, "unknown");
    f.associate(); f.send(); f.reopen();
    const rows = f.raw().entries;
    assert.equal(rows.length, 2); assert.equal(rows[0].clientNonce, request.clientNonce); assert.equal(rows[0].requestId, "native-request");
    assert.equal(rows[1].message.type, "text"); assert.equal(rows[1].requestId, "native-request");
    assert.equal(Object.hasOwn(rows[1], "isStreaming"), false);
    const result = await f.delivery(request.requestId);
    assert.equal(result.state, "response-observed"); assert.equal(result.entries[1].isStreaming, null);
    assert.equal(result.entries[1].deliveryEvidence, "persisted-text");
    assert.deepEqual(result.association, { queue: "not-observed", run: "not-observed", turn: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "response-observed" });
    assert.equal(f.effects.pipeline, active ? 1 : 0); assert.equal(f.effects.appended, active ? 1 : 0);
    assert.equal(f.effects.rpc, 1); assert.deepEqual(f.effects.observedIds, [BOT]);
  } finally { await f.close(); }
});

test("original association does not overwrite a previous request or bind another Bot's echo", async () => {
  const f = await fixture();
  try {
    const nonce = randomUUID(); f.echo(nonce); f.associate("first"); f.associate("second");
    assert.equal(f.raw().entries[0].requestId, "first");
    f.turn.activeTurnUserMessageIds.set(OTHER, ["t0u"]);
    let touched = false;
    call(f.turn, "associateTurnUserMessages", { id: OTHER, db: { getEntryById: () => null, updateTranscriptEntry: () => { touched = true; } } }, "other");
    assert.equal(touched, false); assert.equal(f.raw().entries[0].requestId, "first");
    assert.deepEqual(call(f.reader, "getAgentTranscriptTail", OTHER, { limit: 10 }), { entries: [], requestedAgent: OTHER });
    assert.equal(f.effects.other, 1);
  } finally { await f.close(); }
});

test("original text deltas cannot produce a persisted SendToUser record", async () => {
  const f = await fixture();
  try {
    const { request } = await f.submit(); f.associate();
    call(f.turn, "handleAgentUpdate", { type: "text-delta", delta: "not-delivery" }, f.session);
    call(f.turn, "handleAgentUpdate", { type: "thinking-delta", delta: "private-reasoning" }, f.session);
    assert.equal(f.raw().entries.length, 1); assert.equal((await f.delivery(request.requestId)).state, "recorded");
  } finally { await f.close(); }
});

test("original wrong request and missing request never become correlated delivery", async () => {
  const f = await fixture();
  try {
    const { request } = await f.submit(); f.associate("expected");
    f.turn.activeTurnRequestIds.delete(BOT); f.send("without request");
    assert.equal((await f.delivery(request.requestId)).state, "recorded");
    f.turn.activeTurnRequestIds.set(BOT, "foreign"); f.send("different request");
    assert.equal((await f.delivery(request.requestId)).state, "recorded");
    f.turn.activeTurnRequestIds.set(BOT, "expected"); f.send("same request");
    assert.equal((await f.delivery(request.requestId)).state, "response-observed");
  } finally { await f.close(); }
});

test("original send API rejection is retained as unknown and never returns an acceptance", async () => {
  const f = await fixture();
  try { f.rejectSend(); await assert.rejects(f.submit()); assert.equal(f.effects.rpc, 1); assert.equal(f.raw().entries.length, 0); }
  finally { await f.close(); }
});

 test("original RPC passes explicit Bot and nonce to the manager before finite acceptance", async () => {
  const f = await fixture();
  try {
    const result = await call(f.api, "sendPrompt", { agentId: BOT, prompt: "owned-input", clientNonce: randomUUID() });
    assert.equal(result.accepted, true); assert.deepEqual(Object.keys(result), ["accepted"]); assert.equal(f.effects.rpc, 1);
  } finally { await f.close(); }
});

 test("original RPC acceptance waits for its manager, not just dispatch", async () => {
  const f = await fixture(); let release!: () => void;
  f.holdSend(new Promise<void>(resolve => { release = resolve; }));
  let accepted = false;
  const pending = call(f.api, "sendPrompt", { agentId: BOT, prompt: "owned-input", clientNonce: randomUUID() }) as Promise<unknown>;
  const done = pending.then(() => { accepted = true; });
  try {
    await Promise.resolve(); assert.equal(f.effects.rpc, 1); assert.equal(accepted, false);
    release(); await done; assert.equal(accepted, true);
  } finally { release(); await done; await f.close(); }
});

test("original tail paging retains exact entry identities across a cold reopen", async () => {
  const f = await fixture();
  try {
    f.echo(randomUUID()); f.associate(); f.send("first"); f.send("second"); f.reopen();
    const page = call(f.database, "getTranscriptTail", { limit: 1 });
    assert.equal(page.entries.length, 1); assert.equal(page.entries[0].message.content, "second");
    assert.equal(typeof page.nextBeforeSeq, "number");
    const prior = call(f.database, "getTranscriptTail", { limit: 2, beforeSeq: page.nextBeforeSeq });
    assert.equal(prior.entries.length, 2); assert.equal(prior.entries[1].message.content, "first");
    assert.notEqual(prior.entries[1].id, page.entries[0].id);
  } finally { await f.close(); }
});

for (const scenario of ["stable", "scope-change", "revoked", "temporal"] as const) test(`current patched native identity reader: ${scenario}`, async () => {
  let account = "a".repeat(64), serverReads = 0;
  const harness = scenario === "temporal" ? "temporal" : "box";
  const auth = { peekAccessToken: () => account, getAccessToken: async () => "SYNTHETIC_CREDENTIAL",
    getTeamId: async () => 7, getMachineId: async () => "SYNTHETIC_MACHINE" };
  const client = { listGrokBotAgents: async () => {
    serverReads++; if (scenario === "scope-change") account = "b".repeat(64);
    return { agents: [{ agentId: BOT, id: "owned-server-id", harness, viewerIsOwner: scenario !== "revoked" }] };
  } };
  const native = nativeMessageCode({
    [Symbol.for(HOST_OWNERSHIP_READ_SYMBOL)]: bindHostOwnershipRead(),
    BASE_HOST_CAPABILITIES: [], GrokBotService: {},
    // Opaque auth/service capabilities are owned substitutes. No real token is read.
    tokenSubjectScope: (token: string) => token,
    createSandCursorBackendClient: () => client,
    getSandAgentsRootDir: () => "/owned", getSandProfilePath: (path: string) => path,
    readSandProfileHarness: () => harness, readSandProfileServerId: () => "owned-server-id",
  }) as Record<string, any>;
  const deps = { environment: { backend: { backendUrl: "https://owned.invalid" } }, getHealth: () => ({ isBusy: false }),
    extensions: { api: (name: string) => name === "auth" ? auth : name === "host-upgrade" ? { getVersionState: () => ({}) }
      : name === "resume-ownership" ? { getSettledHostWindow: () => ({ kind: "inactive" }) }
      : name === "turn-execution" ? { isLocalWorkAllowed: true, canExecute: true } : {} } };
  const result = await call(native.gateway({}, deps), "getHostStatus", { grokboxOwnershipAgentIds: [BOT] });
  const observation = result.grokboxOwnership;
  assert.equal(serverReads, 1); assert.ok(observation);
  assert.ok(!JSON.stringify(observation).includes("SYNTHETIC_"));
  const decision = decideManagedOwnership({ agentId: BOT, snapshot: observation, nowMs: Date.now() });
  assert.equal(decision.ok, scenario === "stable");
  if (scenario === "stable") {
    assert.equal(observation.scope.stable, true); assert.match(observation.scope.id, /^[a-f0-9]{64}$/);
    assert.equal(observation.agents[0].server.agentId, BOT);
  }
  if (scenario === "scope-change") { assert.equal(observation.state, "unavailable"); assert.equal(observation.scope.stable, false); }
});

test("native account scope cannot attach a stored operation to another account in the same process", async () => {
  const f = await fixture();
  try {
    const { request, operation } = await f.submit(); assert.ok(record(operation) && operation.nativeIdentity);
    f.associate(); f.send(); f.changeAccount();
    const result = await f.delivery(request.requestId);
    assert.equal(result.state, "unknown"); assert.deepEqual(result.entries, []); assert.equal(f.effects.rpc, 1);
  } finally { await f.close(); }
});
