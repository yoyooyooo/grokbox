import { Effect } from "effect";
import { RoutineProvisionLedger, NativeRoutineProvision } from "../../ports.ts";
import { RoutineProvisionError, validateProvisionCommand, provisionFingerprint, desiredRoutineDigest, planProvision,
  verifyProvisionObservation, provisionReceipt } from "./routine-provision-contract.ts";

const checked = <A>(run: () => A) => Effect.try({ try: run, catch: e => e instanceof RoutineProvisionError ? e : new RoutineProvisionError("invalid_input") });
/** Persist the dispatch guard before an external write. Uncertainty never issues
 * a second native mutation; explicitly reconciling an exact ID performs reads
 * only. Local guard does not become a native nonce/CAS or active-task proof. */
export function runRoutineProvision(input: unknown, atMs: number) {
  return Effect.gen(function* () {
    const command = yield* checked(() => validateProvisionCommand(input));
    const ledger = yield* RoutineProvisionLedger;
    const previous = yield* ledger.read(command.agentId, command.operationId);
    if (command.action === "outcome") return provisionReceipt(previous, command.agentId, command.operationId);
    if (previous?.state === "retired") {
      if (command.action === "apply" && previous.fingerprint !== provisionFingerprint(command)) return yield* Effect.fail(new RoutineProvisionError("operation_conflict"));
      return provisionReceipt(previous, command.agentId, command.operationId);
    }
    const native = yield* NativeRoutineProvision;
    if (command.action === "reconcile") {
      if (!previous) return yield* Effect.fail(new RoutineProvisionError("not_recorded"));
      if (previous.nativeId && previous.nativeId !== command.routineId) return yield* Effect.fail(new RoutineProvisionError("operation_conflict"));
      if (previous.state === "observed") return provisionReceipt(previous, command.agentId, command.operationId);
      return yield* Effect.uninterruptible(Effect.gen(function* () {
        const record = yield* ledger.reconcileRecord(command.agentId, command.operationId);
        if (record.nativeId && record.nativeId !== command.routineId) return yield* Effect.fail(new RoutineProvisionError("operation_conflict"));
        const observed = yield* native.list(command.agentId);
        const item = yield* checked(() => verifyProvisionObservation(record, observed, command.routineId));
        const settled = yield* ledger.finish(record, item.id, item.revision);
        return provisionReceipt(settled, command.agentId, command.operationId);
      }));
    }
    const fingerprint = provisionFingerprint(command);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return yield* Effect.fail(new RoutineProvisionError("operation_conflict"));
      return provisionReceipt(previous, command.agentId, command.operationId);
    }
    const binding = yield* ledger.binding(command.agentId, command.blueprint.key);
    const before = yield* native.list(command.agentId);
    const plan = yield* checked(() => planProvision(command, binding, before));
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const reservation = yield* ledger.reserve({ agentId: command.agentId, operationId: command.operationId, key: command.blueprint.key,
        fingerprint, desiredDigest: desiredRoutineDigest(command.blueprint), action: plan.action, binding, atMs });
      if (!reservation.dispatch) return provisionReceipt(reservation.record, command.agentId, command.operationId);
      const record = reservation.record;
      const changed = yield* Effect.result(Effect.gen(function* () {
        const response = yield* native.write(command.agentId, command.blueprint, plan.nativeId);
        if (response.generation !== before.generation || response.catalog.coverage.atLimit) return yield* Effect.fail(new RoutineProvisionError("outcome_unknown"));
        let nativeId = plan.nativeId;
        if (nativeId === null) {
          const oldIds = new Set(before.catalog.routines.map(r => r.id));
          const candidates = response.catalog.routines.filter(r => !oldIds.has(r.id) && response.definitions.get(r.id) === record.desiredDigest && !r.enabled);
          if (candidates.length !== 1) return yield* Effect.fail(new RoutineProvisionError("outcome_unknown"));
          nativeId = candidates[0]!.id;
        }
        const first = yield* checked(() => verifyProvisionObservation(record, response, nativeId));
        const again = yield* native.list(command.agentId);
        const last = yield* checked(() => verifyProvisionObservation(record, again, nativeId));
        if (again.generation !== before.generation || first.revision !== last.revision) return yield* Effect.fail(new RoutineProvisionError("outcome_unknown"));
        return yield* ledger.finish(record, nativeId, last.revision);
      }));
      if (changed._tag === "Success") return provisionReceipt(changed.success, command.agentId, command.operationId);
      yield* ledger.markUnknown(command.agentId, command.operationId).pipe(Effect.catch(() => Effect.void));
      // A local commit may itself have succeeded before its acknowledgement was
      // lost. Never claim it failed, and never re-enter the native write here.
      return provisionReceipt({ ...record, state: "unknown" }, command.agentId, command.operationId);
    }));
  });
}
