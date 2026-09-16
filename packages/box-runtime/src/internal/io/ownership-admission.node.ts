import { Clock, Effect } from "effect";
import {
  BoxRuntimeError,
  decideManagedOwnership,
  OWNERSHIP_WAIT_MS,
  type BoxRuntimeErrorCode,
  type OwnershipRefusalClass,
} from "@grokbox/runtime-kernel/contract";

/** Borrowed narrow Gateway capability. The CLI root supplies the existing client;
 * no CLI import, native credential export or evidence trusted from run-step JSON. */
export type OwnershipReader = (agentIds: string[], signal: AbortSignal) => Promise<{
  snapshot: unknown;
  gateway: { pid: number; startedAt: number };
}>;

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

export function ownershipUseError(reason: string, cls: OwnershipRefusalClass, agentId?: string) {
  const presented = presentOwnershipRefusal({ reason, class: cls, agentId });
  return new BoxRuntimeError(presented.code, presented.message, {
    userVisible: true,
    next: presented.next,
    failureCode: presented.failureCode,
  });
}

const denied = (reason: string, cls: OwnershipRefusalClass, agentId?: string) =>
  ownershipUseError(reason, cls, agentId);

export function readManagedOwnership(input: { agentId: string; read?: OwnershipReader; gatewayPid?: number }) {
  return Effect.gen(function* () {
    if (!input.read) {
      return yield* Effect.fail(denied("ownership_reader_unavailable", "unavailable", input.agentId));
    }
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
    const decision = decideManagedOwnership({ agentId: input.agentId, snapshot: result.snapshot, nowMs: yield* Clock.currentTimeMillis });
    if (!decision.ok) return yield* Effect.fail(denied(decision.reason, decision.class, input.agentId));
    return { evidence: decision.evidence, gateway: result.gateway };
  });
}
