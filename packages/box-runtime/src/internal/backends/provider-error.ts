import { BackendFailure, classifyProviderFailure } from "@grokbox/runtime-kernel/contract";

const OVERFLOW = /context_length|context_window|prompt_too_long|request_too_large/i;
const AUTH = /unauthorized|invalid_api_key|authentication|401/i;

/** Map provider failures to the fixed whitelist. Never returns raw body/Cause. */
export function backendFailureFromUnknown(error: unknown): BackendFailure {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const auth = AUTH.test(text);
  const overflow = OVERFLOW.test(text);
  if (error instanceof BackendFailure) {
    if (error.code === "overflow_candidate" && auth) return classifyProviderFailure({ auth: true, overflow: true });
    return error;
  }
  return classifyProviderFailure({ auth, overflow });
}
