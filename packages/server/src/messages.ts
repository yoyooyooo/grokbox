import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { acquireAdvisoryGate } from "@grokbox/box-runtime/runtime";
import { join } from "node:path";
import { Effect } from "effect";
import { inspectOwnership, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import {
  botIdFromRef,
  botRef,
  messageOperation,
  messageDeliveryState,
  normalizeMessageSend,
  type Capability,
  type MessageDelivery,
  type MessageNativeIdentity,
  type MessageEntry,
  type MessageOperation,
  type MessagePage,
  type MessageSearchPage,
  type MessageSendRequest,
} from "@grokbox/client/contract";
import type { ContinuityGateway, NativeBotSnapshot } from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

export type MessageDomain = {
  root: string;
  installationId: string;
  continuity?: (signal: AbortSignal) => ContinuityGateway;
  listBots?: (signal: AbortSignal) => Promise<NativeBotSnapshot>;
  authorize: (signal: AbortSignal, capability: Capability) => Promise<void>;
};

type StoredMessage = MessageOperation & {
  principalId: string;
  textLength: number;
};

const messageTextSha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ENTRY_LIMIT = 200;
const TEXT_LIMIT = 8192;
const principalPart = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const requestPart = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const localWrite = <A>(work: () => Promise<A>) => Effect.uninterruptible(Effect.tryPromise({ try: work, catch: error => error }));
const unavailableRecord = () => new HttpFailure(503, "source_invalid", "A retained message operation is unavailable; it must not be replayed.");

function pathFor(domain: MessageDomain, principalId: string, requestId: string): string {
  if (!principalPart.test(principalId) || !requestPart.test(requestId)) throw new HttpFailure(400, "invalid_input", "Invalid message operation identity.");
  return join(domain.root, "messages", principalId, `${requestId}.json`);
}
async function readStored(path: string, expected: { installationId: string; requestId: string; principalId: string }): Promise<StoredMessage | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128 * 1024) throw unavailableRecord();
    const bytes = Buffer.alloc(128 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw unavailableRecord();
    const raw: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!record(raw)) throw unavailableRecord();
    const { principalId, textLength, ...saved } = raw;
    // Preserve existing receipts without granting an unobserved account binding.
    const data = { ...saved, nativeIdentity: Object.hasOwn(saved, "nativeIdentity") ? saved.nativeIdentity : null };
    if (!messageOperation(data, expected.installationId, expected.requestId)
      || principalId !== expected.principalId || !Number.isSafeInteger(textLength) || Number(textLength) < 1) throw unavailableRecord();
    return { ...data, principalId, textLength: Number(textLength) };
  } catch (error) {
    if (!file && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unavailableRecord();
  } finally { await file?.close(); }
}
async function writeStored(path: string, value: StoredMessage): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const dir = await open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
function operationRef(installationId: string, botId: string, requestId: string): string {
  return `message-operation:${installationId}:${botId}:${requestId}`;
}
function submissionRef(installationId: string, botId: string, requestId: string): string {
  return `submission:${installationId}:${botId}:${requestId}`;
}
function receipt(value: unknown): Record<string, unknown> | null {
  if (!record(value) || value.accepted !== true) return null;
  // Retain only the finite acknowledgement, never arbitrary native payloads.
  return { accepted: true, ...(typeof value.queued === "boolean" ? { queued: value.queued } : {}),
    ...(value.queueState === "queued" ? { queueState: "queued" } : {}) };
}
/** Queue evidence must come from an explicit native field; acceptance alone is not queue proof. */
function queueState(value: unknown): "not-observed" | "queued" {
  if (!record(value)) return "not-observed";
  return value.queued === true || value.queueState === "queued" ? "queued" : "not-observed";
}
function nativeError(error: unknown): HttpFailure {
  const code = error instanceof Error && /timeout/i.test(error.message) ? "source_timeout" : "source_unavailable";
  return new HttpFailure(code === "source_timeout" ? 504 : 503, code, "The native message source is unavailable.");
}
function normalizeEntry(value: unknown, index: number): MessageEntry {
  const row = record(value) ? value : {};
  const nativeId = typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256;
  const kind = !nativeId ? "unknown" : row.kind === "message" || row.kind === "send-message" ? row.kind : "unknown";
  const sent = kind === "send-message" && record(row.message) ? row.message : null;
  const outgoingText = sent?.type === "text" && typeof sent.content === "string" && row.author === undefined;
  const role = outgoingText ? "assistant" : kind === "message" && row.role === "user" ? "user"
    : kind === "message" && row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "unknown";
  const textValue = sent && typeof sent.content === "string" ? sent.content : typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : null;
  const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
  return {
    id: identity(row.id) ?? (Number.isSafeInteger(row.seq) ? String(row.seq) : `entry:${index}`), kind,
    requestId: identity(row.requestId),
    isStreaming: typeof row.isStreaming === "boolean" ? row.isStreaming : null,
    // The current native factory persists text deliveries without isStreaming.
    // Preserve that absence. The persisted delivery is not a TURN/run terminal.
    deliveryEvidence: outgoingText && (row.isStreaming === undefined || row.isStreaming === false)
      ? "persisted-text" : "not-observed",
    role, text: textValue === null ? null : textValue.slice(0, TEXT_LIMIT),
    observedAtMs: Number.isSafeInteger(row.timestampMs) ? Number(row.timestampMs) : Number.isSafeInteger(row.observedAtMs) ? Number(row.observedAtMs) : null,
    clientNonce: identity(row.clientNonce), rootId: identity(row.rootId),
    truncated: textValue !== null && textValue.length > TEXT_LIMIT,
  };
}
function sourceOf(discovery: { baseUrl: string; pid: number; startedAt: number } | undefined) {
  if (!discovery) return null;
  return { generation: createHash("sha256").update(JSON.stringify([discovery.baseUrl, discovery.pid, discovery.startedAt])).digest("hex"), pid: discovery.pid, startedAt: discovery.startedAt };
}
function pageFromNative(bot: string, result: unknown, discovery: { baseUrl: string; pid: number; startedAt: number } | undefined): MessagePage {
  const payload = record(result) ? result : {};
  if (!Array.isArray(payload.entries)) throw new HttpFailure(503, "source_invalid", "The native transcript response is not a page.");
  const rawEntries = payload.entries;
  return {
    botRef: bot,
    entries: rawEntries.slice(0, ENTRY_LIMIT).map(normalizeEntry),
    nextBeforeSeq: typeof payload.nextBeforeSeq === "number" && Number.isSafeInteger(payload.nextBeforeSeq) ? payload.nextBeforeSeq : null,
    source: sourceOf(discovery),
    coverage: "native-transcript-window",
  };
}
function ensureWait(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^[0-9]+$/.test(value)) throw new HttpFailure(400, "invalid_input", "waitMs must be a bounded integer.");
  const wait = Number(value);
  if (!Number.isSafeInteger(wait) || wait < 0 || wait > 25_000) throw new HttpFailure(400, "invalid_input", "waitMs is bounded to 25 seconds.");
  return wait;
}
async function listNative(domain: MessageDomain, signal: AbortSignal, pinnedGateway?: ContinuityGateway): Promise<{ bots: NativeBotSnapshot["bots"]; source: NativeBotSnapshot["source"] }> {
  if (pinnedGateway) {
    try {
      const result = await pinnedGateway.listAgents(10_000);
      const rows = result.agents.filter(record).filter(row => row.isGroup !== true).map(row => ({ id: String(row.id), name: String(row.name ?? row.id), title: typeof row.title === "string" ? row.title : null } as NativeBotSnapshot["bots"][number]));
      const source = sourceOf(result.discovery)!;
      return { bots: rows, source: { kind: "native-gateway", generation: source.generation, pid: result.discovery.pid, startedAt: result.discovery.startedAt, observedAt: Date.now() } };
    } catch (error) { throw nativeError(error); }
  }
  if (domain.listBots) {
    try { return await domain.listBots(signal); } catch { throw nativeError(new Error("source")); }
  }
  if (!domain.continuity) throw new HttpFailure(503, "source_unavailable", "Native message input is unavailable.");
  try {
    const result = await domain.continuity(signal).listAgents(10_000);
    const rows = result.agents.filter(record).filter(row => row.isGroup !== true).map(row => ({ id: String(row.id), name: String(row.name ?? row.id), title: typeof row.title === "string" ? row.title : null } as NativeBotSnapshot["bots"][number]));
    return { bots: rows, source: { kind: "native-gateway", generation: sourceOf(result.discovery)!.generation, pid: result.discovery.pid, startedAt: result.discovery.startedAt, observedAt: Date.now() } };
  } catch (error) { throw nativeError(error); }
}
const sameNativeIdentity = (a: MessageNativeIdentity, b: MessageNativeIdentity) =>
  a.scopeId === b.scopeId && a.serverId === b.serverId && a.harness === b.harness;
async function nativeIdentity(gateway: ContinuityGateway, botId: string, generation: string, timeoutMs = 10_000): Promise<{ identity: MessageNativeIdentity; assertFresh: () => void }> {
  const began = performance.now();
  const reply = await gateway.getAgentOwnership([botId], timeoutMs);
  const capturedTick = performance.now(), elapsed = capturedTick - began;
  const fact = inspectOwnership({ agentIds: [botId], snapshot: reply.result });
  const row = fact.agents[0], now = Date.now();
  const stamps = [fact.observedAt, fact.completedAt, fact.serverObservedAt].map(value => value == null ? NaN : Date.parse(value));
  if (sourceOf(reply.discovery)?.generation !== generation || fact.serverRead.state !== "observed"
    || !fact.scope?.stable || !fact.scope.id || fact.localMigrationWindow !== "inactive"
    || !row || !["confirmed_box", "confirmed_temporal"].includes(row.state) || row.server?.viewerIsOwner !== true
    || !row.server.serverId || (row.server.harness !== "box" && row.server.harness !== "temporal")
    || stamps.some(stamp => !Number.isFinite(stamp) || stamp > now || now - stamp > OWNERSHIP_EVIDENCE_MAX_AGE_MS)
    || elapsed < 0 || elapsed > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
    throw new HttpFailure(503, "source_invalid", "The native message identity is not currently confirmed.");
  }
  const oldestStamp = Math.min(...stamps), initialAge = now - oldestStamp;
  return {
    identity: { scopeId: fact.scope.id, serverId: row.server.serverId, harness: row.server.harness },
    // Retain the observation clock only in this request, never in public receipts.
    // A delayed authorization or backwards wall clock cannot renew its lifetime.
    assertFresh: () => {
      const wallAge = Date.now() - oldestStamp, passed = performance.now() - capturedTick;
      if (wallAge < 0 || passed < 0 || Math.max(wallAge, initialAge + passed) > OWNERSHIP_EVIDENCE_MAX_AGE_MS)
        throw new HttpFailure(503, "source_invalid", "The native message identity evidence expired before dispatch.");
    },
  };
}
async function transcript(domain: MessageDomain, botId: string, limit: number, beforeSeq: number | undefined, signal: AbortSignal,
  expectedGeneration?: string, timeoutMs = 10_000, expectedIdentity?: MessageNativeIdentity): Promise<MessagePage> {
  if (!domain.continuity) throw new HttpFailure(503, "source_unavailable", "Native message observation is unavailable.");
  try {
    const gateway = domain.continuity(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
    const check = async () => {
      if (expectedIdentity && (!expectedGeneration || !sameNativeIdentity(expectedIdentity, (await nativeIdentity(gateway, botId, expectedGeneration, timeoutMs)).identity)))
        throw new HttpFailure(503, "source_invalid", "The native message account or Bot identity changed.");
    };
    await check();
    const input: Record<string, unknown> = { id: botId, limit, ...(beforeSeq === undefined ? {} : { beforeSeq }) };
    const result = await gateway.rpc("getAgentTranscriptTail", input, { timeoutMs, maxResponseBytes: 512 * 1024, ...(expectedGeneration ? { expectedGeneration } : {}) });
    if (expectedGeneration !== undefined && sourceOf(result.discovery)?.generation !== expectedGeneration) throw new Error("source_changed");
    await check();
    return pageFromNative(botRef(domain.installationId, botId), result.result, result.discovery);
  } catch (error) { throw nativeError(error); }
}
function sameRequest(a: StoredMessage, b: MessageSendRequest): boolean {
  return a.botRef === b.botRef && a.clientNonce === b.clientNonce && a.textSha256 === messageTextSha256(b.text);
}
async function getOperation(domain: MessageDomain, principal: Principal, requestId: string): Promise<StoredMessage> {
  const stored = await readStored(pathFor(domain, principal.id, requestId), { installationId: domain.installationId, principalId: principal.id, requestId });
  if (!stored) throw new HttpFailure(404, "not_found", "No message operation was found for this principal and request ID.");
  return stored;
}
function publicOperation(value: StoredMessage): MessageOperation {
  return {
    schemaVersion: value.schemaVersion, installationId: value.installationId, requestId: value.requestId,
    operationRef: value.operationRef, submissionRef: value.submissionRef, botRef: value.botRef, clientNonce: value.clientNonce,
    textSha256: value.textSha256, state: value.state, acceptedAtMs: value.acceptedAtMs, nativeGeneration: value.nativeGeneration, nativeIdentity: value.nativeIdentity,
    nativeReceipt: value.nativeReceipt, association: value.association, coverage: value.coverage,
  };
}
function operationUnknown(operation: StoredMessage): HttpFailure {
  return new HttpFailure(409, "operation_unknown", "The original message submission is unresolved; query its retained receipt before choosing new input.", { operation: publicOperation(operation) });
}

export function messageApplication(domain: MessageDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.scoped(Effect.gen(function* () {
    const operationPath = /^\/v1\/message-operations\/([^/]+)$/.exec(url.pathname);
    const deliveryPath = /^\/v1\/message-deliveries\/([^/]+)$/.exec(url.pathname);
    const threadPath = /^\/v1\/messages\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
    const botPath = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && url.pathname === "/v1/messages") {
      yield* Effect.try({ try: () => { if (url.search) throw new HttpFailure(400, "invalid_input", "Message submission does not accept query parameters."); requireCapability(principal, "messages.write"); }, catch: error => error });
      const request = yield* Effect.try({ try: () => normalizeMessageSend(input, domain.installationId), catch: error => error });
      const botId = botIdFromRef(request.botRef, domain.installationId);
      const path = pathFor(domain, principal.id, request.requestId);
      const binding = { installationId: domain.installationId, principalId: principal.id, requestId: request.requestId };
      const previous = yield* Effect.tryPromise({ try: () => readStored(path, binding), catch: error => error });
      if (previous) {
        if (!sameRequest(previous, request)) throw new HttpFailure(409, "idempotency_conflict", "The request ID is bound to different input.", { operation: publicOperation(previous) });
        if (previous.state === "unknown") return yield* Effect.fail(operationUnknown(previous));
        return publicOperation(previous);
      }
      const controller = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), controller => Effect.sync(() => controller.abort()));
      // Read membership and submit through the same pinned native gateway. If its
      // discovery generation changes, the gateway rejects the write before any retry.
      let submissionGateway: ContinuityGateway | undefined;
      const native = yield* Effect.tryPromise({ try: signal => {
        if (domain.continuity) {
          try { submissionGateway = domain.continuity(controller.signal); } catch { submissionGateway = undefined; }
        }
        return listNative(domain, signal, submissionGateway);
      }, catch: error => error });
      if (!native.bots.some(bot => bot.id.toLowerCase() === botId)) throw new HttpFailure(404, "not_found", "The Bot was not present in the native snapshot.");
      const gate = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => acquireAdvisoryGate(join(domain.root, "messages", principal.id, ".gate"), 2000), catch: error => error }),
        gate => gate ? Effect.promise(() => gate.release()) : Effect.void);
      if (!gate) throw new HttpFailure(503, "unavailable", "Another message submission is being finalized; query the original request.");
      const rechecked = yield* Effect.tryPromise({ try: () => readStored(path, binding), catch: error => error });
      if (rechecked) {
        if (!sameRequest(rechecked, request)) throw new HttpFailure(409, "idempotency_conflict", "The request ID is already bound to different message input.", { operation: publicOperation(rechecked) });
        if (rechecked.state === "unknown") {
          return yield* Effect.fail(operationUnknown(rechecked));
        }
        return publicOperation(rechecked);
      }
      if (!submissionGateway) return yield* Effect.fail(new HttpFailure(503, "source_unavailable", "Native message input is unavailable."));
      const observedIdentity = yield* Effect.tryPromise({ try: () => nativeIdentity(submissionGateway!, botId, native.source.generation), catch: error => error });
      const identity = observedIdentity.identity;
      const pending: StoredMessage = {
        schemaVersion: 1, installationId: domain.installationId, requestId: request.requestId,
        operationRef: operationRef(domain.installationId, botId, request.requestId), submissionRef: submissionRef(domain.installationId, botId, request.requestId),
        botRef: request.botRef, clientNonce: request.clientNonce, textSha256: messageTextSha256(request.text), state: "unknown",
        acceptedAtMs: Date.now(), nativeGeneration: native.source.generation, nativeIdentity: identity, nativeReceipt: null,
        association: { queue: "not-observed", run: "not-observed", turn: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "unknown" },
        coverage: "native-submission", principalId: principal.id, textLength: request.text.length,
      };
      yield* localWrite(() => writeStored(path, pending));
      if (!submissionGateway) {
        return yield* Effect.fail(operationUnknown(pending));
      }
      // Recheck the same principal after preflight/discovery. Native ownership
      // and a retained receipt are not current management write authority.
      yield* Effect.tryPromise({
        try: signal => domain.authorize(AbortSignal.any([controller.signal, signal]), "messages.write"),
        catch: error => error,
      });
      const nativeOutcome = yield* Effect.result(Effect.tryPromise({
        try: signal => submissionGateway!.rpc("sendPrompt", { agentId: botId, prompt: request.text, clientNonce: request.clientNonce }, {
          timeoutMs: 15_000, maxResponseBytes: 64 * 1024, write: true, singleAttempt: true,
          unknownOutcomeCode: "operation_outcome_unknown", expectedGeneration: native.source.generation,
          beforeDispatch: async owner => {
            await domain.authorize(owner, "messages.write"); owner.throwIfAborted();
            observedIdentity.assertFresh();
          },
        }),
        catch: error => error,
      }));
      if (nativeOutcome._tag === "Failure") {
        return yield* Effect.fail(operationUnknown(pending));
      }
      const nativeReply = nativeOutcome.success;
      const acknowledgement = receipt(nativeReply.result);
      if (!acknowledgement || sourceOf(nativeReply.discovery)?.generation !== pending.nativeGeneration) return yield* Effect.fail(operationUnknown(pending));
      const after = yield* Effect.result(Effect.tryPromise({ try: () => nativeIdentity(submissionGateway!, botId, native.source.generation), catch: error => error }));
      if (after._tag === "Failure" || !sameNativeIdentity(identity, after.success.identity)) return yield* Effect.fail(operationUnknown(pending));
      const accepted: StoredMessage = {
        ...pending, state: "accepted", acceptedAtMs: Date.now(), nativeGeneration: sourceOf(nativeReply!.discovery)?.generation ?? null,
        nativeReceipt: acknowledgement,
        association: { ...pending.association, queue: queueState(nativeReply!.result), delivery: "unknown" },
      };
      yield* localWrite(() => writeStored(path, accepted));
      return publicOperation(accepted);
    }
    if (method !== "GET") return yield* Effect.fail(new HttpFailure(405, "invalid_input", "This message endpoint only supports GET and POST."));
    if (operationPath) {
      yield* Effect.try({ try: () => { if (url.search) throw new HttpFailure(400, "invalid_input", "Operation lookup does not accept query parameters."); requireCapability(principal, "messages.read"); }, catch: error => error });
      return yield* Effect.tryPromise({ try: async () => publicOperation(await getOperation(domain, principal, decodeURIComponent(operationPath[1]!))), catch: error => error });
    }
    if (deliveryPath) {
      yield* Effect.try({ try: () => requireCapability(principal, "messages.read"), catch: error => error });
      const requestId = yield* Effect.try({ try: () => decodeURIComponent(deliveryPath[1]!), catch: error => error });
      if (!requestPart.test(requestId)) return yield* Effect.fail(new HttpFailure(400, "invalid_input", "Invalid message request UUID."));
      const operation = yield* Effect.tryPromise({ try: () => getOperation(domain, principal, requestId), catch: error => error });
      const waitMs = yield* Effect.try({ try: () => ensureWait(url.searchParams.get("waitMs")), catch: error => error });
      const botId = botIdFromRef(operation.botRef, domain.installationId);
      const deadline = Date.now() + waitMs;
      const unknown = (): MessageDelivery => ({ operation: publicOperation(operation), state: "unknown", observedAtMs: Date.now(), entries: [], source: null,
        association: { ...operation.association, delivery: "unknown" }, coverage: "native-source-unavailable" });
      if (!operation.nativeGeneration || !operation.nativeIdentity) return unknown();
      for (;;) {
        const timeout = waitMs > 0 ? Math.max(1, Math.min(10_000, deadline - Date.now())) : 10_000;
        const observed = yield* Effect.result(Effect.tryPromise({ try: signal => transcript(domain, botId, ENTRY_LIMIT, undefined, signal, operation.nativeGeneration!, timeout, operation.nativeIdentity!), catch: error => error }));
        if (observed._tag === "Failure") return unknown();
        const page = observed.success, state = messageDeliveryState(page.entries, operation.clientNonce);
        const delivery: MessageDelivery = { operation: publicOperation(operation), state, observedAtMs: Date.now(), entries: page.entries, source: page.source,
          association: { ...operation.association, delivery: state }, coverage: page.coverage };
        if (state === "response-observed" || Date.now() >= deadline) return delivery;
        yield* Effect.sleep(`${Math.min(250, Math.max(1, deadline - Date.now()))} millis`);
        if (Date.now() >= deadline) return delivery;
      }
    }
    if (botPath || threadPath || url.pathname === "/v1/messages") {
      yield* Effect.try({ try: () => requireCapability(principal, "messages.read"), catch: error => error });
      const query = url.searchParams.get("query");
      const limitRaw = url.searchParams.get("limit") ?? "50";
      if (!/^[1-9][0-9]{0,2}$/.test(limitRaw) || Number(limitRaw) > ENTRY_LIMIT) throw new HttpFailure(400, "invalid_input", "Message output is bounded.");
      const limit = Number(limitRaw);
      if (threadPath) {
        const botId = botIdFromRef(decodeURIComponent(threadPath[1]!), domain.installationId);
        const page = yield* Effect.tryPromise({ try: signal => transcript(domain, botId, limit, undefined, signal), catch: error => error });
        const root = decodeURIComponent(threadPath[2]!);
        return { ...page, entries: page.entries.filter(entry => entry.rootId === root || entry.id === root) };
      }
      if (botPath) {
        if (url.searchParams.has("query")) throw new HttpFailure(400, "invalid_input", "Bot message reads do not accept query.");
        const botId = botIdFromRef(decodeURIComponent(botPath[1]!), domain.installationId);
        const before = url.searchParams.get("beforeSeq");
        if (before !== null && (!/^[0-9]+$/.test(before) || !Number.isSafeInteger(Number(before)))) throw new HttpFailure(400, "invalid_input", "Invalid transcript cursor.");
        return yield* Effect.tryPromise({ try: signal => transcript(domain, botId, limit, before === null ? undefined : Number(before), signal), catch: error => error });
      }
      if (typeof query !== "string" || query.trim().length === 0 || query.length > 256) throw new HttpFailure(400, "invalid_input", "A bounded search query is required.");
      const target = url.searchParams.get("bot");
      const bots = target ? [{ id: botIdFromRef(target, domain.installationId) }] : (yield* Effect.tryPromise({ try: signal => listNative(domain, signal), catch: error => error })).bots.slice(0, 20);
      const matches = [];
      let source: MessagePage["source"] = null;
      for (const bot of bots) {
        try {
          const page = yield* Effect.tryPromise({ try: signal => transcript(domain, bot.id, Math.min(limit, 100), undefined, signal), catch: error => error });
          source = source ?? page.source;
          for (const entry of page.entries) if (entry.text?.includes(query)) matches.push({ botRef: botRef(domain.installationId, bot.id), entry });
        } catch { /* search discloses source coverage through the result */ }
        if (matches.length >= limit) break;
      }
      return { matches: matches.slice(0, limit), source, coverage: source ? "native-transcript-window" : "native-source-unavailable" } satisfies MessageSearchPage;
    }
    return yield* Effect.fail(new HttpFailure(404, "not_found", "The message endpoint is not available."));
  }));
}
