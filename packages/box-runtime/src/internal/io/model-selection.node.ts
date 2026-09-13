import { Clock, Effect } from "effect";
import { BoxRuntimeError, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { applyReset, applyUse, assertResetAllowed, assertStubOnlyRouteAssignments, disclosure } from "@grokbox/runtime-kernel/selection";
import { runConfigurationSave } from "@grokbox/runtime-kernel/commands";
import { configurationWriteLayer } from "./configuration-write.node.ts";
import type { RuntimeStore } from "./configuration.node.ts";
import { readManagedOwnership, type OwnershipReader } from "./ownership-admission.node.ts";

/** One command root; no Host signal, provider request or identity/config mirror. */
export async function changeRuntimeModel(input: {
  store: RuntimeStore; forAgent?: string; modelId?: string; ownershipRead?: OwnershipReader; signal?: AbortSignal;
}) {
  return await Effect.runPromise(Effect.gen(function* () {
    if (input.forAgent !== undefined && (!input.forAgent.length || input.forAgent.length > 128 || /[\s\x00-\x1f]/.test(input.forAgent))) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "--for must be a stable agent ID."));
    }
    const load = () => Effect.tryPromise({
      try: async () => ({ models: await input.store.loadModels(), desired: await input.store.loadDesired() }),
      catch: () => new BoxRuntimeError("invalid_usage", "Model configuration is unavailable."),
    });
    const before = yield* load();
    const next = yield* Effect.try({
      try: () => {
        if (input.modelId === undefined) assertResetAllowed(before.desired, input.forAgent);
        const file = input.modelId === undefined ? applyReset(before.models, input.forAgent) : applyUse(before.models, input.modelId, input.forAgent);
        if (before.desired.mode === "route") assertStubOnlyRouteAssignments(file);
        return file;
      },
      catch: error => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Invalid model selection."),
    });
    // Enabling managed execution requires fresh Box ownership. Explicit reset
    // only removes our override: it must remain possible after revocation or
    // bridge loss, and never asserts that the native owner is now Box/ready.
    const ownership = input.forAgent && input.modelId !== undefined
      ? yield* readManagedOwnership({ agentId: input.forAgent, read: input.ownershipRead }) : null;
    // No repair/auto-adopt when a bridge is unavailable. Do not overwrite a
    // configuration changed while awaiting identity. This is not multi-writer CAS.
    const after = yield* load();
    if (canonicalJson(before) !== canonicalJson(after)) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "selection_configuration_changed"));
    if (ownership && (yield* Clock.currentTimeMillis) - ownership.evidence.observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
      return yield* Effect.fail(new BoxRuntimeError("runtime_ownership_unavailable", "ownership_evidence_stale"));
    }
    const receipt = yield* runConfigurationSave({ boxRoot: input.store.root, kind: "models", file: next }).pipe(Effect.provide(configurationWriteLayer(input.store, sha256Text(canonicalJson(before.models)))));
    if (!receipt.ok) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", receipt.reason));
    return {
      ...(input.modelId ? disclosure(next, input.modelId, input.forAgent) : { assignments: next.assignments, model: "official", takesEffect: "next_user_turn", blastRadius: input.forAgent ? "single_bot" : "box_default" }),
      configRevision: receipt.configRevision, selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed",
      ownership: ownership ? "confirmed_box" : input.forAgent ? "not_required_for_reset" : "not_applicable_default_only",
    };
  }), { signal: input.signal });
}
