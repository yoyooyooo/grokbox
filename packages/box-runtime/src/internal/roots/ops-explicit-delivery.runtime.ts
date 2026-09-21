import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { decideManagedOwnership } from "@grokbox/runtime-kernel/contract";
import { NotificationError, RECEIVER_NOTICE_POLICY_REVISION, NOTIFICATION_DELIVERY_POLICY,
  projectReceiverModelObservation, type NotificationBinding, type PairingRecord } from "@grokbox/runtime-kernel/observation";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";
import { NATIVE_NOTIFICATION_HTTP_REVISION, type NotificationRequest } from "../io/native-notification.node.ts";
import { type PairedNotificationDriver } from "./ops-notification.runtime.ts";
import type { ReceiverNativeRead } from "./ops-receiver.runtime.ts";

export type ExplicitReceiverRead = ReceiverNativeRead & { ownership: unknown; ownershipGeneration: string };
export type ExplicitReceiverReader = (agentId: string, routineId: string, signal?: AbortSignal) => Promise<ExplicitReceiverRead>;
export type PreparedNoticeDriverInput = { durableRoot: string; expectedBindingRevision: number; expectedModelRevision: string;
  readNative: ExplicitReceiverReader; signal?: AbortSignal };

/* Shared private driver for the managed incident/test and authorized worker
 * lanes. It verifies an existing pairing, never acquires credentials, enables a
 * Routine or grants permission by itself. The original outbox owns effects. */
export function createPreparedNoticeDriver(input: PreparedNoticeDriverInput & { authorizationId?: string; allowDisabled?: boolean;
  expectedBindingId?: string; authorize?: (signal: AbortSignal) => Promise<void> },
  testPorts: { request?: NotificationRequest } = {}) {
  const owner = openOpsBindings(input.durableRoot);
  let latest: PairingRecord | null = null;
  let blocker: string | null = null;
  const driver: PairedNotificationDriver = {
    inspect: async ({ target, scope, signal }) => {
      latest = null;
      if (input.authorize) {
        if (!signal) throw new NotificationError("source_unavailable");
        await input.authorize(signal);
      }
      const stop = (why: string) => { blocker = why; return null; };
      const record = await owner.record(target.alias);
      if (!record || !(record.state === "prepared" || input.allowDisabled && record.state === "disabled") || !record.credentialPresent || record.revision !== input.expectedBindingRevision
        || input.expectedBindingId !== undefined && record.bindingId !== input.expectedBindingId)
        return stop("pairing_not_prepared_or_revision_changed");
      if (input.authorizationId && (!record.automatic || record.automatic.id !== input.authorizationId
        || record.automatic.bindingRevision !== record.revision || Date.now() < record.automatic.activatedAtMs))
        return stop("automatic_authorization_changed");
      if (canonicalJson(record.plan.target) !== canonicalJson(target) || canonicalJson(record.plan.scope) !== canonicalJson(scope))
        return stop("pairing_scope_or_policy_changed");
      const managedStore = openRoutineProvisionStore(input.durableRoot);
      const managed = await managedStore.binding(target.agentId, target.routineKey);
      if (!managed || managed.routineId !== record.plan.routineId || managed.revision !== record.plan.routineRevision)
        return stop("managed_definition_changed");
      const native = await input.readNative(target.agentId, record.plan.routineId, signal);
      if (!native.consistentGeneration || native.ownershipGeneration !== native.snapshot.generation
        || record.plan.generation !== native.snapshot.generation || native.snapshot.catalog.agentId !== target.agentId)
        return stop("native_generation_changed");
      const routine = native.snapshot.catalog.routines.find(row => row.id === record.plan.routineId);
      // Enabling is a separate explicit user action. The native enabled flag is
      // not silently written here; only that bit may differ from preparation.
      if (!routine || !routine.enabled || !routine.mutable || routine.trigger.type !== "webhook"
        || sha256Text(canonicalJson({ definitionRevision: routine.definitionRevision, enabled: false })) !== record.plan.routineRevision)
        return stop("enabled_routine_not_matched");
      if (native.promptPolicyRevision !== RECEIVER_NOTICE_POLICY_REVISION) return stop("notice_policy_mismatch");
      const [current, currentManaged] = await Promise.all([owner.record(target.alias), managedStore.binding(target.agentId, target.routineKey)]);
      if (canonicalJson(current) !== canonicalJson(record) || canonicalJson(currentManaged) !== canonicalJson(managed))
        return stop("pairing_changed_during_read");
      const now = Date.now(), model = projectReceiverModelObservation(native.model, target.agentId, now);
      const ownership = decideManagedOwnership({ agentId: target.agentId, snapshot: native.ownership, nowMs: now });
      if (!ownership.ok) return stop("receiver_ownership_not_qualified");
      if (!model || model.state !== "observed" || native.capabilities.state !== "ready"
        || native.capabilities.observed?.loaded.profileSha256 !== model.loadedProfileRevision
        || native.capabilities.observed?.loaded.sourceSha256 !== model.loadedSourceRevision)
        return stop("receiver_model_or_loaded_host_not_matched");
      if (model.modelRevision !== input.expectedModelRevision) return stop("expected_model_changed");
      latest = record; blocker = null;
      const qualificationRevision = sha256Text(canonicalJson({ lane: "explicit-notice-v1", http: NATIVE_NOTIFICATION_HTTP_REVISION,
        noticePolicy: RECEIVER_NOTICE_POLICY_REVISION, generation: native.snapshot.generation,
        accountScope: ownership.evidence.scopeId, serverId: ownership.evidence.serverId,
        profile: model.loadedProfileRevision, source: model.loadedSourceRevision, preload: model.loadedPreloadRevision, mode: model.loadedMode }));
      if (input.authorizationId && (record.automatic!.modelRevision !== model.modelRevision
        || record.automatic!.qualificationRevision !== qualificationRevision)) return stop("automatic_qualification_changed");
      // Keep original witness age. Local reads must not renew a stale native
      // observation; validation in the delivery program enforces the deadline.
      const observedAtMs = Math.min(model.observedAtMs, ownership.evidence.observedAtMs);
      const binding: NotificationBinding = { bindingId: record.bindingId, revision: record.revision,
        databaseId: scope.databaseId, scopeId: scope.scopeId, targetAlias: target.alias, agentId: target.agentId,
        routineKey: target.routineKey, routineId: routine.id, routineRevision: routine.revision,
        modelRevision: model.modelRevision!, qualificationRevision, policyRevision: target.policyRevision,
        dataPolicy: "safe-summary", receiverMode: "notify_then_end", observedAtMs,
        validUntilMs: observedAtMs + NOTIFICATION_DELIVERY_POLICY.bindingFreshMs };
      return binding;
    },
    send: async args => {
      if (!latest || latest.bindingId !== args.binding.bindingId || latest.revision !== args.binding.revision)
        return { state: "definitely-not-accepted", reason: "revoked" };
      return owner.sendPreparedNotice(latest, args, testPorts.request, input.authorizationId, input.authorize);
    },
  };
  return { driver, blocker: () => blocker };
}
