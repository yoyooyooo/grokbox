import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit } from "effect";
import { ConfigError, effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { NotificationError, NOTICE_SEED_MAX_AGE_MS, automaticAuthorizationView, noticeActivationDigest,
  notificationBindingIdentity, selectNotificationTarget, validateNoticeActivation, validateNotificationBinding,
  type NoticeActivationCommand, type NoticeAuthorization } from "@grokbox/runtime-kernel/observation";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { createPreparedNoticeDriver, type ExplicitReceiverReader } from "./ops-explicit-delivery.runtime.ts";

const io = <A>(read: () => Promise<A>) => Effect.tryPromise({ try: read, catch: () => new NotificationError("activation_source_unavailable") });
const refuse = (reason: string): never => { throw new NotificationError(reason); };
const receipt = (authorization: NoticeAuthorization, duplicate: boolean) => ({ schemaVersion: 1, state: "authorized", duplicate,
  automaticAuthorization: automaticAuthorizationView(authorization), routineChanged: false, credentialsRequested: false,
  notificationSent: false, serviceStarted: false, nativeTurnObserved: false, userRead: "operator_attestation_only" });

/** A one-time local permission after the operator has observed a test reminder.
 * Acceptance is read from the actual outbox, not caller JSON. This does NOT
 * claim program-observed native execution, tool isolation or a service install.
 * Network preflight precedes the existing config lease; no network under lock. */
export async function activateOpsNotifications(input: { durableRoot: string; command: NoticeActivationCommand;
  readNative: ExplicitReceiverReader; signal?: AbortSignal }) {
  const command = validateNoticeActivation(input.command), requestDigest = noticeActivationDigest(command);
  const owner = openOpsBindings(input.durableRoot), config = openConfigStore(rootConfigLayout(input.durableRoot));
  const monitor = openMonitorStore(input.durableRoot), routines = openRoutineProvisionStore(input.durableRoot);
  const program = Effect.gen(function* () {
    const record = yield* io(() => owner.record(command.alias));
    if (!record || record.state !== "prepared" || !record.credentialPresent) return refuse("binding_not_prepared");
    if (record.automatic) {
      if (record.automatic.operationId !== command.operationId || record.automatic.requestDigest !== requestDigest) return refuse("authorization_conflict");
      // Idempotent replay of the local write; never renew the start boundary or
      // call it a new freshness check against the current native environment.
      return receipt(record.automatic, true);
    }
    if (record.revision !== command.expectedBindingRevision) return refuse("binding_revision_changed");
    const configured = yield* io(() => config.read());
    const route = selectNotificationTarget(effectiveOps(configured.document.ops));
    if (route.state !== "selected" || route.target.alias !== command.alias) return refuse("default_target_not_selected");
    const scope = yield* io(() => monitor.notificationScope());
    const preflight = createPreparedNoticeDriver({ durableRoot: input.durableRoot, expectedBindingRevision: command.expectedBindingRevision,
      expectedModelRevision: command.expectedModelRevision, readNative: input.readNative, signal: input.signal });
    const binding = yield* io(() => preflight.driver.inspect({ target: route.target, scope, signal: input.signal ?? new AbortController().signal }));
    if (!binding) return refuse(preflight.blocker() ?? "receiver_preflight_unavailable");
    const seed = yield* io(() => monitor.acceptedNotificationSeed(command.fromWorkId));
    if (!seed || seed.frozen.bindingDigest !== notificationBindingIdentity(binding)) return refuse("accepted_test_not_matched");
    const activatedAtMs = Date.now();
    if (seed.acceptedAtMs > activatedAtMs || activatedAtMs - seed.acceptedAtMs > NOTICE_SEED_MAX_AGE_MS) return refuse("accepted_test_expired");
    const authorization: NoticeAuthorization = { version: 1, id: randomUUID(), operationId: command.operationId, requestDigest,
      bindingRevision: record.revision + 1, activatedAtMs, modelRevision: binding.modelRevision, qualificationRevision: binding.qualificationRevision,
      seedWorkId: command.fromWorkId, seedAttemptId: seed.frozen.attemptId, seedEnvelopeDigest: seed.frozen.envelopeDigest,
      seedAcceptedAtMs: seed.acceptedAtMs, receiverAttestation: "operator-confirmed-reminder", nativeTurnObserved: false, includesExistingWork: false };
    const saved = yield* Effect.uninterruptible(Effect.tryPromise({ try: () => owner.authorizeAutomatic(record, authorization, async () => {
      const [currentConfig, currentScope, currentManaged, currentSeed] = await Promise.all([
        config.read(), monitor.notificationScope(), routines.binding(route.target.agentId, route.target.routineKey), monitor.acceptedNotificationSeed(command.fromWorkId),
      ]);
      if (currentConfig.revision !== configured.revision || canonicalJson(currentScope) !== canonicalJson(scope)
        || currentManaged?.routineId !== record.plan.routineId || currentManaged?.revision !== record.plan.routineRevision
        || canonicalJson(currentSeed) !== canonicalJson(seed)) return refuse("changed_during_activation");
      validateNotificationBinding(binding, route.target, scope, Date.now());
    }), catch: error => new NotificationError(error instanceof ConfigError && error.code === "config_conflict"
      ? "activation_busy" : "activation_outcome_unknown") }));
    if (!saved.automatic) return refuse("authorization_not_persisted");
    return receipt(saved.automatic, false);
  });
  const result = await Effect.runPromiseExit(program, { signal: input.signal });
  if (Exit.isSuccess(result)) return result.value;
  const error = Cause.squash(result.cause);
  throw error instanceof NotificationError ? error : new NotificationError("activation_source_unavailable");
}
