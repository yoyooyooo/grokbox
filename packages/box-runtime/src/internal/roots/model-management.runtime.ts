import { Clock, Effect } from "effect";
import { BoxRuntimeError, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import type { ModelChange } from "@grokbox/runtime-kernel/model-management";
import { assignmentForBot, requireModel, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { readManagedOwnership, ownershipUseError, type OwnershipReader } from "../io/ownership-admission.node.ts";
import { probeOpenAiCatalog } from "../io/openai-catalog-probe.node.ts";

/** Admission is supplied by the Server's native bridge, never by client JSON.
 * Reset only withdraws our intent and does not claim native ownership/readiness. */
export function managedModelAdmission(options: { ownershipRead?: OwnershipReader; env?: NodeJS.Dict<string>; fetch?: typeof fetch }) {
  return (change: ModelChange, next: ModelsFile): Effect.Effect<void, unknown> => Effect.gen(function* () {
    const agentId = change.kind === "bot-selection" && change.selection.kind !== "native" ? change.agentId : undefined;
    const modelId = agentId ? assignmentForBot(next, agentId)!.modelId
      : change.kind === "default-selection" ? change.selection?.modelId : undefined;
    if (!modelId) return;
    const ownership = agentId ? yield* readManagedOwnership({ agentId, read: options.ownershipRead }) : undefined;
    const started = yield* Clock.monotonicTimeNanos;
    yield* Effect.tryPromise({
      try: signal => probeOpenAiCatalog({ record: requireModel(next, modelId), env: options.env ?? process.env, fetch: options.fetch, signal }),
      catch: error => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Model catalog probe failed."),
    });
    if (ownership) {
      const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
      const ageMs = Math.max(elapsedMs, (yield* Clock.currentTimeMillis) - ownership.evidence.observedAtMs);
      if (ageMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
        return yield* Effect.fail(ownershipUseError("ownership_evidence_stale", "unconfirmed", agentId, ownership.remote.readObservation,
          { availabilityCause: "evidence_elapsed", evidenceAgeMs: Math.ceil(ageMs) }));
      }
    }
  });
}
