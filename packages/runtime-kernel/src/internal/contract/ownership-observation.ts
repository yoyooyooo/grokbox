/** Finite observations of the native ownership reader. These fields explain a
 * read; they are never ownership evidence, an execution lease, or retry policy. */
export const OWNERSHIP_READ_SOURCE = "Host.official-client/ListGrokBotAgents" as const;
export const OWNERSHIP_READ_ERRORS = ["timeout", "authorization_unavailable", "unsupported_rpc", "server_read_failed", "invalid_response", "busy", "invalid_request", "scope_unavailable", "scope_changed", "source_cancelled", "clock_unavailable"] as const;
export const OWNERSHIP_READ_PHASES = ["input", "scope_before", "server", "scope_after", "complete"] as const;
export type OwnershipReadObservation = {
  version: 1;
  source: typeof OWNERSHIP_READ_SOURCE;
  state: "observed" | "unavailable";
  errorCode?: typeof OWNERSHIP_READ_ERRORS[number];
  phase?: typeof OWNERSHIP_READ_PHASES[number];
  serverRead?: "not_started" | "request" | "shared" | "cache";
  durationMs?: number;
  deadlineMs?: number;
  serverWaitMs?: number;
  serverEvidenceAgeMs?: number;
  rpcCode?: number;
  sourceReadId?: string;
  cancellationOrigin?: "waiter_deadline" | "source_deadline" | "no_waiters" | "transport_unknown";
};
export type OwnershipWaitObservation = {
  version: 1;
  policyId: "strict-observation-v1";
  waiterId: string;
  sourceOperationId?: string;
  state: "local_witness" | "queued" | "shared" | "source" | "cached" | "validating";
  outcome: "observed" | "source_deadline" | "waiter_deadline" | "source_failure" | "local_refusal" | "resource_limit";
  durationMs: number;
  waitBudgetMs: number;
  sourceBudgetMs?: number;
  sourceAgeMs?: number;
  sourceSettlement?: "pending" | "settled";
  queueMs?: number;
  sourceWaitMs?: number;
  localWitnessMs?: number;
};

export function projectOwnershipWaitObservation(value: unknown): OwnershipWaitObservation | undefined {
  try {
    const id = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
    const waiterId = own(value, "waiterId"), sourceOperationId = own(value, "sourceOperationId");
    const state = member(own(value, "state"), ["local_witness", "queued", "shared", "source", "cached", "validating"]);
    const outcome = member(own(value, "outcome"), ["observed", "source_deadline", "waiter_deadline", "source_failure", "local_refusal", "resource_limit"]);
    const durationMs = own(value, "durationMs"), waitBudgetMs = own(value, "waitBudgetMs");
    if (own(value, "version") !== 1 || own(value, "policyId") !== "strict-observation-v1"
      || !id(waiterId) || !state || !outcome || !millis(durationMs) || !millis(waitBudgetMs)) return undefined;
    const result: OwnershipWaitObservation = { version: 1, policyId: "strict-observation-v1", waiterId, state, outcome, durationMs, waitBudgetMs };
    if (id(sourceOperationId)) result.sourceOperationId = sourceOperationId;
    for (const key of ["sourceBudgetMs", "sourceAgeMs", "queueMs", "sourceWaitMs", "localWitnessMs"] as const) {
      const n = own(value, key); if (millis(n)) result[key] = n;
    }
    const settlement = member(own(value, "sourceSettlement"), ["pending", "settled"]);
    if (settlement) result.sourceSettlement = settlement;
    return result;
  } catch { return undefined; }
}

export type OwnershipRecoveryObservation = {
  version: 1; attempts: number; backoffMs: number;
  firstReadCode?: typeof OWNERSHIP_READ_ERRORS[number];
  firstReadReason?: "ownership_evidence_stale" | "ownership_read_timeout" | "ownership_read_unavailable" | "server_read_unavailable";
  firstReadDurationMs?: number;
  lastReadCode?: typeof OWNERSHIP_READ_ERRORS[number];
};
export function projectOwnershipRecoveryObservation(value: unknown): OwnershipRecoveryObservation | undefined {
  try {
    const attempts = own(value, "attempts"), backoffMs = own(value, "backoffMs");
    if (own(value, "version") !== 1 || !Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > 2 || !millis(backoffMs)) return undefined;
    const result: OwnershipRecoveryObservation = { version: 1, attempts: attempts as number, backoffMs };
    const reason = member(own(value, "firstReadReason"), ["ownership_evidence_stale", "ownership_read_timeout", "ownership_read_unavailable", "server_read_unavailable"] as const);
    if (reason) result.firstReadReason = reason;
    const duration = own(value, "firstReadDurationMs");
    if (millis(duration)) result.firstReadDurationMs = duration;
    for (const key of ["firstReadCode", "lastReadCode"] as const) {
      const code = member(own(value, key), OWNERSHIP_READ_ERRORS); if (code) result[key] = code;
    }
    return result;
  } catch { return undefined; }
}

const own = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const member = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
const millis = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_073_741_824;

/** Do not invoke accessors or copy messages, Causes, endpoints, scope identities,
 * response bodies, credentials, or arbitrary transport codes. */
export function projectOwnershipReadObservation(value: unknown): OwnershipReadObservation | undefined {
  try {
    if (own(value, "version") !== 1 || own(value, "source") !== OWNERSHIP_READ_SOURCE) return undefined;
    const state = member(own(value, "state"), ["observed", "unavailable"]);
    if (!state) return undefined;
    const out: OwnershipReadObservation = { version: 1, source: OWNERSHIP_READ_SOURCE, state };
    const errorCode = member(own(value, "errorCode"), OWNERSHIP_READ_ERRORS);
    if (state === "unavailable" && errorCode) out.errorCode = errorCode;
    const phase = member(own(value, "phase"), OWNERSHIP_READ_PHASES);
    if (phase) out.phase = phase;
    const serverRead = member(own(value, "serverRead"), ["not_started", "request", "shared", "cache"]);
    if (serverRead) out.serverRead = serverRead;
    for (const key of ["durationMs", "deadlineMs", "serverWaitMs", "serverEvidenceAgeMs"] as const) {
      const n = own(value, key); if (millis(n)) out[key] = n;
    }
    const sourceReadId = own(value, "sourceReadId");
    if (typeof sourceReadId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sourceReadId)) out.sourceReadId = sourceReadId;
    const cancellationOrigin = member(own(value, "cancellationOrigin"), ["waiter_deadline", "source_deadline", "no_waiters", "transport_unknown"]);
    if (state === "unavailable" && cancellationOrigin) out.cancellationOrigin = cancellationOrigin;
    const rpcCode = own(value, "rpcCode");
    if (state === "unavailable" && typeof rpcCode === "number" && Number.isInteger(rpcCode) && rpcCode >= 1 && rpcCode <= 16) out.rpcCode = rpcCode;
    return out;
  } catch { return undefined; }
}

/** Old Host snapshots already carried a finite subcode and timestamps. Preserve
 * those, but never invent a phase, deadline, RPC code or error for old journals. */
export function ownershipReadObservationFromSnapshot(value: unknown): OwnershipReadObservation | undefined {
  try {
    const recorded = projectOwnershipReadObservation(own(value, "readObservation"));
    if (own(value, "source") !== OWNERSHIP_READ_SOURCE) return recorded;
    const state = member(own(value, "state"), ["observed", "unavailable"]);
    if (!state) return recorded;
    const iso = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v);
    const start = own(value, "observedAt"), end = own(value, "completedAt");
    const durationMs = iso(start) && iso(end) ? Date.parse(end) - Date.parse(start) : undefined;
    const errorCode = member(own(value, "errorCode"), OWNERSHIP_READ_ERRORS);
    const consistent = recorded?.state === state && recorded.errorCode === errorCode ? recorded : undefined;
    // Outer snapshot state/code is the native read result. Optional observation
    // details cannot contradict it or manufacture a successful read.
    return projectOwnershipReadObservation({ ...consistent, version: 1, source: OWNERSHIP_READ_SOURCE,
      state, errorCode, durationMs: consistent?.durationMs ?? durationMs });
  } catch { return undefined; }
}
