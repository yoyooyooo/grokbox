import { randomUUID } from "node:crypto";
import { Cause, Effect, Exit } from "effect";
import { ConfigError, effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { NotificationError, OpsPairingError, selectNotificationTarget, validateNoticeActivation,
  validateNotificationBinding, type NoticeActivationCommand, type NoticeAuthorization, type ReceiverManagementReceipt } from "@grokbox/runtime-kernel/observation";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { createPreparedNoticeDriver, type ExplicitReceiverReader } from "./ops-explicit-delivery.runtime.ts";

const io = <A>(read: () => Promise<A>) => Effect.tryPromise({ try: read, catch: () => new NotificationError("activation_source_unavailable") });
const refuse = (reason: string): never => { throw new NotificationError(reason); };
function result(receipt: ReceiverManagementReceipt, duplicate: boolean) {
  return { schemaVersion: 1, state: "authorized", duplicate, receipt,
    automaticAuthorization: {
      state: "authorized", authorizationId: receipt.authorizationId, bindingRevision: receipt.appliedRevision,
      activatedAtMs: receipt.appliedAtMs, testRequired: false, includesExistingWork: false, nativeTurnObserved: false, currentEligibility: "requires_fresh_checks" },
    routineChanged: false, credentialsRequested: false, notificationSent: false, serviceStarted: false,
    nativeTurnObserved: false, userRead: "not_observed", testRequired: false };
}

/** Local explicit permission, independent of test reminders or user-read claims.
 * Fresh receiver preflight is read-only and outside the private capsule lease.
 * Receipt and authorization publish atomically; replay returns history without
 * renewing the consent boundary or resurrecting a revoked authorization. */
export async function activateOpsNotifications(input: { durableRoot: string; command: NoticeActivationCommand;
  expectedBindingId?: string; requestDigest?: string; readNative: ExplicitReceiverReader; signal?: AbortSignal }) {
  const command = validateNoticeActivation(input.command);
  const requestDigest = input.requestDigest ?? sha256Text(canonicalJson({ command, bindingId: input.expectedBindingId ?? null }));
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) return refuse("invalid_automatic_authorization");
  const owner = openOpsBindings(input.durableRoot), config = openConfigStore(rootConfigLayout(input.durableRoot));
  const monitor = openMonitorStore(input.durableRoot), routines = openRoutineProvisionStore(input.durableRoot);
  const program = Effect.gen(function* () {
    const prior = yield* io(() => owner.managementReceipt(command.operationId));
    if (prior) {
      if (prior.requestDigest !== requestDigest || prior.action !== "enable" || (input.expectedBindingId && prior.bindingId !== input.expectedBindingId)) return refuse("authorization_conflict");
      return result(prior, true);
    }
    const record = yield* io(() => owner.record(command.alias));
    if (!record || !["prepared", "disabled"].includes(record.state) || !record.credentialPresent) return refuse("binding_not_prepared");
    if (input.expectedBindingId && record.bindingId !== input.expectedBindingId) return refuse("binding_identity_changed");
    if (record.automatic) return refuse("authorization_conflict");
    if (record.revision !== command.expectedBindingRevision) return refuse("binding_revision_changed");
    const configured = yield* io(() => config.read());
    const route = selectNotificationTarget(effectiveOps(configured.document.ops));
    if (route.state !== "selected" || route.target.alias !== command.alias) return refuse("default_target_not_selected");
    const scope = yield* io(() => monitor.notificationScope());
    const preflight = createPreparedNoticeDriver({ durableRoot: input.durableRoot, expectedBindingRevision: command.expectedBindingRevision,
      expectedModelRevision: command.expectedModelRevision, readNative: input.readNative, signal: input.signal, allowDisabled: true });
    const binding = yield* io(() => preflight.driver.inspect({ target: route.target, scope, signal: input.signal ?? new AbortController().signal }));
    if (!binding) return refuse(preflight.blocker() ?? "receiver_preflight_unavailable");
    const activatedAtMs = Date.now();
    const authorization: NoticeAuthorization = { version: 2, consent: "explicit-enable", id: randomUUID(), operationId: command.operationId, requestDigest,
      bindingRevision: record.revision + 1, activatedAtMs, modelRevision: binding.modelRevision, qualificationRevision: binding.qualificationRevision,
      nativeTurnObserved: false, includesExistingWork: false };
    const identity = { operationId: command.operationId, requestDigest, bindingId: record.bindingId };
    yield* Effect.uninterruptible(Effect.tryPromise({ try: () => owner.authorizeAutomatic(record, authorization, async () => {
      const [currentConfig, currentScope, currentManaged] = await Promise.all([
        config.read(), monitor.notificationScope(), routines.binding(route.target.agentId, route.target.routineKey),
      ]);
      if (currentConfig.revision !== configured.revision || canonicalJson(currentScope) !== canonicalJson(scope)
        || currentManaged?.routineId !== record.plan.routineId || currentManaged?.revision !== record.plan.routineRevision) return refuse("changed_during_activation");
      validateNotificationBinding(binding, route.target, scope, Date.now());
    }, identity), catch: error => new NotificationError(error instanceof ConfigError && error.code === "config_conflict" ? "activation_busy"
      : error instanceof OpsPairingError && error.reason === "capacity" ? "receipt_capacity"
      : error instanceof OpsPairingError && error.reason === "operation_conflict" ? "authorization_conflict" : "activation_outcome_unknown") }));
    const receipt = yield* Effect.tryPromise({ try: () => owner.managementReceipt(command.operationId), catch: () => new NotificationError("activation_outcome_unknown") });
    if (!receipt) return refuse("activation_outcome_unknown");
    return result(receipt, false);
  });
  const outcome = await Effect.runPromiseExit(program, { signal: input.signal });
  if (Exit.isSuccess(outcome)) return outcome.value;
  const error = Cause.squash(outcome.cause);
  throw error instanceof NotificationError ? error : new NotificationError("activation_source_unavailable");
}
