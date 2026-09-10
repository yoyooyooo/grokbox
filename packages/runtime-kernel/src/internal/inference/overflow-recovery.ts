import { Context, Effect, Option } from "effect";
import { HostCompact } from "../../ports.ts";
import {
  CompactFailure,
  isConfirmedOverflow,
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
  if (input.evidence.releasedText > 0 || input.evidence.releasedReasoning > 0 || input.evidence.releasedTools > 0) {
    return "released";
  }
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
    const blocked = admitOverflowRecovery(input);
    if (blocked) return yield* Effect.fail(new CompactFailure(blocked));
    const ctx = yield* Effect.context<never>();
    const compact = Context.getOption(ctx as Context.Context<HostCompact>, HostCompact);
    if (Option.isNone(compact)) return yield* Effect.fail(new CompactFailure("capability_not_ready"));
    const request: HostCompactRequest = { tuple: input.identity, recoveryNonce: input.recoveryNonce };
    const result = yield* compact.value.request(request);
    const ledger: RecoveryLedger = {
      ...input.ledger,
      compactInvocations: input.ledger.compactInvocations + 1,
      nonceConsumed: true,
    };
    if (result.kind === "unavailable") {
      return yield* Effect.fail(new CompactFailure(result.reason === "capability_not_ready" ? "capability_not_ready" : result.reason === "cancelled" ? "cancelled" : result.reason === "blocked" ? "blocked" : "unknown"));
    }
    if (result.kind === "no_improvement") return yield* Effect.fail(new CompactFailure("no_improvement"));
    return { ledger: { ...ledger, managedAttempts: ledger.managedAttempts + 1 }, snapshot: result.snapshot };
  });
}
