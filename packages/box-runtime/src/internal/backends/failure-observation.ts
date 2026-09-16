import { BackendFailure, BindingFailure, annotateStreamFailure, streamFailureDiagnostic, projectStreamDiagnostic, FAILURE_FACT_REASONS, PROVIDER_ERROR_CODES, PROVIDER_ERROR_PARAMS, type StreamDiagnostic } from "@grokbox/runtime-kernel/contract";

export const BACKEND_PHASES = ["prepare", "auth", "sdk", "provider", "normalize", "authority"] as const;
export type BackendPhase = (typeof BACKEND_PHASES)[number];
export const FAILURE_REASONS = FAILURE_FACT_REASONS;
export const PROVIDER_CODES = PROVIDER_ERROR_CODES;
export const PROVIDER_PARAMS = PROVIDER_ERROR_PARAMS;
export type BackendObservation = StreamDiagnostic & {
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
  const diagnostic = streamFailureDiagnostic(raw);
  if (diagnostic) annotateStreamFailure(failure, diagnostic);
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
  if (failure.code === "stream_limit") result = { phase: "normalize", reason: "stream_budget" };
  observations.set(failure, Object.freeze(result));
  return failure;
}

/** A provider finish may end transport without completing the requested answer. */
export function incompleteBackendFinish(reason: "length" | "content-filter"): BackendFailure {
  const failure = new BackendFailure("provider_error");
  observations.set(failure, Object.freeze({ phase: "sdk", reason: reason === "length" ? "output_limit" : "content_filter" }));
  return failure;
}

export function projectBackendObservation(value: unknown): BackendObservation | undefined {
  try {
    const d = record(value);
    const phase = member(d?.phase, BACKEND_PHASES), reason = member(d?.reason, FAILURE_REASONS);
    if (!d || !phase || !reason) return undefined;
    const out: BackendObservation = { phase, reason, ...projectStreamDiagnostic(d) };
    if (typeof d.httpStatus === "number" && Number.isInteger(d.httpStatus) && d.httpStatus >= 400 && d.httpStatus <= 599) out.httpStatus = d.httpStatus;
    const code = member(d.providerCode, PROVIDER_CODES), param = member(d.providerParam, PROVIDER_PARAMS);
    if (code) out.providerCode = code;
    if (param) out.providerParam = param;
    return out;
  } catch { return undefined; }
}

export function interruptedProviderFinish(reason: "insufficient_system_resource" | "aborted"): BackendFailure {
  const failure = new BackendFailure("provider_error");
  observations.set(failure, Object.freeze({ phase: "provider", reason: reason === "aborted" ? "provider_interrupted" : "provider_resource" }));
  return failure;
}

export function backendFailureObservation(error: unknown): BackendObservation | undefined {
  if (error instanceof BindingFailure && error.code === "not_admitted") return { phase: "authority", reason: "authority_check", ...streamFailureDiagnostic(error) };
  if (!(error instanceof BackendFailure)) return undefined;
  const base = observations.get(error), detail = streamFailureDiagnostic(error);
  if (!base && !detail) return undefined;
  return { ...(base ?? { phase: "normalize" as const, reason: error.code === "stream_limit" ? "stream_budget" as const : "stream_shape" as const }), ...detail };
}
