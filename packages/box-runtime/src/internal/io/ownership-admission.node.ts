import { Clock, Effect } from "effect";
import {
  BoxRuntimeError,
  decideManagedOwnership,
  remoteOwnershipEvidence,
  OWNERSHIP_WAIT_MS,
  OWNERSHIP_EVIDENCE_MAX_AGE_MS,
  AUTHORITY_REASONS,
  annotateStreamFailure,
  type AuthorityDiagnostic,
  type OwnershipReadObservation,
  type BoxRuntimeErrorCode,
  type OwnershipRefusalClass,
} from "@grokbox/runtime-kernel/contract";

/** Borrowed narrow Gateway capability. The CLI root supplies the existing client;
 * no CLI import, native credential export or evidence trusted from run-step JSON. */
export type OwnershipReadReply = {
  snapshot: unknown;
  gateway: { pid: number; startedAt: number };
};
export type OwnershipReader = ((agentIds: string[], signal: AbortSignal) => Promise<OwnershipReadReply>) & {
  /** Optional native capability, never a substitute for the Server source.
   * Without it the reader can still inspect/admit a fresh full snapshot, but
   * the coordinator must not cache its local execution facts. */
  local?: (agentIds: string[], signal: AbortSignal) => Promise<OwnershipReadReply>;
};

const HOST_UNAVAILABLE_NEXT = "grokbox doctor then grokbox host start";

export function presentOwnershipRefusal(input: {
  reason: string;
  class: OwnershipRefusalClass;
  agentId?: string;
}): { code: BoxRuntimeErrorCode; message: string; next: string; failureCode: string } {
  const ownershipNext = input.agentId
    ? `grokbox agents ownership ${input.agentId}`
    : "grokbox agents ownership <agent>";
  if (input.class === "temporal") {
    return {
      code: "runtime_ownership_temporal",
      message: "This Bot is temporal (Cursor Server Agent Loop). Custom models only work on confirmed_box Bots created with grokbox, not App New Bot.",
      next: "grokbox agents create --harness box",
      failureCode: input.reason,
    };
  }
  if (input.class === "conflict") {
    return {
      code: "runtime_ownership_conflict",
      message: "Server and local identity disagree for this Bot. Do not assign a custom model until ownership is conflict-free.",
      next: ownershipNext,
      failureCode: input.reason,
    };
  }
  if (input.class === "unconfirmed") {
    return {
      code: "runtime_ownership_unconfirmed",
      message: "Ownership is unconfirmed for this Bot. Retry a live ownership read; do not guess box.",
      next: ownershipNext,
      failureCode: input.reason,
    };
  }
  return {
    code: "runtime_ownership_unavailable",
    message: "Could not read Bot ownership from Host/Gateway. Custom models need a live Host channel.",
    next: HOST_UNAVAILABLE_NEXT,
    failureCode: input.reason,
  };
}

export function ownershipUseError(reason: string, cls: OwnershipRefusalClass, agentId?: string, ownershipRead?: OwnershipReadObservation) {
  const presented = presentOwnershipRefusal({ reason, class: cls, agentId });
  const safeReason = (AUTHORITY_REASONS as readonly string[]).includes(reason) ? reason as AuthorityDiagnostic["reason"] : "unknown";
  return annotateStreamFailure(new BoxRuntimeError(presented.code, presented.message, {
    userVisible: true,
    next: presented.next,
    failureCode: presented.failureCode,
  }), { rejectSite: "authority_check", authority: { reason: safeReason, waitBudgetMs: OWNERSHIP_WAIT_MS, ...(ownershipRead ? { ownershipRead } : {}) } });
}

const denied = ownershipUseError;

export function readManagedOwnership(input: { agentId: string; read?: OwnershipReader; gatewayPid?: number }) {
  return Effect.gen(function* () {
    if (!input.read) {
      return yield* Effect.fail(denied("ownership_reader_unavailable", "unavailable", input.agentId));
    }
    const startedTick = yield* Clock.monotonicTimeNanos;
    const result = yield* Effect.tryPromise({
      try: signal => input.read!([input.agentId], signal),
      catch: () => denied("ownership_read_unavailable", "unavailable", input.agentId),
    }).pipe(
      Effect.timeout(`${OWNERSHIP_WAIT_MS} millis`),
      Effect.mapError(error => error instanceof BoxRuntimeError ? error : denied(error && typeof error === "object" && "_tag" in error && error._tag === "TimeoutError" ? "ownership_read_timeout" : "ownership_read_unavailable", "unavailable", input.agentId)),
    );
    if (!Number.isSafeInteger(result.gateway.pid) || result.gateway.pid < 1 || !Number.isSafeInteger(result.gateway.startedAt)
      || result.gateway.startedAt < 1 || (input.gatewayPid !== undefined && input.gatewayPid !== result.gateway.pid)) {
      return yield* Effect.fail(denied("ownership_gateway_mismatch", "unavailable", input.agentId));
    }
    const completedTick = yield* Clock.monotonicTimeNanos;
    if (completedTick < startedTick) return yield* Effect.fail(denied("ownership_clock_unavailable", "unavailable", input.agentId));
    // The coordinator and direct managed-selection path share this same
    // conservative elapsed bound. A wall-clock correction cannot make a slow
    // response fresh; diagnostics themselves are never used as permission.
    const readAgeMs = Math.ceil(Number(completedTick - startedTick) / 1_000_000);
    if (!Number.isSafeInteger(readAgeMs)) return yield* Effect.fail(denied("ownership_clock_unavailable", "unavailable", input.agentId));
    const remote = remoteOwnershipEvidence(input.agentId, result.snapshot);
    const decision = decideManagedOwnership({ agentId: input.agentId, snapshot: result.snapshot, nowMs: yield* Clock.currentTimeMillis });
    if (!decision.ok) return yield* Effect.fail(denied(decision.reason, decision.class, input.agentId, decision.ownershipRead));
    // Explicit conflict/revocation above wins over elapsed-time classification.
    if (readAgeMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
      return yield* Effect.fail(denied("ownership_evidence_stale", "unconfirmed", input.agentId, remote.readObservation));
    }
    return { evidence: decision.evidence, gateway: result.gateway,
      remote };
  });
}
