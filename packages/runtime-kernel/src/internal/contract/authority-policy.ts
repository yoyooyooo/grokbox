import { OWNERSHIP_EVIDENCE_MAX_AGE_MS, OWNERSHIP_SERVER_CACHE_MS, OWNERSHIP_WAIT_MS } from "./ownership.ts";
import type { OwnershipReadObservation } from "./ownership-observation.ts";
import type { OwnershipAdmission } from "./ownership.ts";
import type { AuthorityDiagnostic, StreamDiagnostic } from "./stream-diagnostic.ts";

/** The trusted application port returns a decision, never an arbitrary object.
 * Its native/transport input remains unknown until the owning adapter validates
 * it. Kernel checks remain as defense against invalid injected capabilities. */
export type AdmissionAuthorityResult =
  | { admitted: true; ownership: OwnershipAdmission; diagnostic?: StreamDiagnostic; evidenceId?: string }
  | { admitted: false; reason: AuthorityDiagnostic["reason"]; diagnostic?: StreamDiagnostic };

/** One conservative policy. Structural consolidation does not silently enlarge
 * the observation window or turn a client snapshot into a Server lease. */
export const STRICT_AUTHORITY_POLICY = Object.freeze({
  version: 1 as const,
  id: "strict-observation-v1" as const,
  evidenceMaxAgeMs: OWNERSHIP_EVIDENCE_MAX_AGE_MS,
  cacheMs: OWNERSHIP_SERVER_CACHE_MS,
  sourceWaitMs: OWNERSHIP_WAIT_MS,
  waiterWaitMs: OWNERSHIP_WAIT_MS,
  maxEntries: 32,
  maxWaiters: 64,
  maxReadAttempts: 2,
  retryDelayMs: 100,
  // Cumulative waiting across checkpoints, not an extra STEP wall deadline.
  stepWaitMs: OWNERSHIP_WAIT_MS,
  maxStepReadRetries: 2,
  observationWaitMs: 50,
});

/** Explicit failures which invalidate an existing execution binding. A timeout
 * closes an exhausted STEP, but is not evidence that ownership was revoked. */
export function authorityRefusalIsRevocation(reason: string): boolean {
  return ["confirmed_temporal", "harness_mismatch", "server_id_mismatch", "ownership_identity_changed",
    "host_identity_mismatch", "host_generation_changed", "ownership_gateway_mismatch",
    "native_execution_not_ready", "ownership_scope_unconfirmed", "turn_revoked"].includes(reason);
}

/** Retry describes a read-only, pre-terminal operation. It never authorizes a
 * new STEP, a provider attempt, an expired binding or an old service epoch. */
export function authorityReadCanRecover(reason: string, read?: OwnershipReadObservation): boolean {
  if (read?.errorCode && ["authorization_unavailable", "unsupported_rpc", "invalid_request", "invalid_response",
    "scope_unavailable", "scope_changed", "clock_unavailable"].includes(read.errorCode)) return false;
  return ["ownership_evidence_stale", "ownership_read_timeout", "ownership_read_unavailable",
    "server_read_unavailable"].includes(reason);
}
