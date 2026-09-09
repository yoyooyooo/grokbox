import { Effect } from "effect";
import {
  ControlResources,
  type ControllerReceipt,
  type ControllerRequest,
} from "../../ports.ts";

function receipt(
  request: ControllerRequest,
  outcome: ControllerReceipt["outcome"],
  extras: Partial<ControllerReceipt> = {},
): ControllerReceipt {
  return {
    outcome,
    reason: extras.reason ?? null,
    signaled: extras.signaled === true,
    spawned: extras.spawned === true,
    guardian: extras.guardian === true,
    operationId: request.operationId,
  };
}

/** Unique controller program. Preview/reconcile never mutate; apply requires confirm + fresh recheck. */
export function runControllerOperation(request: ControllerRequest) {
  return Effect.gen(function* () {
    const control = yield* ControlResources;
    if (request.intent === "apply" && request.confirmed !== true) {
      return receipt(request, "refused", { reason: "no-confirm" });
    }
    if (request.intent === "preview" || request.intent === "reconcile") {
      const pre = yield* control.preflight(request);
      if (!pre.ok) {
        return receipt(request, "recovery-required", { reason: pre.reason });
      }
      return receipt(request, request.intent === "reconcile" ? "converged" : "preview", { reason: pre.reason });
    }
    return yield* Effect.scoped(Effect.gen(function* () {
      const held = yield* control.lease({ operationId: request.operationId });
      if (held.duplicate) {
        return receipt(request, "converged", { reason: "duplicate-operation" });
      }
      const pre = yield* control.preflight(request);
      if (!pre.ok) {
        return receipt(request, "refused", { reason: pre.reason ?? "preflight" });
      }
      const again = yield* control.recheck(request);
      if (!again.ok) {
        return receipt(request, "refused", { reason: again.reason ?? "recheck" });
      }
      let signaled = false;
      let spawned = false;
      let guardian = false;
      if (pre.strategy === "transient") {
        const spawnedResult = yield* Effect.result(control.spawn(request));
        if (spawnedResult._tag === "Failure") {
          return receipt(request, "partial", { reason: "spawn-failed", spawned, guardian, signaled });
        }
        spawned = spawnedResult.success.spawned;
        const armed = yield* Effect.result(control.armGuardian(request));
        if (armed._tag === "Failure") {
          return receipt(request, "partial", { reason: "guardian-failed", spawned, guardian, signaled });
        }
        guardian = armed.success.guardian;
      } else {
        const signaledResult = yield* Effect.result(control.signal(request));
        if (signaledResult._tag === "Failure") {
          return receipt(request, "partial", { reason: "signal-failed", spawned, guardian, signaled });
        }
        signaled = signaledResult.success.signaled;
      }
      const waited = yield* Effect.result(control.wait(request));
      if (waited._tag === "Failure") {
        return receipt(request, "unknown", { reason: "wait-failed", signaled, spawned, guardian });
      }
      const committed = yield* Effect.result(control.commit(request));
      if (committed._tag === "Failure" || !committed.success.committed) {
        return receipt(request, "recovery-required", { reason: "commit-failed", signaled, spawned, guardian });
      }
      return receipt(request, "signaled", { signaled, spawned, guardian });
    }));
  });
}
