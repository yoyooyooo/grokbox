import { Effect } from "effect";
import { OpsTargetPairing } from "../../ports.ts";
import { OpsPairingError, pairingReceipt, validatePairingCommand, validatePairingCredential, type PairingCommand } from "../../observation.ts";

/** Only the explicit bind action may acquire a key. A persisted enrolling record
 * consumes that dispatch even if its acknowledgement is lost or a process dies.
 * No step in this program can enable, invoke or claim a qualified receiver. */
export function runOpsTargetPairing(input: PairingCommand, expectedBindingRevision = 0) {
  const checked = <A>(fn: () => A) => Effect.try({ try: fn, catch: e => e instanceof OpsPairingError ? e : new OpsPairingError("invalid_input") });
  return Effect.gen(function* () {
    const command = yield* checked(() => validatePairingCommand(input));
    if (!Number.isSafeInteger(expectedBindingRevision) || expectedBindingRevision < 0) return yield* Effect.fail(new OpsPairingError("invalid_input"));
    const api = yield* OpsTargetPairing, prior = yield* api.prior(command.alias);
    if (command.action === "bind" && prior?.plan.operationId === command.operationId) {
      if (prior.plan.routineId !== command.routineId || prior.plan.routineRevision !== command.expectedRevision) return yield* Effect.fail(new OpsPairingError("operation_conflict"));
      return pairingReceipt(prior);
    }
    const plan = yield* api.plan(command);
    if (command.action === "preview") return { schemaVersion: 1, state: "preview", alias: plan.target.alias, agentId: plan.target.agentId,
      routineId: plan.routineId, routineRevision: plan.routineRevision, existingBindingRevision: prior?.revision ?? 0,
      operationId: plan.operationId, credentialRequestMayMint: true, credentialRequested: false, written: false,
      receiverQualification: "not_verified", deliveryAuthorized: false, automaticEnable: false, webhookInvoked: false };
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const reservation = yield* api.reserve(plan, expectedBindingRevision);
      if (!reservation.dispatch) return pairingReceipt(reservation.record);
      // Native IO is outside the durable reservation and config lease. The
      // sensitive response is passed only to the private owner, never returned.
      const raw = yield* api.credential(plan).pipe(Effect.mapError(() => new OpsPairingError("outcome_unknown")));
      const secret = yield* checked(() => validatePairingCredential(raw, plan)).pipe(Effect.mapError(() => new OpsPairingError("outcome_unknown")));
      yield* api.recheck(plan).pipe(Effect.mapError(() => new OpsPairingError("outcome_unknown")));
      const stored = yield* api.finish(reservation.record, secret).pipe(Effect.mapError(() => new OpsPairingError("outcome_unknown")));
      return pairingReceipt(stored);
    }));
  });
}
