import { ManagementClientError, UUID, botIdFromRef, botRef } from "./contract.ts";

export type MessageAssociation = {
  /** Native queue evidence is only present when the source reports it explicitly. */
  queue: "not-observed" | "queued";
  run: "not-observed";
  turn: "not-observed";
  step: "not-observed";
  terminal: "not-observed";
  delivery: "recorded" | "response-observed" | "unknown";
};

export type MessageSendRequest = {
  requestId: string;
  botRef: string;
  text: string;
  clientNonce: string;
};

export type MessageOperation = {
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  operationRef: string;
  submissionRef: string;
  botRef: string;
  clientNonce: string;
  textSha256: string;
  state: "accepted" | "unknown";
  acceptedAtMs: number;
  nativeGeneration: string | null;
  nativeReceipt: Record<string, unknown> | null;
  association: MessageAssociation;
  coverage: "native-submission";
};

export type MessageEntry = {
  id: string;
  /** Transcript entry kind and native request ID, not the management request UUID. */
  kind: "message" | "send-message" | "unknown";
  requestId: string | null;
  isStreaming: boolean | null;
  role: "user" | "assistant" | "system" | "unknown";
  text: string | null;
  observedAtMs: number | null;
  clientNonce: string | null;
  rootId: string | null;
  truncated: boolean;
};

export type MessagePage = {
  botRef: string;
  entries: MessageEntry[];
  nextBeforeSeq: number | null;
  source: { generation: string; pid: number; startedAt: number } | null;
  coverage: "native-transcript-window" | "native-source-unavailable";
};

export type MessageDelivery = {
  operation: MessageOperation;
  state: "recorded" | "response-observed" | "unknown";
  observedAtMs: number;
  entries: MessageEntry[];
  source: MessagePage["source"];
  association: MessageAssociation;
  coverage: "native-transcript-window" | "native-source-unavailable";
};

export type MessageSearchHit = {
  botRef: string;
  entry: MessageEntry;
};

export type MessageSearchPage = {
  matches: MessageSearchHit[];
  source: MessagePage["source"];
  coverage: "native-transcript-window" | "native-source-unavailable";
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const source = (value: unknown) => value === null || record(value)
  && own(value, ["generation", "pid", "startedAt"])
  && typeof value.generation === "string" && /^[a-f0-9]{64}$/.test(value.generation)
  && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
  && Number.isSafeInteger(value.startedAt) && Number(value.startedAt) >= 0;
const scopedBot = (value: unknown, installationId: string) => {
  try { return typeof value === "string" && value === botRef(installationId, botIdFromRef(value, installationId)); }
  catch { return false; }
};

export function normalizeMessageSend(value: unknown, installationId: string): MessageSendRequest {
  if (!record(value) || !own(value, ["requestId", "botRef", "text", "clientNonce"])
    || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.botRef !== "string"
    || typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > 32_000
    || /[\u0000]/.test(value.text)
    || typeof value.clientNonce !== "string" || !UUID.test(value.clientNonce)) {
    throw new ManagementClientError("invalid_input", "A message requires bounded text, a Bot reference, a request UUID and a client nonce.");
  }
  const id = botIdFromRef(value.botRef, installationId);
  return { requestId: value.requestId.toLowerCase(), botRef: botRef(installationId, id), text: value.text, clientNonce: value.clientNonce.toLowerCase() };
}

export function messageOperation(value: unknown, installationId: string, requestId?: string): value is MessageOperation {
  if (!record(value) || value.schemaVersion !== 1 || !own(value, ["schemaVersion","installationId","requestId","operationRef","submissionRef","botRef","clientNonce","textSha256","state","acceptedAtMs","nativeGeneration","nativeReceipt","association","coverage"])
    || value.installationId !== installationId.toLowerCase() || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || (requestId !== undefined && value.requestId !== requestId.toLowerCase())
    || typeof value.operationRef !== "string" || typeof value.submissionRef !== "string"
    || typeof value.botRef !== "string" || typeof value.clientNonce !== "string" || !UUID.test(value.clientNonce)
    || typeof value.textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.textSha256)
    || (value.state !== "accepted" && value.state !== "unknown")
    || !Number.isSafeInteger(value.acceptedAtMs)
    || (value.nativeGeneration !== null && (typeof value.nativeGeneration !== "string" || !/^[a-f0-9]{64}$/.test(value.nativeGeneration)))
    || (value.nativeReceipt !== null && !record(value.nativeReceipt))
    || !record(value.association) || !["not-observed","queued"].includes(String(value.association.queue))
    || value.association.run !== "not-observed" || value.association.turn !== "not-observed"
    || value.association.step !== "not-observed" || value.association.terminal !== "not-observed"
    || !["recorded","response-observed","unknown"].includes(String(value.association.delivery))
    || value.coverage !== "native-submission") return false;
  try {
    const id = botIdFromRef(value.botRef, value.installationId);
    return UUID.test(value.installationId) && value.botRef === botRef(value.installationId, id)
      && value.operationRef === `message-operation:${value.installationId}:${id}:${value.requestId}`
      && value.submissionRef === `submission:${value.installationId}:${id}:${value.requestId}`;
  } catch {
    return false;
  }
}

export function messagePage(value: unknown, installationId: string, expectedBotRef?: string): value is MessagePage {
  if (!record(value) || !own(value, ["botRef","entries","nextBeforeSeq","source","coverage"])
    || typeof value.botRef !== "string" || (expectedBotRef !== undefined && value.botRef !== expectedBotRef)
    || !Array.isArray(value.entries) || value.entries.length > 200
    || (value.nextBeforeSeq !== null && (typeof value.nextBeforeSeq !== "number" || !Number.isSafeInteger(value.nextBeforeSeq) || value.nextBeforeSeq < 0))
    || (value.source !== null && (!record(value.source) || typeof value.source.generation !== "string" || !Number.isSafeInteger(value.source.pid) || !Number.isSafeInteger(value.source.startedAt)))
    || !["native-transcript-window","native-source-unavailable"].includes(String(value.coverage))) return false;
  return UUID.test(installationId) && scopedBot(value.botRef, installationId) && source(value.source) && value.entries.every(entry => messageEntry(entry));
}

export function messageEntry(value: unknown): value is MessageEntry {
  return record(value) && own(value, ["id","kind","requestId","isStreaming","role","text","observedAtMs","clientNonce","rootId","truncated"])
    && typeof value.id === "string" && value.id.length <= 256
    && ["message", "send-message", "unknown"].includes(String(value.kind))
    && (value.requestId === null || typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 256)
    && (value.isStreaming === null || typeof value.isStreaming === "boolean")
    && ["user","assistant","system","unknown"].includes(String(value.role))
    && (value.text === null || typeof value.text === "string" && value.text.length <= 8192)
    && (value.observedAtMs === null || Number.isSafeInteger(value.observedAtMs))
    && (value.clientNonce === null || typeof value.clientNonce === "string")
    && (value.rootId === null || typeof value.rootId === "string")
    && typeof value.truncated === "boolean";
}

export function messageDelivery(value: unknown, installationId: string, requestId?: string): value is MessageDelivery {
  return record(value) && own(value, ["operation","state","observedAtMs","entries","source","association","coverage"])
    && messageOperation(value.operation, installationId, requestId)
    && ["recorded","response-observed","unknown"].includes(String(value.state))
    && Number.isSafeInteger(value.observedAtMs) && Array.isArray(value.entries) && value.entries.length <= 200 && value.entries.every(messageEntry)
    && source(value.source)
    && (value.source === null || record(value.source) && record(value.operation) && value.source.generation === value.operation.nativeGeneration)
    && record(value.association) && ["not-observed","queued"].includes(String(value.association.queue))
    && value.association.run === "not-observed" && value.association.turn === "not-observed"
    && value.association.step === "not-observed" && value.association.terminal === "not-observed"
    && value.association.delivery === value.state
    && ["native-transcript-window","native-source-unavailable"].includes(String(value.coverage));
}

export function messageSearchPage(value: unknown, installationId: string): value is MessageSearchPage {
  return record(value) && own(value, ["matches","source","coverage"]) && Array.isArray(value.matches) && value.matches.length <= 100
    && value.matches.every(hit => record(hit) && scopedBot(hit.botRef, installationId) && messageEntry(hit.entry))
    && source(value.source)
    && ["native-transcript-window","native-source-unavailable"].includes(String(value.coverage))
    && UUID.test(installationId);
}

