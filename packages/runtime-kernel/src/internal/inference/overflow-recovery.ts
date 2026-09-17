import { Context, Effect, Option } from "effect";
import { HostCompact } from "../../ports.ts";
import {
  CompactFailure,
  isConfirmedOverflow,
  isKnownZeroRelease,
  type CompactFailureCode,
  type HostCompactRequest,
  type OverflowEvidence,
  type RecoveryLedger,
  type RecoveryTuple,
} from "../contract/overflow.ts";
import type { ContextSnapshot } from "../contract/snapshot.ts";

function sameTuple(left: RecoveryTuple, right: RecoveryTuple): boolean {
  return left.agentId === right.agentId
    && left.turnId === right.turnId
    && left.stepId === right.stepId
    && left.bindingId === right.bindingId
    && left.selectionRevision === right.selectionRevision;
}

export function admitOverflowRecovery(input: {
  ledger: RecoveryLedger;
  evidence: OverflowEvidence;
  identity: RecoveryTuple;
  recoveryNonce: string;
}): CompactFailureCode | undefined {
  if (!isConfirmedOverflow(input.evidence)) return "unconfirmed";
  const released = [input.evidence.releasedText, input.evidence.releasedReasoning, input.evidence.releasedTools];
  if (released.some((count) => typeof count === "number" && Number.isFinite(count) && count > 0)) return "released";
  if (!released.every((count) => isKnownZeroRelease(count))) return "unconfirmed";
  if (!sameTuple(input.ledger.tuple, input.identity)) return "identity";
  if (input.recoveryNonce !== input.ledger.recoveryNonce || input.ledger.nonceConsumed) return "nonce";
  if (input.ledger.compactInvocations >= 1 || input.ledger.managedAttempts >= 2) return "exhausted";
  return undefined;
}

export function runOverflowRecovery(input: {
  ledger: RecoveryLedger;
  evidence: OverflowEvidence;
  identity: RecoveryTuple;
  recoveryNonce: string;
}): Effect.Effect<{ ledger: RecoveryLedger; snapshot: ContextSnapshot }, CompactFailure> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context<never>();
    const compact = Context.getOption(ctx as Context.Context<HostCompact>, HostCompact);
    if (Option.isNone(compact)) return yield* Effect.fail(new CompactFailure("capability_not_ready"));
    const blocked = admitOverflowRecovery(input);
    if (blocked) return yield* Effect.fail(new CompactFailure(blocked));
    input.ledger.evidence = structuredClone(input.evidence);
    input.ledger.nonceConsumed = true;
    input.ledger.compactInvocations += 1;
    const request: HostCompactRequest = { tuple: input.identity, recoveryNonce: input.recoveryNonce };
    const result = yield* compact.value.request(request);
    if (result.kind === "unavailable") {
      return yield* Effect.fail(new CompactFailure(result.reason === "capability_not_ready" ? "capability_not_ready" : result.reason === "cancelled" ? "cancelled" : result.reason === "blocked" ? "blocked" : "unknown"));
    }
    if (result.kind === "no_improvement") return yield* Effect.fail(new CompactFailure("no_improvement"));
    input.ledger.managedAttempts += 1;
    return { ledger: input.ledger, snapshot: result.snapshot };
  });
}
