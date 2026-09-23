import { Clock, Effect } from "effect";
import { BoxRuntimeError, OWNERSHIP_EVIDENCE_MAX_AGE_MS } from "@grokbox/runtime-kernel/contract";
import type { ModelChange, ModelPublicationCheck } from "@grokbox/runtime-kernel/model-management";
import { assignmentForBot, requireModel, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { readManagedOwnership, ownershipUseError, type OwnershipReader } from "../io/ownership-admission.node.ts";
import { probeOpenAiCatalog } from "../io/openai-catalog-probe.node.ts";

/** Capture native admission before taking a configuration lease. Its returned
 * host-local check survives writer waits, but cannot renew native evidence.
 * Reset needs no native ownership; management permission is still required. */
export function managedModelAdmission(options: { ownershipRead?: OwnershipReader; env?: NodeJS.Dict<string>; fetch?: typeof fetch;
  publication?: { signal: AbortSignal; authorize: (signal: AbortSignal) => Promise<void> } }) {
  return (change: ModelChange, next: ModelsFile): Effect.Effect<ModelPublicationCheck, unknown> => Effect.gen(function* () {
    const agentId = change.kind === "bot-selection" && change.selection.kind !== "native" ? change.agentId : undefined;
    const modelId = agentId ? assignmentForBot(next, agentId)!.modelId
      : change.kind === "default-selection" ? change.selection?.modelId : undefined;
    const beganAt = performance.now();
    const ownership = agentId && modelId ? yield* readManagedOwnership({ agentId, read: options.ownershipRead }) : undefined;
    const capturedAt = performance.now();
    const capturedAgeMs = ownership ? Math.max(0, Date.now() - ownership.evidence.observedAtMs,
      ownership.remote.readObservation?.serverEvidenceAgeMs ?? 0) : 0;
    const started = yield* Clock.monotonicTimeNanos;
    if (modelId) yield* Effect.tryPromise({
      try: signal => probeOpenAiCatalog({ record: requireModel(next, modelId), env: options.env ?? process.env, fetch: options.fetch, signal }),
      catch: error => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Model catalog probe failed."),
    });
    const checkFresh = () => {
      if (!ownership) return;
      const elapsed = performance.now() - beganAt, wallAge = Date.now() - ownership.evidence.observedAtMs;
      // Add elapsed time to the already-aged observation. A wall-clock
      // correction must not turn four-second evidence into a fresh five-second lease.
      const age = Math.max(elapsed, wallAge, capturedAgeMs + performance.now() - capturedAt);
      if (!Number.isFinite(age) || elapsed < 0 || wallAge < 0 || age > OWNERSHIP_EVIDENCE_MAX_AGE_MS)
        throw ownershipUseError("ownership_evidence_stale", "unconfirmed", agentId, ownership.remote.readObservation,
          { availabilityCause: "evidence_elapsed", evidenceAgeMs: Math.max(0, Math.ceil(age)) });
    };
    if (ownership) {
      const elapsedMs = Number((yield* Clock.monotonicTimeNanos) - started) / 1_000_000;
      const ageMs = Math.max(elapsedMs, (yield* Clock.currentTimeMillis) - ownership.evidence.observedAtMs);
      if (ageMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) return yield* Effect.fail(ownershipUseError("ownership_evidence_stale", "unconfirmed", agentId, ownership.remote.readObservation,
        { availabilityCause: "evidence_elapsed", evidenceAgeMs: Math.ceil(ageMs) }));
    }
    return async () => {
      const publication = options.publication;
      publication?.signal.throwIfAborted();
      if (publication) await publication.authorize(publication.signal);
      publication?.signal.throwIfAborted();
      checkFresh();
    };
  });
}
