import { BackendFailure, BindingFailure, WireError, BACKEND_FAILURE_CODES, BINDING_FAILURE_CODES, failureSummaryFromObservation, failureSummaryOf, providerRecoveryOf, type AuthorityProgress, type ProviderRecoveryState, type FailureSummary, type StreamSummary, type ExecutionCapacity } from "@grokbox/runtime-kernel/contract";
import { backendFailureObservation, type BackendObservation } from "../backends/failure-observation.ts";

export const STEP_OUTCOMES = ["ok", "error", "duplicate", "cancelled", "unknown"] as const;
export const STEP_PHASES = ["admission", "prepare", "auth", "sdk", "provider", "normalize", "authority", "transport", "internal", "complete"] as const;
export const STEP_FAILURE_CODES = [...BACKEND_FAILURE_CODES, ...BINDING_FAILURE_CODES,
  "timeout", "extra_keys", "malformed_frame", "disconnected", "defect", "interrupted", "unknown"] as const;
export type ModeldStepOutcome = {
  outcome: (typeof STEP_OUTCOMES)[number];
  phase: (typeof STEP_PHASES)[number];
  failureCode?: (typeof STEP_FAILURE_CODES)[number];
  eventCount: number;
  bindingId?: string;
  diagnostic?: BackendObservation;
  failureSummary?: FailureSummary;
  recovery?: ProviderRecoveryState;
  authority?: AuthorityProgress;
  authorityObservationGaps?: number;
  stream?: StreamSummary;
  execution?: ExecutionCapacity;
  at?: string;
  durationMs?: number;
  backendAttempts?: number;
  cleanup?: { clientDisconnected?: boolean; cancellationRequested?: boolean; exitFailure?: "defect" | "interrupted" | "unknown" };
  attempts?: Array<{ index: number; failureCode?: ModeldStepOutcome["failureCode"]; diagnostic?: BackendObservation; stream?: StreamSummary }>;
  startedAt?: string;
  detectedAt?: string;
  transport?: { side: "host_modeld_ipc"; close: "peer_end" | "peer_close" | "socket_error"; at: string };
  followup?: { phase: "transport" | "internal"; code: "disconnected" | "defect" | "interrupted" | "unknown" };
};

/** Keep a concrete detecting failure even if the client disconnects during its
 * propagation. Local transport cleanup is a separate fact, not a causal guess. */
export function withTransportOutcome(previous: ModeldStepOutcome, failure: ModeldStepOutcome | undefined, disconnected: boolean): ModeldStepOutcome {
  const specific = failure && failure.failureCode !== "cancelled" && failure.failureCode !== "unknown";
  const primary = specific ? failure : previous;
  const resolved: ModeldStepOutcome = disconnected && !specific && primary.phase !== "complete" && primary.outcome !== "error"
    ? { ...primary, outcome: "cancelled", phase: "transport", failureCode: "disconnected" }
    : failure && !disconnected ? failure : primary;
  return { ...resolved, bindingId: previous.bindingId ?? resolved.bindingId,
    cleanup: { ...previous.cleanup, clientDisconnected: disconnected, cancellationRequested: disconnected || failure !== undefined } };
}

export function modeldFailureOutcome(error: unknown, phase: "admission" | "provider", eventCount: number): ModeldStepOutcome {
  const diagnostic = backendFailureObservation(error);
  const known = error instanceof BackendFailure || error instanceof BindingFailure || error instanceof WireError;
  const code = known && (STEP_FAILURE_CODES as readonly string[]).includes(error.code) ? error.code as ModeldStepOutcome["failureCode"]
    : error && typeof error === "object" && "_tag" in error && error._tag === "TimeoutError" ? "timeout" : "unknown";
  const auth = code === "auth_mismatch" || code === "credential_invalid";
  const outcome: ModeldStepOutcome = {
    outcome: code === "cancelled" ? "cancelled" : "error",
    phase: code === "not_admitted" && phase === "admission" ? "admission" : diagnostic?.phase ?? (auth ? "auth" : code === "stream_invalid" ? "normalize" : phase),
    failureCode: code,
    eventCount,
    ...(diagnostic ? { diagnostic } : {}),
  };
  const summary = failureSummaryOf(error) ?? failureSummaryFromObservation(outcome);
  const recovery = providerRecoveryOf(error);
  return { ...outcome, ...(summary ? { phase: phase === "admission" ? outcome.phase : summary.phase, failureSummary: summary } : {}), ...(recovery ? { recovery } : {}) };
}
