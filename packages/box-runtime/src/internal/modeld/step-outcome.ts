import { BackendFailure, BindingFailure, WireError, BACKEND_FAILURE_CODES, BINDING_FAILURE_CODES } from "@grokbox/runtime-kernel/contract";
import { backendFailureObservation, type BackendObservation } from "../backends/failure-observation.ts";

export const STEP_OUTCOMES = ["ok", "error", "duplicate", "cancelled", "unknown"] as const;
export const STEP_PHASES = ["admission", "prepare", "auth", "sdk", "provider", "normalize", "transport", "internal", "complete"] as const;
export const STEP_FAILURE_CODES = [...BACKEND_FAILURE_CODES, ...BINDING_FAILURE_CODES,
  "timeout", "extra_keys", "malformed_frame", "disconnected", "defect", "interrupted", "unknown"] as const;
export type ModeldStepOutcome = {
  outcome: (typeof STEP_OUTCOMES)[number];
  phase: (typeof STEP_PHASES)[number];
  failureCode?: (typeof STEP_FAILURE_CODES)[number];
  eventCount: number;
  bindingId?: string;
  diagnostic?: BackendObservation;
};

export function modeldFailureOutcome(error: unknown, phase: "admission" | "provider", eventCount: number): ModeldStepOutcome {
  const diagnostic = backendFailureObservation(error);
  const known = error instanceof BackendFailure || error instanceof BindingFailure || error instanceof WireError;
  const code = known && (STEP_FAILURE_CODES as readonly string[]).includes(error.code) ? error.code as ModeldStepOutcome["failureCode"]
    : error && typeof error === "object" && "_tag" in error && error._tag === "TimeoutError" ? "timeout" : "unknown";
  const auth = code === "auth_mismatch" || code === "credential_invalid";
  return {
    outcome: code === "cancelled" ? "cancelled" : "error",
    phase: diagnostic?.phase ?? (auth ? "auth" : code === "stream_invalid" ? "normalize" : phase),
    failureCode: code,
    eventCount,
    ...(diagnostic ? { diagnostic } : {}),
  };
}
