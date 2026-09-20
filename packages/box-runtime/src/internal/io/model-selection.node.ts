import { Clock, Effect } from "effect";
import { BoxRuntimeError, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { applyReset, applyUse, applyFollowDefault, assignmentForBot, parseRequestedEffort, assertStubOnlyRouteAssignments, disclosure, persistModelsDocument, requireModel, captureManagedSelection } from "@grokbox/runtime-kernel/selection";
import { runConfigurationSave } from "@grokbox/runtime-kernel/commands";
import { configurationWriteLayer } from "./configuration-write.node.ts";
import type { RuntimeStore } from "./configuration.node.ts";
import { ownershipUseError, readManagedOwnership, type OwnershipReader } from "./ownership-admission.node.ts";
import { probeOpenAiCatalog } from "./openai-catalog-probe.node.ts";

/** One command root; no Host signal, provider request or identity/config mirror. */
export async function changeRuntimeModel(input: {
  store: RuntimeStore; forAgent?: string; modelId?: string; followDefault?: boolean; effort?: string; ownershipRead?: OwnershipReader; signal?: AbortSignal;
  env?: NodeJS.Dict<string>; fetch?: typeof fetch; expectedSelectionHash?: string;
}) {
  return await Effect.runPromise(Effect.gen(function* () {
    const reasoning = yield* Effect.try({ try: () => parseRequestedEffort(input.effort), catch: error => error });
    if (input.followDefault && (!input.forAgent || input.modelId !== undefined || input.effort !== undefined)) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "Following the default requires a Bot and cannot include model or effort overrides."));
    }
    if (input.modelId === undefined && input.effort !== undefined) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "An effort requires a model selection, not reset."));
    if (input.forAgent !== undefined && (!input.forAgent.length || input.forAgent.length > 128 || /[\s\x00-\x1f]/.test(input.forAgent))) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "--for must be a stable agent ID."));
    }
    const load = () => Effect.tryPromise({
      try: async () => ({ models: await input.store.loadModels(), desired: await input.store.loadDesired() }),
      catch: () => new BoxRuntimeError("invalid_usage", "Model configuration is unavailable."),
    });
    const before = yield* load();
    if (input.expectedSelectionHash !== undefined && (!input.forAgent || !/^[a-f0-9]{64}$/.test(input.expectedSelectionHash)
      || sha256Text(canonicalJson(captureManagedSelection(before.models,input.forAgent))) !== input.expectedSelectionHash))
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage","selection_configuration_changed"));
    const next = yield* Effect.try({
      try: () => {
        const file = input.followDefault ? applyFollowDefault(before.models, input.forAgent!)
          : input.modelId === undefined ? applyReset(before.models, input.forAgent) : applyUse(before.models, input.modelId, input.forAgent, reasoning);
        if (before.desired.mode === "route") assertStubOnlyRouteAssignments(file);
        return file;
      },
      catch: error => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Invalid model selection."),
    });
    // Enabling managed execution requires fresh Box ownership before provider
    // catalog I/O. Explicit reset only removes our override: it must remain
    // possible after revocation or bridge loss, and never asserts that the
    // native owner is now Box/ready.
    const selectedModelId = input.followDefault ? assignmentForBot(next, input.forAgent!)!.modelId : input.modelId;
    const ownership = input.forAgent && selectedModelId !== undefined
      ? yield* readManagedOwnership({ agentId: input.forAgent, read: input.ownershipRead }) : null;
    if (selectedModelId !== undefined) {
      const modelId = selectedModelId;
      yield* Effect.tryPromise({
        try: () => probeOpenAiCatalog({
          record: requireModel(next, modelId),
          env: input.env ?? process.env,
          fetch: input.fetch,
          signal: input.signal,
        }),
        catch: (error) => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Model catalog probe failed."),
      });
    }
    // No repair/auto-adopt when a bridge is unavailable. Do not overwrite a
    // configuration changed while awaiting identity. This is not multi-writer CAS.
    const after = yield* load();
    if (canonicalJson(before) !== canonicalJson(after)) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "selection_configuration_changed"));
    const evidenceAgeMs = ownership ? (yield* Clock.currentTimeMillis) - ownership.evidence.observedAtMs : 0;
    if (ownership && evidenceAgeMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
      return yield* Effect.fail(ownershipUseError("ownership_evidence_stale", "unconfirmed", input.forAgent, ownership.remote.readObservation,
        { availabilityCause: "evidence_elapsed", evidenceAgeMs: Math.ceil(evidenceAgeMs) }));
    }
    const receipt = yield* runConfigurationSave({ boxRoot: input.store.root, kind: "models", file: next }).pipe(Effect.provide(configurationWriteLayer(input.store, sha256Text(canonicalJson(persistModelsDocument(before.models))))));
    if (!receipt.ok) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", receipt.reason));
    return {
      ...(selectedModelId ? disclosure(next, selectedModelId, input.forAgent) : { assignments: next.assignments, model: "official", takesEffect: "next_user_turn", blastRadius: input.forAgent ? "single_bot" : "box_default" }),
      selection: input.followDefault ? "default" : selectedModelId ? "model" : "native",
      configRevision: receipt.configRevision, selectionSaved: true, currentTurn: "unchanged", effectiveUse: "not_observed",
      ownership: ownership ? "confirmed_box" : input.forAgent ? "not_required_for_reset" : "not_applicable_default_only",
    };
  }), { signal: input.signal });
}

/** Explicit schema normalization, using the same protected CAS writer. Does not
 * grant managed ownership, resolve credentials, change desired or call Provider. */
export async function migrateRuntimeModels(input: { store: RuntimeStore; confirmed: boolean; signal?: AbortSignal }) {
  return Effect.runPromise(Effect.gen(function* () {
    if (!input.confirmed) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "models migrate requires --confirm; coordinate the Host/modeld upgrade before saving schema v3."));
    const models = yield* Effect.tryPromise({ try: () => input.store.loadModels(), catch: error => error });
    const receipt = yield* runConfigurationSave({ boxRoot: input.store.root, kind: "models", file: models }).pipe(
      Effect.provide(configurationWriteLayer(input.store, sha256Text(canonicalJson(persistModelsDocument(models))))));
    if (!receipt.ok) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", receipt.reason));
    return { modelsSchemaVersion: 3, configRevision: receipt.configRevision, configurationSaved: true,
      assignmentsUnchanged: true, currentTurn: "unchanged", effectiveUse: "not_observed" };
  }), { signal: input.signal });
}
