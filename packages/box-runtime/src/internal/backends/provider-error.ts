import { BackendFailure, classifyProviderFailure, isConfirmedOverflow, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;
const CONFIRMED_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_too_large"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHttpStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const status = value.statusCode ?? value.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return undefined;
}

function readNestedCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.code;
  if (typeof direct === "string" && CONFIRMED_OVERFLOW_CODES.has(direct)) return direct;
  const err = isRecord(value.error) ? value.error : undefined;
  if (err && typeof err.code === "string" && CONFIRMED_OVERFLOW_CODES.has(err.code)) return err.code;
  const data = isRecord(value.data) ? value.data : undefined;
  if (data) {
    const nested = readNestedCode(data);
    if (nested) return nested;
  }
  const response = isRecord(value.response) ? value.response : undefined;
  if (response) {
    const failed = readNestedCode(response);
    if (failed) return failed;
    if (isRecord(response.error) && typeof response.error.code === "string" && CONFIRMED_OVERFLOW_CODES.has(response.error.code)) {
      return response.error.code;
    }
  }
  if (value.type === "response.failed" && response && isRecord(response.error) && typeof response.error.code === "string") {
    return CONFIRMED_OVERFLOW_CODES.has(response.error.code) ? response.error.code : undefined;
  }
  if (typeof value.responseBody === "string" && Buffer.byteLength(value.responseBody) <= 64 * 1024) {
    try {
      const parsed = JSON.parse(value.responseBody) as unknown;
      return readNestedCode(parsed);
    } catch { /* Structured code only. */ }
  }
  return undefined;
}

/** Structured Responses/SSE overflow fields. Message text is never confirmation. */
export function structuredOverflowFromUnknown(raw: unknown): { httpStatus?: number; providerCode?: string } {
  const httpStatus = readHttpStatus(raw);
  const providerCode = readNestedCode(raw);
  const sse = isRecord(raw) && raw.type === "response.failed" && providerCode
    ? 200
    : undefined;
  const status = httpStatus ?? sse;
  return {
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
}

/** Recovery evidence. Message text is never confirmation. */
export function overflowEvidenceFromProvider(input: {
  httpStatus?: number;
  providerCode?: string;
  auth?: boolean;
  rateLimited?: boolean;
  payloadTooLarge?: boolean;
  timeout?: boolean;
  disconnected?: boolean;
  unknown?: boolean;
  releasedText?: number;
  releasedReasoning?: number;
  releasedTools?: number;
}): OverflowEvidence {
  const structured = structuredOverflowFromUnknown(input);
  const providerCode = structured.providerCode ?? input.providerCode;
  const httpStatus = structured.httpStatus ?? input.httpStatus;
  const code = typeof providerCode === "string" && CONFIRMED_OVERFLOW_CODES.has(providerCode)
    ? providerCode : providerCode;
  return {
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    auth: input.auth === true || input.httpStatus === 401,
    rateLimited: input.rateLimited === true || input.httpStatus === 429,
    payloadTooLarge: input.payloadTooLarge === true || input.httpStatus === 413,
    timeout: input.timeout === true,
    disconnected: input.disconnected === true,
    unknown: input.unknown === true,
    ...(typeof input.releasedText === "number" ? { releasedText: input.releasedText } : {}),
    ...(typeof input.releasedReasoning === "number" ? { releasedReasoning: input.releasedReasoning } : {}),
    ...(typeof input.releasedTools === "number" ? { releasedTools: input.releasedTools } : {}),
  };
}

export function isProviderConfirmedOverflow(input: Parameters<typeof overflowEvidenceFromProvider>[0]): boolean {
  return isConfirmedOverflow(overflowEvidenceFromProvider(input));
}

/** Map provider failures to the fixed whitelist. Never returns raw body/Cause. */
export function backendFailureFromUnknown(error: unknown, phase: BackendPhase = "sdk"): BackendFailure {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const auth = AUTH.test(text);
  const overflow = OVERFLOW.test(text);
  const structured = structuredOverflowFromUnknown(error);
  const evidence = overflowEvidenceFromProvider({
    ...structured,
    auth,
    rateLimited: structured.httpStatus === 429,
    payloadTooLarge: structured.httpStatus === 413,
  });
  if (error instanceof BackendFailure) {
    if (error.code === "overflow_candidate" && auth) return classifyProviderFailure({ auth: true, overflow: true });
    const tagged = error.overflowEvidence ? error : new BackendFailure(error.code, {
      overflowCandidate: error.overflowCandidate,
      overflowEvidence: evidence,
    });
    return observeBackendFailure(tagged, error.code === "stream_invalid" ? "normalize" : phase, error);
  }
  const classified = classifyProviderFailure({ auth, overflow: overflow || Boolean(structured.providerCode) });
  const tagged = new BackendFailure(classified.code, {
    overflowCandidate: classified.overflowCandidate,
    overflowEvidence: evidence,
  });
  return observeBackendFailure(tagged, phase, error);
}
