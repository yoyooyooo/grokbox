import { BackendFailure, classifyProviderFailure, isConfirmedOverflow, invalidStream, annotateStreamFailure, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { sdkValidationObservation } from "./sdk-validation.ts";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;
const CONFIRMED_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_too_large"]);
const AUTH_MARKERS = new Set(["authentication_error", "invalid_api_key", "unauthorized"]);
const RATE_MARKERS = new Set(["rate_limit_exceeded", "rate_limit_error"]);
const STREAM_DISCONNECT_CODES = new Set([
  "upstream_http2_stream_error",
  "upstream_stream_read_error",
  "upstream_stream_truncated",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type StructuredSurface = {
  httpStatus?: number;
  providerCode?: string;
  auth: boolean;
  rateLimited: boolean;
  payloadTooLarge: boolean;
  disconnected: boolean;
  unknown: boolean;
  messageFallback: boolean;
};

type InspectAcc = {
  statuses: Set<number>;
  overflow?: string;
  auth: boolean;
  rate: boolean;
  disconnected: boolean;
  invalidStatus: boolean;
  failedEvent: boolean;
  streamErrorEvent: boolean;
  messages: string[];
};

/**
 * Sub2API `isOpenAIContextWindowError` phrases (survey medium).
 * Does not match `max_tokens` / output-length / payload-too-large.
 */
function isOpenAIContextWindowMessage(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("context_too_large") || t.includes("context_length_exceeded")) return true;
  if (/\bmax(?:imum)?\s+context\s+length\b/.test(t)) return true;
  if (/(?:context window|context length)[\s\S]{0,80}(?:exceed|too large|too long)/.test(t)) return true;
  if (/(?:exceed|too large|too long)[\s\S]{0,80}(?:context window|context length)/.test(t)) return true;
  if (/\btoken limit\b/.test(t) && /\bcontext\b/.test(t) && /exceed/.test(t)) return true;
  return false;
}

function noteMarker(marker: string, acc: InspectAcc, inError: boolean): void {
  if (AUTH_MARKERS.has(marker)) acc.auth = true;
  if (RATE_MARKERS.has(marker)) acc.rate = true;
  if (STREAM_DISCONNECT_CODES.has(marker)) acc.disconnected = true;
  if (inError && CONFIRMED_OVERFLOW_CODES.has(marker)) acc.overflow = acc.overflow ?? marker;
}

function inspectStructuredProviderError(raw: unknown, depth = 0, acc: InspectAcc = {
  statuses: new Set(), auth: false, rate: false, disconnected: false, invalidStatus: false,
  failedEvent: false, streamErrorEvent: false, messages: [],
}, inError = false): StructuredSurface {
  if (depth > 6 || !isRecord(raw)) return finishInspect(acc);
  if (raw.type === "response.failed") acc.failedEvent = true;
  if (depth === 0 && raw.type === "error") acc.streamErrorEvent = true;
  const errorRole = inError || raw.type === "response.failed" || (depth === 0 && raw.type === "error");
  for (const key of ["type", "code"] as const) {
    const marker = raw[key];
    if (typeof marker === "string") noteMarker(marker, acc, errorRole);
  }
  if (errorRole && typeof raw.message === "string" && raw.message.length > 0 && raw.message.length <= 8 * 1024) {
    acc.messages.push(raw.message);
  }
  if (depth === 0 && typeof raw.message === "string" && raw.message.length > 0 && raw.message.length <= 8 * 1024) {
    acc.messages.push(raw.message);
  }
  for (const key of ["statusCode", "status"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const status = raw[key];
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      acc.statuses.add(status);
    } else if (status !== "failed") {
      acc.invalidStatus = true;
    }
  }
  if (typeof raw.responseBody === "string" && Buffer.byteLength(raw.responseBody) <= 64 * 1024) {
    try {
      inspectStructuredProviderError(JSON.parse(raw.responseBody) as unknown, depth + 1, acc, false);
    } catch { /* Structured fields only. */ }
  }
  inspectStructuredProviderError(raw.error, depth + 1, acc, true);
  inspectStructuredProviderError(raw.data, depth + 1, acc, inError);
  inspectStructuredProviderError(raw.response, depth + 1, acc, inError);
  return finishInspect(acc);
}

function finishInspect(acc: InspectAcc): StructuredSurface {
  const conflict = acc.statuses.size > 1;
  const httpStatus = !conflict && acc.statuses.size === 1 ? [...acc.statuses][0] : undefined;
  if (httpStatus === 401) acc.auth = true;
  const streamTerminal = acc.failedEvent || acc.streamErrorEvent;
  const impliedStreamStatus = streamTerminal && httpStatus === undefined && !acc.invalidStatus
    && !conflict && !acc.auth && !acc.rate && !acc.disconnected;
  const unknown = conflict || (acc.invalidStatus && (acc.overflow !== undefined || streamTerminal));
  const surfaceStatus = impliedStreamStatus ? 200 : httpStatus;
  const negatives = acc.auth || acc.rate || httpStatus === 429 || httpStatus === 413 || httpStatus === 401
    || acc.disconnected || unknown;
  const statusOk = surfaceStatus === 200 || surfaceStatus === 400;
  const messageFallback = !acc.overflow && !negatives && statusOk
    && acc.messages.some((text) => isOpenAIContextWindowMessage(text));
  return {
    ...(impliedStreamStatus ? { httpStatus: 200 } : httpStatus !== undefined ? { httpStatus } : {}),
    ...(acc.overflow ? { providerCode: acc.overflow } : {}),
    auth: acc.auth,
    rateLimited: acc.rate || httpStatus === 429,
    payloadTooLarge: httpStatus === 413,
    disconnected: acc.disconnected,
    unknown,
    messageFallback,
  };
}

/** Structured Responses/SSE overflow fields. Message text is never a structured code. */
export function structuredOverflowFromUnknown(raw: unknown): { httpStatus?: number; providerCode?: string } {
  const inspected = inspectStructuredProviderError(raw);
  return {
    ...(inspected.httpStatus !== undefined ? { httpStatus: inspected.httpStatus } : {}),
    ...(inspected.providerCode !== undefined ? { providerCode: inspected.providerCode } : {}),
  };
}

/** Recovery evidence. Structured codes first; Sub2API message fallback is allowlisted medium only. */
export function overflowEvidenceFromProvider(input: unknown): OverflowEvidence {
  const named = isRecord(input) ? input : {};
  const inspected = inspectStructuredProviderError(input);
  const providerCode = inspected.providerCode ?? (typeof named.providerCode === "string" ? named.providerCode : undefined);
  const namedStatus = typeof named.httpStatus === "number" ? named.httpStatus : undefined;
  const httpStatus = inspected.unknown ? undefined : (inspected.httpStatus ?? namedStatus);
  const code = typeof providerCode === "string" && CONFIRMED_OVERFLOW_CODES.has(providerCode)
    ? providerCode : providerCode;
  const messageFallback = inspected.messageFallback === true || named.messageFallback === true;
  return {
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    auth: named.auth === true || inspected.auth || httpStatus === 401,
    rateLimited: named.rateLimited === true || inspected.rateLimited || httpStatus === 429,
    payloadTooLarge: named.payloadTooLarge === true || inspected.payloadTooLarge || httpStatus === 413,
    timeout: named.timeout === true,
    disconnected: named.disconnected === true || inspected.disconnected,
    unknown: named.unknown === true || inspected.unknown,
    ...(messageFallback && !code ? { messageFallback: true } : {}),
    ...(typeof named.releasedText === "number" ? { releasedText: named.releasedText } : {}),
    ...(typeof named.releasedReasoning === "number" ? { releasedReasoning: named.releasedReasoning } : {}),
    ...(typeof named.releasedTools === "number" ? { releasedTools: named.releasedTools } : {}),
  };
}

export function isProviderConfirmedOverflow(input: unknown): boolean {
  return isConfirmedOverflow(overflowEvidenceFromProvider(input));
}

/** Map provider failures to the fixed whitelist. Never returns raw body/Cause. */
export function backendFailureFromUnknown(error: unknown, phase: BackendPhase = "sdk"): BackendFailure {
  if (error instanceof BackendFailure && error.code !== "overflow_candidate") {
    return observeBackendFailure(error, error.code === "stream_invalid" ? "normalize" : phase, error);
  }
  const sdkValidation = sdkValidationObservation(error);
  if (sdkValidation) return annotateStreamFailure(invalidStream(sdkValidation.kind === "schema" ? "sdk_schema_mismatch" : "invalid_event_shape", "sdk_part"), { sdkValidation });
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const inspected = inspectStructuredProviderError(error);
  const auth = AUTH.test(text) || inspected.auth;
  const overflow = OVERFLOW.test(text) || inspected.messageFallback;
  const evidence = overflowEvidenceFromProvider({
    ...inspected,
    auth,
    rateLimited: inspected.rateLimited,
    payloadTooLarge: inspected.payloadTooLarge,
    disconnected: inspected.disconnected,
    unknown: inspected.unknown,
  });
  if (error instanceof BackendFailure) {
    if (auth || evidence.auth) {
      return classifyProviderFailure({ auth: true, overflow: true });
    }
    const tagged = error.overflowEvidence ? error : new BackendFailure(error.code, {
      overflowCandidate: error.overflowCandidate,
      overflowEvidence: evidence,
    });
    return observeBackendFailure(tagged, phase, error);
  }
  const classified = classifyProviderFailure({
    auth: auth || evidence.auth,
    overflow: overflow || Boolean(inspected.providerCode) || inspected.messageFallback,
  });
  const tagged = new BackendFailure(classified.code, {
    overflowCandidate: classified.overflowCandidate,
    overflowEvidence: evidence,
  });
  return observeBackendFailure(tagged, phase, error);
}
