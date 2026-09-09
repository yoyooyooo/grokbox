import { BackendFailure } from "@grokbox/runtime-kernel/contract";

export const BACKEND_PHASES = ["prepare", "auth", "sdk", "provider", "normalize"] as const;
export type BackendPhase = (typeof BACKEND_PHASES)[number];
export const FAILURE_REASONS = [
  "unknown", "validation", "auth", "transport", "http", "sdk_validation", "sdk_no_output", "stream_shape",
] as const;
export const PROVIDER_CODES = [
  "invalid_request_error", "invalid_api_key", "insufficient_quota", "rate_limit_exceeded",
  "model_not_found", "unsupported_parameter", "missing_required_parameter", "invalid_value",
  "context_length_exceeded", "context_window_exceeded", "prompt_too_long", "request_too_large",
] as const;
export const PROVIDER_PARAMS = [
  "model", "instructions", "input", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream",
  "temperature", "top_p", "max_tokens", "max_output_tokens", "reasoning", "store",
] as const;
export type BackendObservation = {
  phase: BackendPhase;
  reason: (typeof FAILURE_REASONS)[number];
  httpStatus?: number;
  providerCode?: (typeof PROVIDER_CODES)[number];
  providerParam?: (typeof PROVIDER_PARAMS)[number];
};

// Metadata follows the particular failure, never a mutable process-wide 'last request'.
// Neither the original Error/Cause nor response body is retained here.
const observations = new WeakMap<BackendFailure, BackendObservation>();
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function member<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === "string" && choices.includes(value as T) ? value as T : undefined;
}

export function observeBackendFailure(failure: BackendFailure, phase: BackendPhase, raw?: unknown): BackendFailure {
  if (observations.has(failure)) return failure;
  let result: BackendObservation = { phase, reason: phase === "prepare" ? "validation" : phase === "auth" ? "auth" : phase === "normalize" ? "stream_shape" : "unknown" };
  try {
    const error = record(raw);
    const status = error?.statusCode;
    const statusValid = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
    let provider = record(error?.data);
    if (typeof error?.responseBody === "string" && Buffer.byteLength(error.responseBody) <= 64 * 1024) {
      try { provider = record(JSON.parse(error.responseBody)); } catch { /* No raw text fallback. */ }
    }
    provider = record(provider?.error) ?? provider;
    if (statusValid) result = { phase: "provider", reason: status === 401 || status === 403 ? "auth" : "http", httpStatus: status };
    else if (error?.name === "AI_TypeValidationError" || error?.name === "AI_InvalidPromptError" || error?.name === "AI_JSONParseError") {
      result = { phase: "sdk", reason: "sdk_validation" };
    } else if (error?.name === "AI_NoOutputGeneratedError") result = { phase: "sdk", reason: "sdk_no_output" };
    else if (phase === "provider") result.reason = "transport";
    const code = member(provider?.code ?? provider?.type, PROVIDER_CODES);
    const param = member(provider?.param, PROVIDER_PARAMS);
    if (code) result.providerCode = code;
    if (param) result.providerParam = param;
  } catch { /* Malformed diagnostic fields cannot change inference semantics. */ }
  observations.set(failure, Object.freeze(result));
  return failure;
}

export function backendFailureObservation(error: unknown): BackendObservation | undefined {
  return error instanceof BackendFailure ? observations.get(error) : undefined;
}
