import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { acquireAdvisoryGate } from "@grokbox/box-runtime/runtime";
import { join } from "node:path";
import { Effect } from "effect";
import {
  botIdFromRef,
  botRef,
  messageOperation,
  normalizeMessageSend,
  type MessageDelivery,
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
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function pathFor(domain: MessageDomain, principalId: string, requestId: string): string {
  if (!principalPart.test(principalId) || !requestPart.test(requestId)) throw new HttpFailure(400, "invalid_input", "Invalid message operation identity.");
  return join(domain.root, "messages", principalId, `${requestId}.json`);
}
async function readStored(path: string): Promise<StoredMessage | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!record(raw)) return undefined;
    const installationId = raw.installationId, requestId = raw.requestId;
    if (typeof installationId !== "string" || typeof requestId !== "string") return undefined;
    const principalId = raw.principalId;
    const textLength = raw.textLength;
    const data: Record<string, unknown> = raw;
    const publicData = {
      schemaVersion: data.schemaVersion, installationId: data.installationId, requestId: data.requestId,
      operationRef: data.operationRef, submissionRef: data.submissionRef, botRef: data.botRef, clientNonce: data.clientNonce,
      textSha256: data.textSha256, state: data.state, acceptedAtMs: data.acceptedAtMs, nativeGeneration: data.nativeGeneration,
      nativeReceipt: data.nativeReceipt, association: data.association, coverage: data.coverage,
    };
    if (!messageOperation(publicData, installationId, requestId)) return undefined;
    if (typeof principalId !== "string" || !principalPart.test(principalId) || typeof textLength !== "number" || !Number.isSafeInteger(textLength)) return undefined;
    return { ...publicData, principalId, textLength };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new HttpFailure(503, "source_invalid", "A retained message operation is unavailable.");
  }
}
async function writeStored(path: string, value: StoredMessage): Promise<void> {
  const directory = join(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
function operationRef(installationId: string, botId: string, requestId: string): string {
  return `message-operation:${installationId}:${botId}:${requestId}`;
}
function submissionRef(installationId: string, botId: string, requestId: string): string {
  return `submission:${installationId}:${botId}:${requestId}`;
}
function receipt(value: unknown): Record<string, unknown> | null {
  if (!record(value)) return null;
  try {
    const text = JSON.stringify(value);
    if (text.length > 8192) return { bounded: true, keys: Object.keys(value).slice(0, 32) };
    return JSON.parse(text) as Record<string, unknown>;
  } catch { return null; }
}
function nativeError(error: unknown): HttpFailure {
  const code = error instanceof Error && /timeout/i.test(error.message) ? "source_timeout" : "source_unavailable";
  return new HttpFailure(code === "source_timeout" ? 504 : 503, code, "The native message source is unavailable.");
}
function normalizeEntry(value: unknown, index: number): MessageEntry {
  const row = record(value) ? value : {};
  const roleValue = String(row.role ?? row.senderRole ?? row.authorRole ?? "").toLowerCase();
  const role = roleValue === "user" || roleValue === "human" ? "user"
    : roleValue === "assistant" || roleValue === "model" || roleValue === "bot" ? "assistant"
    : roleValue === "system" ? "system" : "unknown";
  const textValue = typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : null;
  return {
    id: typeof row.id === "string" ? row.id.slice(0, 256) : typeof row.seq === "number" ? String(row.seq) : `entry:${index}`,
    role,
    text: textValue === null ? null : textValue.slice(0, TEXT_LIMIT),
    observedAtMs: typeof row.observedAtMs === "number" && Number.isSafeInteger(row.observedAtMs) ? row.observedAtMs : typeof row.createdAt === "number" && Number.isSafeInteger(row.createdAt) ? row.createdAt : null,
    clientNonce: typeof row.clientNonce === "string" ? row.clientNonce : typeof row.nonce === "string" ? row.nonce : null,
    rootId: typeof row.rootId === "string" ? row.rootId : typeof row.threadId === "string" ? row.threadId : null,
    truncated: textValue !== null && textValue.length > TEXT_LIMIT,
  };
}
function sourceOf(discovery: { baseUrl: string; pid: number; startedAt: number } | undefined) {
  if (!discovery) return null;
  return { generation: createHash("sha256").update(JSON.stringify([discovery.baseUrl, discovery.pid, discovery.startedAt])).digest("hex"), pid: discovery.pid, startedAt: discovery.startedAt };
}
function pageFromNative(bot: string, result: unknown, discovery: { baseUrl: string; pid: number; startedAt: number } | undefined): MessagePage {
  const payload = record(result) ? result : {};
  const rawEntries = Array.isArray(payload.entries) ? payload.entries : Array.isArray(result) ? result : [];
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
async function listNative(domain: MessageDomain, signal: AbortSignal): Promise<{ bots: NativeBotSnapshot["bots"]; source: NativeBotSnapshot["source"] }> {
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
async function transcript(domain: MessageDomain, botId: string, limit: number, beforeSeq: number | undefined, signal: AbortSignal): Promise<MessagePage> {
  if (!domain.continuity) throw new HttpFailure(503, "source_unavailable", "Native message observation is unavailable.");
  try {
    const input: Record<string, unknown> = { id: botId, limit, ...(beforeSeq === undefined ? {} : { beforeSeq }) };
    const result = await domain.continuity(signal).rpc("getAgentTranscriptTail", input, { timeoutMs: 10_000, maxResponseBytes: 512 * 1024 });
    return pageFromNative(botRef(domain.installationId, botId), result.result, result.discovery);
  } catch (error) { throw nativeError(error); }
}
function sameRequest(a: StoredMessage, b: MessageSendRequest): boolean {
  return a.botRef === b.botRef && a.clientNonce === b.clientNonce && a.textSha256 === messageTextSha256(b.text);
}
async function getOperation(domain: MessageDomain, principal: Principal, requestId: string): Promise<StoredMessage> {
  const stored = await readStored(pathFor(domain, principal.id, requestId));
  if (!stored) throw new HttpFailure(404, "not_found", "No message operation was found for this principal and request ID.");
  return stored;
}
function publicOperation(value: StoredMessage): MessageOperation {
  return {
    schemaVersion: value.schemaVersion, installationId: value.installationId, requestId: value.requestId,
    operationRef: value.operationRef, submissionRef: value.submissionRef, botRef: value.botRef, clientNonce: value.clientNonce,
    textSha256: value.textSha256, state: value.state, acceptedAtMs: value.acceptedAtMs, nativeGeneration: value.nativeGeneration,
    nativeReceipt: value.nativeReceipt, association: value.association, coverage: value.coverage,
  };
}
function operationUnknown(operation: StoredMessage): never {
  throw new HttpFailure(409, "operation_unknown", "The original message submission is unresolved; query its retained receipt before choosing new input.", { operation: publicOperation(operation) });
}

export function messageApplication(domain: MessageDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const operationPath = /^\/v1\/message-operations\/([^/]+)$/.exec(url.pathname);
    const deliveryPath = /^\/v1\/message-deliveries\/([^/]+)$/.exec(url.pathname);
    const threadPath = /^\/v1\/messages\/([^/]+)\/threads\/([^/]+)$/.exec(url.pathname);
    const botPath = /^\/v1\/messages\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && url.pathname === "/v1/messages") {
      yield* Effect.try({ try: () => { if (url.search) throw new HttpFailure(400, "invalid_input", "Message submission does not accept query parameters."); requireCapability(principal, "messages.write"); }, catch: error => error });
      const request = yield* Effect.try({ try: () => normalizeMessageSend(input, domain.installationId), catch: error => error });
      const botId = botIdFromRef(request.botRef, domain.installationId);
      const native = yield* Effect.tryPromise({ try: signal => listNative(domain, signal), catch: error => error });
      if (!native.bots.some(bot => bot.id.toLowerCase() === botId)) throw new HttpFailure(404, "not_found", "The Bot was not present in the native snapshot.");
      const path = pathFor(domain, principal.id, request.requestId);
      const gate = yield* Effect.tryPromise({ try: () => acquireAdvisoryGate(join(domain.root, "messages", principal.id, ".gate"), 2000), catch: error => error });
      if (!gate) throw new HttpFailure(503, "unavailable", "Another message submission is being finalized; query the original request.");
      try {
        const previous = yield* Effect.tryPromise({ try: () => readStored(path), catch: error => error });
        if (previous) {
          if (!sameRequest(previous, request)) throw new HttpFailure(409, "idempotency_conflict", "The request ID is already bound to different message input.", { operation: previous });
          if (previous.state === "unknown") operationUnknown(previous);
          return publicOperation(previous);
        }
        const pending: StoredMessage = {
        schemaVersion: 1, installationId: domain.installationId, requestId: request.requestId,
        operationRef: operationRef(domain.installationId, botId, request.requestId), submissionRef: submissionRef(domain.installationId, botId, request.requestId),
        botRef: request.botRef, clientNonce: request.clientNonce, textSha256: messageTextSha256(request.text), state: "unknown",
        acceptedAtMs: Date.now(), nativeGeneration: null, nativeReceipt: null,
        association: { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "unknown" },
        coverage: "native-submission", principalId: principal.id, textLength: request.text.length,
      };
      yield* Effect.tryPromise({ try: () => writeStored(path, pending), catch: error => error });
      if (!domain.continuity) operationUnknown(pending);
      let nativeReply: { result: unknown; discovery: { baseUrl: string; pid: number; startedAt: number } };
      try {
        nativeReply = yield* Effect.tryPromise({ try: signal => domain.continuity!(signal).rpc("sendPrompt", { agentId: botId, prompt: request.text, clientNonce: request.clientNonce }, { timeoutMs: 15_000, maxResponseBytes: 64 * 1024, write: true, singleAttempt: true, unknownOutcomeCode: "operation_outcome_unknown" }), catch: error => error });
      } catch (error) {
        operationUnknown(pending);
      }
      const accepted: StoredMessage = {
        ...pending, state: "accepted", acceptedAtMs: Date.now(), nativeGeneration: sourceOf(nativeReply!.discovery)?.generation ?? null,
        nativeReceipt: receipt(nativeReply!.result), association: { ...pending.association, delivery: "recorded" },
      };
        yield* Effect.tryPromise({ try: () => writeStored(path, accepted), catch: error => error });
        return publicOperation(accepted);
      } finally {
        yield* Effect.promise(() => gate.release());
      }
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
      while (true) {
        try {
          const page = yield* Effect.tryPromise({ try: signal => transcript(domain, botId, ENTRY_LIMIT, undefined, signal), catch: error => error });
          const userIndex = page.entries.findIndex(entry => entry.clientNonce === operation.clientNonce);
          const responseIndex = userIndex >= 0 ? page.entries.findIndex((entry, index) => index > userIndex && entry.role === "assistant") : -1;
          const state = responseIndex >= 0 ? "response-observed" : userIndex >= 0 ? "recorded" : "unknown";
          const delivery: MessageDelivery = { operation: publicOperation(operation), state, observedAtMs: Date.now(), entries: page.entries, source: page.source,
            association: { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: state }, coverage: page.coverage };
          if (state !== "recorded" || Date.now() >= deadline) return delivery;
        } catch (error) {
          if (Date.now() >= deadline) {
            return { operation: publicOperation(operation), state: "unknown", observedAtMs: Date.now(), entries: [], source: null,
              association: { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "unknown" }, coverage: "native-source-unavailable" } satisfies MessageDelivery;
          }
        }
        yield* Effect.promise(() => sleep(Math.min(250, Math.max(1, deadline - Date.now()))));
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
  });
}
