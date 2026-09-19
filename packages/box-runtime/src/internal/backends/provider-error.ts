import { BackendFailure, classifyProviderFailure, isConfirmedOverflow, invalidStream, annotateStreamFailure, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { sdkValidationObservation } from "./sdk-validation.ts";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
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

// Text-only compatibility is narrower than structured error codes: mentioning
// a capacity or an invalid output parameter does not prove input overflow.
function isOpenAIContextWindowMessage(text: string): boolean {
  return /\bcontext_(?:too_large|length_exceeded)\b|\bcontext (?:window|length)\s+(?:(?:is|was|has been)\s+)?(?:exceeded|too (?:large|long))\b/i.test(text);
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
  if ((errorRole || depth === 0) && typeof raw.message === "string" && raw.message.length > 0 && raw.message.length <= 8 * 1024) {
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

/** Recovery evidence from structured fields or the bounded text compatibility rule. */
export function overflowEvidenceFromProvider(input: unknown): OverflowEvidence {
  const named = isRecord(input) ? input : {};
  const inspected = inspectStructuredProviderError(input);
  const providerCode = inspected.providerCode ?? (typeof named.providerCode === "string" ? named.providerCode : undefined);
  const namedStatus = typeof named.httpStatus === "number" ? named.httpStatus : undefined;
  const httpStatus = inspected.unknown ? undefined : (inspected.httpStatus ?? namedStatus);
  const messageFallback = inspected.messageFallback === true || named.messageFallback === true;
  return {
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    auth: named.auth === true || inspected.auth || httpStatus === 401,
    rateLimited: named.rateLimited === true || inspected.rateLimited || httpStatus === 429,
    payloadTooLarge: named.payloadTooLarge === true || inspected.payloadTooLarge || httpStatus === 413,
    timeout: named.timeout === true,
    disconnected: named.disconnected === true || inspected.disconnected,
    unknown: named.unknown === true || inspected.unknown,
    ...(messageFallback && !providerCode ? { messageFallback: true } : {}),
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
  const auth = inspected.auth;
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
