import { ManagementClientError, UUID, botIdFromRef, botRef } from "./contract.ts";

export type MessageAssociation = {
  run: "not-observed";
  step: "not-observed";
  terminal: "not-observed";
  delivery: "unknown" | "recorded" | "response-observed";
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
  actorId: string;
  nativeRole: "human";
  requestId: string;
  operationRef: string;
  submissionRef: string;
  botRef: string;
  clientNonce: string;
  textSha256: string;
  state: "unknown" | "accepted";
  createdAtMs: number;
  acceptedAtMs: number | null;
  nativeGeneration: string | null;
  nativeReceipt: { accepted: boolean } | null;
  association: MessageAssociation;
  coverage: "native-submission";
};

export type MessageEntry = {
  id: string;
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
  state: "unknown" | "recorded" | "response-observed";
  observedAtMs: number;
  entries: MessageEntry[];
  source: MessagePage["source"];
  association: MessageAssociation;
  coverage: MessagePage["coverage"];
};

export type MessageSearchHit = { botRef: string; entry: MessageEntry };
export type MessageSearchPage = {
  matches: MessageSearchHit[];
  source: MessagePage["source"];
  coverage: MessagePage["coverage"];
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, required: readonly string[]) =>
  Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

export function normalizeMessageSend(value: unknown, installationId: string): MessageSendRequest {
  if (!record(value) || !exact(value, ["requestId", "botRef", "text", "clientNonce"])
    || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || typeof value.botRef !== "string" || typeof installationId !== "string" || !UUID.test(installationId)
    || !boundedText(value.text, 32_000) || typeof value.clientNonce !== "string" || !UUID.test(value.clientNonce)) {
    throw new ManagementClientError("invalid_input", "A message requires bounded text, a Bot reference, a request UUID and a client nonce.");
  }
  return {
    requestId: value.requestId.toLowerCase(),
    botRef: botRef(installationId, botIdFromRef(value.botRef, installationId)),
    text: value.text,
    clientNonce: value.clientNonce.toLowerCase(),
  };
}

function association(value: unknown): value is MessageAssociation {
  return record(value) && exact(value, ["run", "step", "terminal", "delivery"])
    && value.run === "not-observed" && value.step === "not-observed" && value.terminal === "not-observed"
    && ["unknown", "recorded", "response-observed"].includes(String(value.delivery));
}

export function messageOperation(value: unknown, installationId: string, requestId?: string): value is MessageOperation {
  if (!record(value) || !exact(value, ["schemaVersion", "installationId", "actorId", "nativeRole", "requestId", "operationRef", "submissionRef", "botRef", "clientNonce", "textSha256", "state", "createdAtMs", "acceptedAtMs", "nativeGeneration", "nativeReceipt", "association", "coverage"])
    || value.schemaVersion !== 1 || value.installationId !== installationId.toLowerCase()
    || typeof value.actorId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value.actorId)
    || value.nativeRole !== "human" || typeof value.requestId !== "string" || !UUID.test(value.requestId)
    || requestId !== undefined && value.requestId !== requestId.toLowerCase()
    || typeof value.operationRef !== "string" || typeof value.submissionRef !== "string"
    || typeof value.botRef !== "string" || !value.botRef.startsWith(`bot:${installationId.toLowerCase()}:`)
    || typeof value.clientNonce !== "string" || !UUID.test(value.clientNonce)
    || typeof value.textSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.textSha256)
    || !["unknown", "accepted"].includes(String(value.state))
    || !Number.isSafeInteger(value.createdAtMs) || Number(value.createdAtMs) < 1
    || (value.acceptedAtMs !== null && (!Number.isSafeInteger(value.acceptedAtMs) || Number(value.acceptedAtMs) < Number(value.createdAtMs)))
    || (value.state === "accepted") !== (value.acceptedAtMs !== null)
    || (value.nativeGeneration !== null && !/^[a-f0-9]{64}$/.test(String(value.nativeGeneration)))
    || (value.nativeReceipt !== null && (!record(value.nativeReceipt) || !exact(value.nativeReceipt, ["accepted"]) || typeof value.nativeReceipt.accepted !== "boolean"))
    || !association(value.association) || value.coverage !== "native-submission") return false;
  try { botIdFromRef(value.botRef, installationId); return true; } catch { return false; }
}

export function messageEntry(value: unknown): value is MessageEntry {
  return record(value) && exact(value, ["id", "role", "text", "observedAtMs", "clientNonce", "rootId", "truncated"])
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256
    && ["user", "assistant", "system", "unknown"].includes(String(value.role))
    && (value.text === null || typeof value.text === "string")
    && (value.observedAtMs === null || Number.isSafeInteger(value.observedAtMs))
    && (value.clientNonce === null || typeof value.clientNonce === "string")
    && (value.rootId === null || typeof value.rootId === "string")
    && typeof value.truncated === "boolean";
}

export function messagePage(value: unknown, installationId: string, expectedBotRef?: string): value is MessagePage {
  return record(value) && exact(value, ["botRef", "entries", "nextBeforeSeq", "source", "coverage"])
    && typeof value.botRef === "string" && (expectedBotRef === undefined || value.botRef === expectedBotRef)
    && Array.isArray(value.entries) && value.entries.length <= 200 && value.entries.every(messageEntry)
    && (value.nextBeforeSeq === null || Number.isSafeInteger(value.nextBeforeSeq) && Number(value.nextBeforeSeq) >= 0)
    && (value.source === null || record(value.source) && Object.keys(value.source).length === 3
      && typeof value.source.generation === "string" && /^[a-f0-9]{64}$/.test(value.source.generation)
      && Number.isSafeInteger(value.source.pid) && Number(value.source.pid) > 0
      && Number.isSafeInteger(value.source.startedAt) && Number(value.source.startedAt) > 0)
    && ["native-transcript-window", "native-source-unavailable"].includes(String(value.coverage))
    && UUID.test(installationId);
}

export function messageDelivery(value: unknown, installationId: string, requestId?: string): value is MessageDelivery {
  return record(value) && exact(value, ["operation", "state", "observedAtMs", "entries", "source", "association", "coverage"])
    && messageOperation(value.operation, installationId, requestId)
    && ["unknown", "recorded", "response-observed"].includes(String(value.state))
    && Number.isSafeInteger(value.observedAtMs) && Array.isArray(value.entries) && value.entries.length <= 200
    && (value.source === null || record(value.source))
    && association(value.association)
    && ["native-transcript-window", "native-source-unavailable"].includes(String(value.coverage));
}

export function messageSearchPage(value: unknown, installationId: string): value is MessageSearchPage {
  return record(value) && exact(value, ["matches", "source", "coverage"]) && Array.isArray(value.matches) && value.matches.length <= 100
    && value.matches.every(hit => record(hit) && exact(hit, ["botRef", "entry"]) && typeof hit.botRef === "string" && messageEntry(hit.entry))
    && (value.source === null || record(value.source))
    && ["native-transcript-window", "native-source-unavailable"].includes(String(value.coverage))
    && UUID.test(installationId);
}

