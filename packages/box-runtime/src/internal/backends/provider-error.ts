import { BackendFailure, classifyProviderFailure, isConfirmedOverflow, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;
const CONFIRMED_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_too_large"]);
const AUTH_MARKERS = new Set(["authentication_error", "invalid_api_key", "unauthorized"]);
const RATE_MARKERS = new Set(["rate_limit_exceeded", "rate_limit_error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type StructuredSurface = {
  httpStatus?: number;
  providerCode?: string;
  auth: boolean;
  rateLimited: boolean;
  payloadTooLarge: boolean;
  unknown: boolean;
};

function inspectStructuredProviderError(raw: unknown, depth = 0, acc: {
  statuses: Set<number>;
  overflow?: string;
  auth: boolean;
  rate: boolean;
  invalidStatus: boolean;
  failedEvent: boolean;
} = { statuses: new Set(), auth: false, rate: false, invalidStatus: false, failedEvent: false }): StructuredSurface {
  if (depth > 6 || !isRecord(raw)) {
    return finishInspect(acc);
  }
  if (raw.type === "response.failed") acc.failedEvent = true;
  for (const key of ["type", "code"] as const) {
    const marker = raw[key];
    if (typeof marker !== "string") continue;
    if (CONFIRMED_OVERFLOW_CODES.has(marker)) acc.overflow = acc.overflow ?? marker;
    if (AUTH_MARKERS.has(marker)) acc.auth = true;
    if (RATE_MARKERS.has(marker)) acc.rate = true;
  }
  for (const key of ["statusCode", "status"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const status = raw[key];
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      acc.statuses.add(status);
    } else {
      acc.invalidStatus = true;
    }
  }
  if (typeof raw.responseBody === "string" && Buffer.byteLength(raw.responseBody) <= 64 * 1024) {
    try {
      inspectStructuredProviderError(JSON.parse(raw.responseBody) as unknown, depth + 1, acc);
    } catch { /* Structured fields only. */ }
  }
  inspectStructuredProviderError(raw.error, depth + 1, acc);
  inspectStructuredProviderError(raw.data, depth + 1, acc);
  inspectStructuredProviderError(raw.response, depth + 1, acc);
  return finishInspect(acc);
}

function finishInspect(acc: {
  statuses: Set<number>;
  overflow?: string;
  auth: boolean;
  rate: boolean;
  invalidStatus: boolean;
  failedEvent: boolean;
}): StructuredSurface {
  const conflict = acc.statuses.size > 1;
  const httpStatus = !conflict && acc.statuses.size === 1 ? [...acc.statuses][0] : undefined;
  if (httpStatus === 401) acc.auth = true;
  const sseFallback = acc.failedEvent && acc.overflow && httpStatus === undefined && !acc.invalidStatus && !acc.auth && !conflict && !acc.rate;
  const unknown = conflict || (acc.invalidStatus && (acc.overflow !== undefined || acc.failedEvent));
  return {
    ...(sseFallback ? { httpStatus: 200 } : httpStatus !== undefined ? { httpStatus } : {}),
    ...(acc.overflow ? { providerCode: acc.overflow } : {}),
    auth: acc.auth,
    rateLimited: acc.rate || httpStatus === 429,
    payloadTooLarge: httpStatus === 413,
    unknown,
  };
}

/** Structured Responses/SSE overflow fields. Message text is never confirmation. */
export function structuredOverflowFromUnknown(raw: unknown): { httpStatus?: number; providerCode?: string } {
  const inspected = inspectStructuredProviderError(raw);
  return {
    ...(inspected.httpStatus !== undefined ? { httpStatus: inspected.httpStatus } : {}),
    ...(inspected.providerCode !== undefined ? { providerCode: inspected.providerCode } : {}),
  };
}

/** Recovery evidence. Message text is never confirmation. Conflicts veto confirmation. */
export function overflowEvidenceFromProvider(input: unknown): OverflowEvidence {
  const named = isRecord(input) ? input : {};
  const inspected = inspectStructuredProviderError(input);
  const providerCode = inspected.providerCode ?? (typeof named.providerCode === "string" ? named.providerCode : undefined);
  const namedStatus = typeof named.httpStatus === "number" ? named.httpStatus : undefined;
  const httpStatus = inspected.unknown ? undefined : (inspected.httpStatus ?? namedStatus);
  const code = typeof providerCode === "string" && CONFIRMED_OVERFLOW_CODES.has(providerCode)
    ? providerCode : providerCode;
  return {
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    auth: named.auth === true || inspected.auth || httpStatus === 401,
    rateLimited: named.rateLimited === true || inspected.rateLimited || httpStatus === 429,
    payloadTooLarge: named.payloadTooLarge === true || inspected.payloadTooLarge || httpStatus === 413,
    timeout: named.timeout === true,
    disconnected: named.disconnected === true,
    unknown: named.unknown === true || inspected.unknown,
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
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const inspected = inspectStructuredProviderError(error);
  const auth = AUTH.test(text) || inspected.auth;
  const overflow = OVERFLOW.test(text);
  const evidence = overflowEvidenceFromProvider({
    ...inspected,
    auth,
    rateLimited: inspected.rateLimited,
    payloadTooLarge: inspected.payloadTooLarge,
    unknown: inspected.unknown,
  });
  if (error instanceof BackendFailure) {
    if (error.code === "overflow_candidate" && (auth || evidence.auth)) {
      return classifyProviderFailure({ auth: true, overflow: true });
    }
    const tagged = error.overflowEvidence ? error : new BackendFailure(error.code, {
      overflowCandidate: error.overflowCandidate,
      overflowEvidence: evidence,
    });
    return observeBackendFailure(tagged, error.code === "stream_invalid" ? "normalize" : phase, error);
  }
  const classified = classifyProviderFailure({
    auth: auth || evidence.auth,
    overflow: overflow || Boolean(inspected.providerCode),
  });
  const tagged = new BackendFailure(classified.code, {
    overflowCandidate: classified.overflowCandidate,
    overflowEvidence: evidence,
  });
  return observeBackendFailure(tagged, phase, error);
}
