import { Cause, Effect, Exit } from "effect";
import { OpsTargetPairing } from "@grokbox/runtime-kernel/ports";
import { runOpsTargetPairing } from "@grokbox/runtime-kernel/commands";
import { effectiveOps } from "@grokbox/runtime-kernel/config";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { OpsPairingError, pairingAlias, pairingPlan, pairingTarget, pairingFail, observePairingRoutine,
  type PairingCommand, type PairingPlan } from "@grokbox/runtime-kernel/observation";
import type { RoutineSnapshot } from "@grokbox/runtime-kernel/routines";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { openConfigStore } from "../io/config-store.node.ts";
import { rootConfigLayout } from "../io/config-layout.node.ts";

export type NativePairingSource = {
  list: (agentId: string) => Promise<RoutineSnapshot>;
  credential: (agentId: string, routineId: string) => Promise<{ value: unknown; generation: string }>;
};
export async function runOpsPairing(input: { durableRoot: string; command: PairingCommand; expectedBindingRevision?: number;
  native: NativePairingSource; signal?: AbortSignal }) {
  const store = openOpsBindings(input.durableRoot), monitor = openMonitorStore(input.durableRoot);
  const readTarget = async (name: string) => pairingTarget(effectiveOps((await openConfigStore(rootConfigLayout(input.durableRoot)).read()).document.ops), name);
  const io = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: e => e instanceof OpsPairingError ? e : new OpsPairingError("store_unavailable") });
  const current = async (plan: PairingPlan) => {
    const target = await readTarget(plan.target.alias), scope = await monitor.notificationScope();
    if (canonicalJson(target) !== canonicalJson(plan.target) || canonicalJson(scope) !== canonicalJson(plan.scope)) return pairingFail("scope_changed");
    const managed = await openRoutineProvisionStore(input.durableRoot).binding(plan.target.agentId, plan.target.routineKey);
    if (!managed || managed.routineId !== plan.routineId || managed.revision !== plan.routineRevision) return pairingFail("unmanaged_routine");
  };
  const result = await Effect.runPromiseExit(runOpsTargetPairing(input.command, input.expectedBindingRevision).pipe(Effect.provideService(OpsTargetPairing, {
    prior: alias => io(() => store.record(alias)),
    plan: command => io(async () => {
      if (input.signal?.aborted) return pairingFail("credential_unavailable");
      const target = await readTarget(command.alias), scope = await monitor.notificationScope();
      const managed = await openRoutineProvisionStore(input.durableRoot).binding(target.agentId, target.routineKey);
      if (!managed || managed.routineId !== command.routineId || managed.revision !== command.expectedRevision) return pairingFail("unmanaged_routine");
      return pairingPlan(command, target, scope, await input.native.list(target.agentId));
    }),
    reserve: (plan, expected) => io(async () => {
      if (input.signal?.aborted) return pairingFail("credential_unavailable");
      return store.reserve(plan, expected, () => current(plan));
    }),
    credential: plan => io(async () => {
      if (input.signal?.aborted) return pairingFail("outcome_unknown");
      const result = await input.native.credential(plan.target.agentId, plan.routineId);
      if (result.generation !== plan.generation) return pairingFail("outcome_unknown");
      return result.value;
    }),
    recheck: plan => io(async () => {
      const snapshot = await input.native.list(plan.target.agentId);
      observePairingRoutine({ action: "preview", alias: plan.target.alias, routineId: plan.routineId, expectedRevision: plan.routineRevision, operationId: plan.operationId }, snapshot);
      if (snapshot.generation !== plan.generation || snapshot.catalog.agentId !== plan.target.agentId) return pairingFail("scope_changed");
      await current(plan);
    }),
    finish: (record, credential) => io(() => store.finish(record, credential, () => current(record.plan))),
  })), { signal: input.signal });
  if (Exit.isSuccess(result)) return result.value;
  const error = Cause.squash(result.cause); if (error instanceof OpsPairingError) throw error;
  throw new OpsPairingError(input.command.action === "bind" ? "outcome_unknown" : "store_unavailable");
}

export async function observeOpsTargets(input: { durableRoot: string; alias?: string }) {
  if (input.alias) pairingAlias(input.alias);
  const stored = await openOpsBindings(input.durableRoot).status(input.alias);
  return { ...stored, nativeState: "not_checked", receiverQualification: "not_verified", deliveryAuthorized: false, keyReadsFromNative: 0 };
}
export async function revokeOpsTarget(input: { durableRoot: string; alias: string; expectedRevision: number; action: "disable" | "unbind"; confirmed: boolean }) {
  pairingAlias(input.alias);
  if (input.confirmed !== true) return pairingFail("confirmation_required");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !["disable", "unbind"].includes(input.action)) return pairingFail("invalid_input");
  return openOpsBindings(input.durableRoot).revoke(input.alias, input.expectedRevision, input.action, input.confirmed);
}
