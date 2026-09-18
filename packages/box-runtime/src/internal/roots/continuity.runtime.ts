import { Effect } from "effect";
import { ContinuityFailure, type ContinuityEffectIntent, type RecoveryPublication } from "@grokbox/runtime-kernel/continuity";
import type { ContinuityStorageOwner, ContinuityStorageOwners } from "@grokbox/runtime-kernel/observation";
import { continuityStorePrograms, type ContinuityStoreInput } from "../io/continuity-store.node.ts";
import type { ContinuityStoreHooks } from "../io/continuity-database.node.ts";

/** Explicit local persistence capability. Construction/GET do not initialize
 * storage or alter a Bot. Production composition will inject these owners into
 * J1's existing maintenance host; this factory installs no timer or service.
 * Native capture/import, authorization, config binding and deployment remain
 * separate gates. A persisted effect claim is not execution permission. */
export function openContinuityRecoveryStore(input: ContinuityStoreInput, hooks: ContinuityStoreHooks = {}) {
  const programs = continuityStorePrograms(input, hooks);
  const run = <A>(program: Effect.Effect<A, ContinuityFailure>, signal?: AbortSignal): Promise<A> => {
    if (signal?.aborted) return Promise.reject(new ContinuityFailure("cancelled"));
    return Effect.runPromise(program, signal ? { signal } : undefined);
  };
  const recovery: ContinuityStorageOwner = {
    owner: "continuity.recovery", measure: () => run(programs.measure("continuity.recovery")),
    changeReference: change => run(programs.changeReference("continuity.recovery", change)),
    maintain: ({ nowMs, maxItems }) => run(programs.maintainRecovery(nowMs, maxItems)),
  };
  const safety: ContinuityStorageOwner = {
    owner: "continuity.safety", measure: () => run(programs.measure("continuity.safety")),
    changeReference: change => run(programs.changeReference("continuity.safety", change)),
    maintain: () => run(programs.maintainSafety()),
  };
  return {
    owners: { recovery, safety } satisfies ContinuityStorageOwners,
    initialize: (signal?: AbortSignal) => run(programs.initialize(), signal),
    status: () => run(programs.status()),
    publish: (publication: RecoveryPublication, signal?: AbortSignal) => run(programs.publish(publication), signal),
    publication: (requestId: string) => run(programs.publication(requestId)),
    readSnapshot: (requestId: string) => run(programs.readSnapshot(requestId)),
    reconcilePublication: (requestId: string, action: "verify" | "abandon", signal?: AbortSignal) => run(programs.reconcilePublication(requestId, action), signal),
    prepareEffect: (intent: ContinuityEffectIntent, signal?: AbortSignal) => run(programs.prepareEffect(intent), signal),
    claimEffect: (operationId: string, effectId: string, policyRevision: string, signal?: AbortSignal) => run(programs.claimEffect(operationId, effectId, policyRevision), signal),
    settleEffect: (operationId: string, effectId: string, outcome: "succeeded" | "not_executed", evidenceHash: string, signal?: AbortSignal) => run(programs.settleEffect(operationId, effectId, outcome, evidenceHash), signal),
    operation: (operationId: string) => run(programs.operation(operationId)),
  };
}
