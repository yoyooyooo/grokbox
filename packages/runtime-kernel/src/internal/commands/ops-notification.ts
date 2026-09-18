import { Effect } from "effect";
import { OpsNotification } from "../../ports.ts";
import { notificationBindingIdentity, type NativeNotificationResult } from "../../observation.ts";

/** A single guarded delivery iteration, not a scheduler or retry policy. The
 * already-fixed work is never reclassified by a model, rerouted on uncertainty
 * or converted into a diagnosis/maintenance task. */
export function runOpsNotification(workId: string) {
  return Effect.gen(function* () {
    const ports = yield* OpsNotification;
    const common = { workId, automaticRetry: false, botReport: "not_observed", userRead: "not_observed" } as const;
    if (yield* ports.attempted(workId)) return { ...common, state: "already_attempted" as const };
    const selected = yield* ports.route();
    if (selected.state === "blocked") return { ...common, state: "blocked" as const, reason: selected.reason };
    const installation = yield* ports.scope(), binding = yield* ports.inspect(selected.target, installation);
    if (!binding) return { ...common, state: "unavailable" as const, reason: "target_not_paired" };
    return yield* Effect.uninterruptible(Effect.gen(function* () {
      // No asynchronous operation escapes this scope after side-effect admission.
      const reservation = yield* ports.reserve(workId, selected.target, binding);
      if (reservation.state !== "reserved") return { ...common, ...reservation };
      const { frozen, envelope } = reservation;
      const settle = (result: NativeNotificationResult) => Effect.gen(function* () {
        yield* ports.settle(frozen, result);
        return { ...common, state: result.state, attemptId: frozen.attemptId,
          evidenceRevision: frozen.evidenceRevision, envelopeDigest: frozen.envelopeDigest };
      });
      // Recheck the pairing owner immediately before the local start barrier.
      // Scope/Agent/Routine/model/data changes do not inherit a prior permission.
      const current = yield* ports.inspect(selected.target, installation).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!current || notificationBindingIdentity(current) !== frozen.bindingDigest)
        return yield* settle({ state: "definitely-not-accepted", reason: "revoked" });
      const start = yield* ports.begin(frozen);
      if (!start.dispatch && start.reason === "already_attempted") return { ...common, state: "unknown" as const,
        reason: "start_already_claimed", attemptId: frozen.attemptId };
      if (!start.dispatch) return yield* settle({ state: "definitely-not-accepted", reason: start.reason === "expired" ? "expired" : "policy_changed" });
      const result = yield* ports.send(frozen, envelope, current)
        .pipe(Effect.catch(() => Effect.succeed({ state: "unknown", reason: "transport_failure" } as const)));
      return yield* settle(result);
    })).pipe(Effect.catch(() => Effect.succeed({ ...common, state: "unknown" as const, reason: "local_or_transport_uncertainty" })));
  }).pipe(Effect.catch(() => Effect.succeed({ workId, state: "unavailable" as const, reason: "preflight_unavailable",
    automaticRetry: false, botReport: "not_observed", userRead: "not_observed" })));
}
