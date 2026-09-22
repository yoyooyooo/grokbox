import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  botIdFromRef, botRef, messageOperation, normalizeMessageSend,
  type MessageAssociation, type MessageDelivery, type MessageEntry, type MessageOperation, type MessagePage,
  type MessageSearchPage,
} from "@grokbox/client/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  acquireAdvisoryGate, type ContinuityGateway, type NativeBotSnapshot, ManagementSourceError,
} from "@grokbox/box-runtime/runtime";
import { HttpFailure, requireCapability, type Principal } from "./access.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT = 8_192;
const MAX_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 100;
const MAX_RECORD_BYTES = 128 * 1024;

export type MessageDomain = {
  root: string;
  installationId: string;
  continuity?: (signal: AbortSignal) => ContinuityGateway;
  listBots?: (signal: AbortSignal) => Promise<NativeBotSnapshot>;
};

const failure = (error: unknown): HttpFailure => {
  if (error instanceof HttpFailure) return error;
  if (error instanceof ManagementSourceError) return new HttpFailure(503, error.code, error.message);
  if (error instanceof Error && error.message === "advisory_gate_unavailable") return new HttpFailure(503, "source_unavailable", "The message record gate is unavailable.");
  if (error instanceof Error && error.message === "advisory_gate_replaced") return new HttpFailure(503, "source_changed", "The message record gate changed during the operation.");
  if (error instanceof Error && error.message === "message_record_invalid") return new HttpFailure(503, "source_invalid", "The retained message record is invalid.");
  if (error instanceof Error && error.message === "message_record_missing") return new HttpFailure(404, "not_found", "The original message request has no retained record.");
  return new HttpFailure(503, "source_unavailable", "The native message source is unavailable; no fallback source was selected.");
};
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: failure });
const messageRoot = (domain: MessageDomain, principal: Principal) => join(domain.root, "state", "messages", principal.id);
const recordPath = (domain: MessageDomain, principal: Principal, requestId: string) => join(messageRoot(domain, principal), requestId.toLowerCase() + ".json");
const gatePath = (domain: MessageDomain) => join(domain.root, "state", "messages.lock");

async function readRecord(domain: MessageDomain, principal: Principal, requestId: string): Promise<MessageOperation> {
  let raw: string;
  try { raw = await readFile(recordPath(domain, principal, requestId), { encoding: "utf8" }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error("message_record_missing");
    throw error;
  }
  if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error("message_record_invalid");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("message_record_invalid"); }
  if (!messageOperation(value, domain.installationId, requestId)) throw new Error("message_record_invalid");
  return value;
}

async function writeRecord(domain: MessageDomain, principal: Principal, operation: MessageOperation): Promise<void> {
  const directory = messageRoot(domain, principal);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = recordPath(domain, principal, operation.requestId);
  const temporary = join(directory, "." + operation.requestId + "." + randomUUID() + ".tmp");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(operation) + "\n", { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function withGate<A>(domain: MessageDomain, run: () => Promise<A>): Promise<A> {
  await mkdir(join(domain.root, "state"), { recursive: true, mode: 0o700 });
  const gate = await acquireAdvisoryGate(gatePath(domain), 2000);
  if (!gate) throw new Error("advisory_gate_unavailable");
  try { return await run(); } finally { await gate.release(); }
}

function sourceView(source: { baseUrl: string; pid: number; startedAt: number }): MessagePage["source"] {
  return { generation: sha256Text(canonicalJson([source.baseUrl, source.pid, source.startedAt])), pid: source.pid, startedAt: source.startedAt };
}

async function bots(domain: MessageDomain, signal: AbortSignal): Promise<NativeBotSnapshot> {
  if (!domain.listBots) throw new ManagementSourceError("source_unavailable");
  return domain.listBots(signal);
}
function targetBot(snapshot: NativeBotSnapshot, target: string, installationId: string): NativeBotSnapshot["bots"][number] {
  const id = botIdFromRef(target, installationId);
  const row = snapshot.bots.find(bot => bot.id === id);
  if (!row) throw new HttpFailure(404, "not_found", "The target Bot is not present in the current native snapshot.");
  return row;
}

function boundedText(value: unknown): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false };
  const chars = Array.from(value);
  return chars.length > MAX_TEXT ? { text: chars.slice(0, MAX_TEXT).join(""), truncated: true } : { text: value, truncated: false };
}
function role(value: unknown): MessageEntry["role"] {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return normalized === "user" || normalized === "human" ? "user"
    : normalized === "assistant" || normalized === "model" || normalized === "bot" ? "assistant"
    : normalized === "system" ? "system" : "unknown";
}
function textOf(value: Record<string, unknown>): unknown {
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return null;
  return value.content.map(part => typeof part === "string" ? part : part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("");
}
function entry(raw: unknown, index: number): MessageEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const idValue = value.id ?? value.messageId ?? value.seq ?? index;
  const id = typeof idValue === "string" || typeof idValue === "number" ? String(idValue) : String(index);
  const bounded = boundedText(textOf(value));
  const observed = value.observedAtMs ?? value.createdAtMs ?? value.timestamp ?? value.createdAt;
  const observedAtMs = typeof observed === "number" && Number.isSafeInteger(observed) ? observed : null;
  const nonce = value.clientNonce ?? value.nonce ?? value.messageNonce;
  const root = value.rootId ?? value.threadRootId ?? value.parentId;
  return {
    id: id.length <= 256 ? id : id.slice(0, 256),
    role: role(value.role ?? value.senderRole ?? value.authorRole),
    text: bounded.text,
    observedAtMs,
    clientNonce: typeof nonce === "string" && nonce.length <= 256 ? nonce : null,
    rootId: typeof root === "string" && root.length <= 256 ? root : null,
    truncated: bounded.truncated,
  };
}
async function transcript(domain: MessageDomain, bot: string, signal: AbortSignal, limit: number, beforeSeq?: number): Promise<MessagePage> {
  const continuity = domain.continuity?.(signal);
  if (!continuity) return { botRef: bot, entries: [], nextBeforeSeq: null, source: null, coverage: "native-source-unavailable" };
  const id = botIdFromRef(bot, domain.installationId);
  const result = await continuity.rpc("getAgentTranscriptTail", { id, limit, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, { timeoutMs: 10_000, maxResponseBytes: 512 * 1024 });
  const body = result.result && typeof result.result === "object" && !Array.isArray(result.result) ? result.result as Record<string, unknown> : {};
  const rawEntries = Array.isArray(result.result) ? result.result : Array.isArray(body.entries) ? body.entries : [];
  const entries = rawEntries.slice(0, MAX_ENTRIES).map((item, index) => entry(item, index)).filter((item): item is MessageEntry => item !== null);
  const nextValue = body.nextBeforeSeq;
  return {
    botRef: bot, entries, nextBeforeSeq: typeof nextValue === "number" && Number.isSafeInteger(nextValue) && nextValue >= 0 ? nextValue : null,
    source: sourceView(result.discovery), coverage: "native-transcript-window",
  };
}
function associationFor(operation: MessageOperation, entries: MessageEntry[]): MessageAssociation {
  const user = entries.find(item => item.role === "user" && item.clientNonce === operation.clientNonce);
  if (!user) return { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "unknown" };
  const response = entries.find(item => item.role === "assistant"
    && (user.rootId !== null ? item.rootId === user.rootId || item.id === user.rootId : item.clientNonce === operation.clientNonce));
  return { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: response ? "response-observed" : "recorded" };
}
function operationWithAssociation(operation: MessageOperation, association: MessageAssociation): MessageOperation {
  return { ...operation, association };
}
function parseLimit(value: string | null, max: number, defaultValue: number): number {
  if (value === null) return defaultValue;
  if (!/^[0-9]+$/.test(value)) throw new HttpFailure(400, "invalid_input", "The message limit must be a bounded integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new HttpFailure(400, "invalid_input", "The message limit is outside the supported bound.");
  return parsed;
}
function parseWait(value: string | null): number {
  if (value === null) return 0;
  if (!/^[0-9]+$/.test(value)) throw new HttpFailure(400, "invalid_input", "The delivery wait must be a bounded integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 25_000) throw new HttpFailure(400, "invalid_input", "The delivery wait is outside the supported bound.");
  return parsed;
}
function parseBefore(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new HttpFailure(400, "invalid_input", "The message cursor must be a bounded integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpFailure(400, "invalid_input", "The message cursor is outside the supported bound.");
  return parsed;
}
function exactQuery(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpFailure(400, "invalid_input", "Invalid message query fields.");
}
function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new HttpFailure(400, "invalid_input", "Invalid message reference."); }
}
function operationResult(operation: MessageOperation): MessageOperation { return operation; }

export function messageApplication(domain: MessageDomain, principal: Principal, method: string, url: URL, input?: unknown) {
  return Effect.gen(function* () {
    const path = url.pathname;
    const operationPath = /^\/v1\/message-operations\/([^/]+)$/.exec(path);
    const deliveryPath = /^\/v1\/message-deliveries\/([^/]+)$/.exec(path);
    const threadPath = /^\/v1\/messages\/([^/]+)\/threads\/([^/]+)$/.exec(path);
    const botPath = /^\/v1\/messages\/([^/]+)$/.exec(path);
    if (operationPath || deliveryPath) requireCapability(principal, "messages.read");
    else if (method === "POST") requireCapability(principal, "messages.write");
    else if (url.searchParams.has("query")) requireCapability(principal, "messages.search");
    else requireCapability(principal, "messages.read");
    if (method === "POST" && path === "/v1/messages") {
      exactQuery(url, []);
      const request = yield* Effect.try({ try: () => normalizeMessageSend(input, domain.installationId), catch: failure });
      const result = yield* io(() => withGate(domain, async () => {
        let previous: MessageOperation | undefined;
        try { previous = await readRecord(domain, principal, request.requestId); } catch (error) { if (!(error instanceof Error && error.message === "message_record_missing")) throw error; }
        const digest = sha256Text(request.text);
        if (previous) {
          if (previous.botRef !== request.botRef || previous.clientNonce !== request.clientNonce || previous.textSha256 !== digest) throw new HttpFailure(409, "idempotency_conflict", "The request ID belongs to different message input.");
          if (previous.state === "unknown") throw new HttpFailure(409, "operation_unknown", "The original message outcome is unknown; read the original request before choosing another action.", { operation: previous });
          return previous;
        }
        const snapshot = await bots(domain, new AbortController().signal);
        targetBot(snapshot, request.botRef, domain.installationId);
        const initial: MessageOperation = {
          schemaVersion: 1, installationId: domain.installationId.toLowerCase(), actorId: principal.id, nativeRole: "human",
          requestId: request.requestId, operationRef: `message-operation:${domain.installationId}:${principal.id}:${request.requestId}`,
          submissionRef: `message-submission:${domain.installationId}:${randomUUID()}`, botRef: request.botRef, clientNonce: request.clientNonce,
          textSha256: digest, state: "unknown", createdAtMs: Date.now(), acceptedAtMs: null, nativeGeneration: null, nativeReceipt: null,
          association: { run: "not-observed", step: "not-observed", terminal: "not-observed", delivery: "unknown" }, coverage: "native-submission",
        };
        await writeRecord(domain, principal, initial);
        const continuity = domain.continuity?.(new AbortController().signal);
        if (!continuity) throw new HttpFailure(503, "source_unavailable", "The native continuity owner is unavailable; the request remains recorded as unknown.", { operation: initial });
        let native: Awaited<ReturnType<ContinuityGateway["rpc"]>>;
        try {
          native = await continuity.rpc("sendPrompt", { agentId: botIdFromRef(request.botRef, domain.installationId), prompt: request.text, clientNonce: request.clientNonce },
            { timeoutMs: 15_000, maxResponseBytes: 64 * 1024, write: true, singleAttempt: true, unknownOutcomeCode: "operation_outcome_unknown" });
        } catch (error) {
          throw new HttpFailure(409, "operation_unknown", "The native submission outcome is unknown; the request remains recorded and was not retried.", { operation: initial, reason: error instanceof Error ? error.message : "native_error" });
        }
        const accepted = !(native.result && typeof native.result === "object" && !Array.isArray(native.result)
          && "accepted" in native.result && native.result.accepted === false);
        if (!accepted) throw new HttpFailure(409, "operation_unknown", "The native owner did not confirm acceptance; the request remains recorded and was not retried.", { operation: initial });
        const settled: MessageOperation = { ...initial, state: "accepted", acceptedAtMs: Date.now(), nativeGeneration: sourceView(native.discovery)?.generation ?? null, nativeReceipt: { accepted: true } };
        await writeRecord(domain, principal, settled);
        return settled;
      }));
      return operationResult(result);
    }
    if (method === "GET" && operationPath) {
      exactQuery(url, []);
      const requestId = decoded(operationPath[1]!);
      if (!UUID.test(requestId)) throw new HttpFailure(400, "invalid_input", "Use the original message request UUID.");
      return yield* io(() => readRecord(domain, principal, requestId));
    }
    if (method === "GET" && deliveryPath) {
      exactQuery(url, ["waitMs"]);
      const requestId = decoded(deliveryPath[1]!);
      if (!UUID.test(requestId)) throw new HttpFailure(400, "invalid_input", "Use the original message request UUID.");
      const waitMs = parseWait(url.searchParams.get("waitMs"));
      const deadline = Date.now() + waitMs;
      let operation = yield* io(() => readRecord(domain, principal, requestId));
      let page: MessagePage = { botRef: operation.botRef, entries: [], nextBeforeSeq: null, source: null, coverage: "native-source-unavailable" };
      do {
        try { page = yield* io(() => transcript(domain, operation.botRef, new AbortController().signal, 200)); }
        catch (error) { if (waitMs === 0) throw yield* Effect.fail(failure(error)); page = { ...page, coverage: "native-source-unavailable" }; }
        const association = associationFor(operation, page.entries);
        if (association.delivery !== "unknown" || Date.now() >= deadline) {
          const changed = operation.association.delivery !== association.delivery;
          operation = operationWithAssociation(operation, association);
          return yield* io(async () => {
            if (changed) await withGate(domain, async () => { await writeRecord(domain, principal, operation); });
            return { operation, state: association.delivery, observedAtMs: Date.now(), entries: page.entries, source: page.source, association, coverage: page.coverage } satisfies MessageDelivery;
          });
        }
        yield* io(async () => { await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))); });
      } while (Date.now() <= deadline);
      const association = associationFor(operation, page.entries);
      const changed = operation.association.delivery !== association.delivery;
      operation = operationWithAssociation(operation, association);
      return yield* io(async () => {
        if (changed) await withGate(domain, async () => { await writeRecord(domain, principal, operation); });
        return { operation, state: association.delivery, observedAtMs: Date.now(), entries: page.entries, source: page.source, association, coverage: page.coverage } satisfies MessageDelivery;
      });
    }
    if (method === "GET" && threadPath) {
      exactQuery(url, ["limit"]);
      const target = decoded(threadPath[1]!);
      const rootId = decoded(threadPath[2]!);
      const page = yield* io(() => transcript(domain, target, new AbortController().signal, parseLimit(url.searchParams.get("limit"), 200, 50)));
      return { ...page, entries: page.entries.filter(entryItem => entryItem.rootId === rootId || entryItem.id === rootId) } satisfies MessagePage;
    }
    if (method === "GET" && botPath) {
      exactQuery(url, ["limit", "beforeSeq"]);
      const target = decoded(botPath[1]!);
      const page = yield* io(() => transcript(domain, target, new AbortController().signal, parseLimit(url.searchParams.get("limit"), 200, 50), parseBefore(url.searchParams.get("beforeSeq"))));
      return page;
    }
    if (method === "GET" && path === "/v1/messages") {
      exactQuery(url, ["query", "bot", "limit"]);
      const query = url.searchParams.get("query");
      if (query === null || query.length < 1 || query.length > 1024 || /[\x00-\x1f\x7f]/.test(query)) throw new HttpFailure(400, "invalid_input", "The message search query is invalid.");
      const target = url.searchParams.get("bot");
      const snapshot = yield* io(() => bots(domain, new AbortController().signal));
      const selected = target ? [target] : snapshot.bots.map(bot => botRef(domain.installationId, bot.id)).slice(0, 20);
      const matches: MessageSearchPage["matches"] = [];
      let source: MessagePage["source"] = null;
      for (const bot of selected) {
        const page = yield* io(() => transcript(domain, bot, new AbortController().signal, 200));
        source ??= page.source;
        for (const item of page.entries) if (item.text?.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          matches.push({ botRef: bot, entry: item });
          if (matches.length >= parseLimit(url.searchParams.get("limit"), 100, 20)) break;
        }
        if (matches.length >= parseLimit(url.searchParams.get("limit"), 100, 20)) break;
      }
      return { matches, source, coverage: source ? "native-transcript-window" : "native-source-unavailable" } satisfies MessageSearchPage;
    }
    throw new HttpFailure(405, "invalid_input", "The message endpoint does not support this method or path.");
  });
}
