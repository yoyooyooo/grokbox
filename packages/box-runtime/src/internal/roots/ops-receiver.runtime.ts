import { Effect } from "effect";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { pairingAlias, pairingTarget, receiverBlueprint, receiverPolicyRevision, projectReceiverModelObservation, type ReceiverModelObservation } from "@grokbox/runtime-kernel/observation";
import type { RoutineSnapshot } from "@grokbox/runtime-kernel/routines";
import type { HostCapabilityReport } from "@grokbox/runtime-kernel/contract";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";

export type ReceiverNativeRead = { snapshot: RoutineSnapshot; promptPolicyRevision: string | null;
  model: ReceiverModelObservation | null; capabilities: HostCapabilityReport; consistentGeneration: boolean };
export type ReceiverNativeReader = (agentId: string, routineId: string, signal?: AbortSignal) => Promise<ReceiverNativeRead>;
const io = <A>(read: () => Promise<A>) => Effect.tryPromise({ try: read, catch: () => "receiver_source_unavailable" });

export async function prepareOpsReceiverBlueprint(input: { durableRoot: string; alias: string }) {
  pairingAlias(input.alias);
  return Effect.runPromise(io(() => openConfigStore(rootConfigLayout(input.durableRoot)).read()).pipe(Effect.map(snapshot => {
    const target = pairingTarget(effectiveOps(snapshot.document.ops), input.alias);
    return receiverBlueprint(target.routineKey, target.intent);
  })));
}

/** Read only, no credential access or stored qualification. A current model
 * preview is prerequisite evidence for an explicit canary, not proof that a
 * native Webhook was accepted, which tools ran, or that the user saw a message. */
export async function verifyOpsReceiver(input: { durableRoot: string; alias: string; readNative: ReceiverNativeReader; signal?: AbortSignal; now?: () => number }) {
  pairingAlias(input.alias);
  const now = input.now ?? Date.now;
  const program = Effect.gen(function* () {
    const config = openConfigStore(rootConfigLayout(input.durableRoot)), bindings = openOpsBindings(input.durableRoot);
    const blockers: string[] = [];
    const result = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, alias: input.alias,
      state: blockers.length ? "blocked" : "preflight_ready", localPreflightComplete: blockers.length === 0, blockers,
      ...extra, deliveryAuthorized: false, qualificationPersisted: false, nativeCredentialsRequested: false, privateCredentialsIncluded: false, routineChanged: false,
      executionOwnership: "not_checked", canaryAuthorized: false,
      nativeHttp: "not_qualified", actualReceiverTurn: "not_observed", tools: "not_observed", userRead: "not_observed",
      promptPolicyIsSandbox: false, automaticDiagnosis: false, automaticIssue: false, activation: "not_implemented" });
    const before = yield* io(() => config.read());
    const target = pairingTarget(effectiveOps(before.document.ops), input.alias);
    const record = yield* io(() => bindings.record(input.alias));
    if (!record || record.state !== "prepared" || !record.credentialPresent) { blockers.push("binding_not_prepared"); return result(); }
    const scope = yield* io(() => openMonitorStore(input.durableRoot).notificationScope());
    if (canonicalJson(scope) !== canonicalJson(record.plan.scope) || canonicalJson(target) !== canonicalJson(record.plan.target)) blockers.push("pairing_scope_or_policy_changed");
    const managed = yield* io(() => openRoutineProvisionStore(input.durableRoot).binding(target.agentId, target.routineKey));
    if (!managed || managed.routineId !== record.plan.routineId || managed.revision !== record.plan.routineRevision) blockers.push("managed_definition_changed");
    if (blockers.length) return result({ bindingRevision: record.revision });
    const native = yield* io(() => input.readNative(target.agentId, record.plan.routineId, input.signal));
    const routine = native.snapshot.catalog.routines.find(r => r.id === record.plan.routineId);
    if (native.snapshot.catalog.agentId !== target.agentId || !native.consistentGeneration) blockers.push("native_generation_changed");
    if (!routine || routine.revision !== record.plan.routineRevision || !routine.mutable || routine.trigger.type !== "webhook" || routine.enabled) blockers.push("disabled_routine_changed");
    if (native.promptPolicyRevision !== receiverPolicyRevision(target.intent)) blockers.push("notice_policy_mismatch");
    let model = projectReceiverModelObservation(native.model, target.agentId, now());
    if (!model || model.state !== "observed") blockers.push("model_selection_unobserved");
    if (native.capabilities.state !== "ready" || !model || native.capabilities.observed?.loaded.profileSha256 !== model.loadedProfileRevision
      || native.capabilities.observed?.loaded.sourceSha256 !== model.loadedSourceRevision) blockers.push("loaded_host_not_matched");
    const [after, finalRecord, finalScope, finalManaged] = yield* io(() => Promise.all([config.read(), bindings.record(input.alias),
      openMonitorStore(input.durableRoot).notificationScope(), openRoutineProvisionStore(input.durableRoot).binding(target.agentId, target.routineKey)]));
    if (after.revision !== before.revision || canonicalJson(finalRecord) !== canonicalJson(record) || canonicalJson(finalScope) !== canonicalJson(scope)
      || canonicalJson(finalManaged) !== canonicalJson(managed)) blockers.push("changed_during_verification");
    // Local scope checks may themselves take time; do not return a green result
    // for a witness that expired while those checks were in progress.
    if (model && !projectReceiverModelObservation(model, target.agentId, now())) {
      model = null; blockers.push("model_observation_expired");
    }
    return result({ bindingId: record.bindingId, bindingRevision: record.revision, routineId: record.plan.routineId,
      routineRevision: routine?.revision ?? null, promptPolicy: native.promptPolicyRevision === receiverPolicyRevision(target.intent) ? "matched" : "not_matched",
      model, hostCapability: { state: native.capabilities.state, reason: native.capabilities.reason }, nativeCompareAndSwap: false });
  }).pipe(Effect.catch(() => Effect.succeed({ schemaVersion: 1, alias: input.alias, state: "unavailable", localPreflightComplete: false,
    blockers: ["source_unavailable"], deliveryAuthorized: false, qualificationPersisted: false, nativeCredentialsRequested: false, privateCredentialsIncluded: false, routineChanged: false,
    executionOwnership: "not_checked", canaryAuthorized: false,
    nativeHttp: "not_qualified", actualReceiverTurn: "not_observed", activation: "not_implemented" })));
  return Effect.runPromise(program, { signal: input.signal });
}
