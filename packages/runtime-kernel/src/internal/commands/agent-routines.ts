import { Effect } from "effect";
import { AgentRoutines } from "../../ports.ts";
import { RoutineError, validateRoutineCommand, type RoutineCommand, type RoutineOperationReceipt } from "../../routines.ts";

/** One explicit action, no retries, scheduler, secret mint, invocation or Agent
 * mutation. Preflight/readback do NOT create a native compare-and-swap. */
export function runAgentRoutines(input: RoutineCommand) {
  return Effect.gen(function* () {
    const command = yield* Effect.try({ try: () => validateRoutineCommand(input), catch: e => e instanceof RoutineError ? e : new RoutineError("invalid_input") });
    const native = yield* AgentRoutines;
    const before = yield* native.list(command.agentId);
    if (command.action === "list") return before.catalog;
    const prior = before.catalog.routines.find(r => r.id === command.routineId);
    if (!prior) return yield* Effect.fail(new RoutineError("not_found_in_window"));
    if (command.action === "show") return { ...before.catalog, routines: [prior] };
    if (!prior.mutable) return yield* Effect.fail(new RoutineError("unsupported_trigger"));
    if (prior.revision !== command.expectedRevision) return yield* Effect.fail(new RoutineError("revision_conflict"));
    const action = command.action, enabled = action === "enable";
    const receipt = (state: RoutineOperationReceipt["state"], afterRevision: string | null): RoutineOperationReceipt => ({
      schemaVersion: 1, action, agentId: command.agentId, routineId: prior.id, operationId: command.operationId!,
      state, beforeRevision: prior.revision, afterRevision, nativeCompareAndSwap: false, automaticRetry: false,
      inFlightRunsCancelled: false, webhookInvoked: false, effectProof: "preflight_and_readback_only",
    });
    if (action !== "delete" && prior.enabled === enabled) return receipt("unchanged", prior.revision);
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      const changed = yield* native.change(command.agentId, prior.id, action)
        .pipe(Effect.mapError(() => new RoutineError("outcome_unknown")));
      const after = yield* native.list(command.agentId).pipe(Effect.mapError(() => new RoutineError("outcome_unknown")));
      if (changed.generation !== before.generation || after.generation !== before.generation) return yield* Effect.fail(new RoutineError("outcome_unknown"));
      const response = changed.catalog.routines.find(r => r.id === prior.id), current = after.catalog.routines.find(r => r.id === prior.id);
      if (action === "delete") {
        if (response || current || changed.catalog.coverage.atLimit || after.catalog.coverage.atLimit) return yield* Effect.fail(new RoutineError("outcome_unknown"));
        // The native API exposes a window, not a revisioned deletion receipt.
        return receipt("absent_in_returned_window", null);
      }
      if (!response || !current || response.enabled !== enabled || current.enabled !== enabled
        || current.definitionRevision !== prior.definitionRevision || response.definitionRevision !== prior.definitionRevision
        || response.revision !== current.revision) return yield* Effect.fail(new RoutineError("outcome_unknown"));
      return receipt("requested_state_observed", current.revision);
    }));
  });
}
