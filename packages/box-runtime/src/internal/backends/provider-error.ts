import { BackendFailure, classifyProviderFailure, isConfirmedOverflow, type OverflowEvidence } from "@grokbox/runtime-kernel/contract";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;
const CONFIRMED_OVERFLOW_CODES = new Set(["context_length_exceeded", "context_too_large"]);

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
  const code = typeof input.providerCode === "string" && CONFIRMED_OVERFLOW_CODES.has(input.providerCode)
    ? input.providerCode : input.providerCode;
  return {
    ...(typeof code === "string" ? { providerCode: code } : {}),
    ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
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
  if (error instanceof BackendFailure) {
    if (error.code === "overflow_candidate" && auth) return classifyProviderFailure({ auth: true, overflow: true });
    return observeBackendFailure(error, error.code === "stream_invalid" ? "normalize" : phase, error);
  }
  return observeBackendFailure(classifyProviderFailure({ auth, overflow }), phase, error);
}
