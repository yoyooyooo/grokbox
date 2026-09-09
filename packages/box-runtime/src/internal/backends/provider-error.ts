import { BackendFailure, classifyProviderFailure } from "@grokbox/runtime-kernel/contract";
import { observeBackendFailure, type BackendPhase } from "./failure-observation.ts";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;

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
