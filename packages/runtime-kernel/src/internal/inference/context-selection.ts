import { Effect } from "effect";
import { ConfigurationRead } from "../../ports.ts";
import { captureManagedSelection, modelForAgent } from "../../selection.ts";
import { captureContextPolicy } from "../config/context-policy.ts";
import { ContextFailure, type ContextMaintenanceIdentity, type ContextSelectionCapture } from "../contract/context-maintenance.ts";
import type { OwnershipAdmission } from "../contract/ownership.ts";
import { canonicalJson } from "../../hash.ts";
import { InferenceMemory, modifyExecutionState, turnKey, ledgerKey, coldTurn } from "./route-binding.ts";

/** The same TURN lock as main admission, not a second selection/lifecycle store.
 * Witnesses come only from the admitted authority/auth ports, never caller JSON. */
export function captureContextSelection(identity: ContextMaintenanceIdentity, witness?: {
  authFingerprint?: string;
  ownership?: OwnershipAdmission;
}) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    if (!memory.history.getContextSelection || !memory.history.putContextSelection) return yield* Effect.fail(new ContextFailure("capability_unqualified"));
    const turnId = identity.parent?.turnId ?? `maintenance:${identity.operationId}`;
    const turnIdentity = { hostEpoch: identity.hostEpoch, agentId: identity.agentId, turnId };
    const key = turnKey(turnIdentity);
    // A real parent STEP can be checked without manufacturing one for manual
    // maintenance or for an input that has not entered main admission yet.
    const stepIdentity = identity.parent?.stepId ? { ...turnIdentity, stepId: identity.parent.stepId } : undefined;
    const result = yield* modifyExecutionState<ContextSelectionCapture | ContextFailure, unknown, ConfigurationRead>(memory, stepIdentity ?? key, state => Effect.gen(function* () {
      if (state.serviceEpoch !== identity.serviceEpoch.incarnationId) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const archived = yield* memory.history.getTurn(key);
      const known = state.bindings.get(key) ?? archived?.binding;
      const turn = state.turns.get(key) ?? archived?.turn;
      if (turn && (turn.lifecycle !== "open" || turn.expired || turn.serviceEpoch !== identity.serviceEpoch.incarnationId)) {
        return yield* Effect.fail(new ContextFailure("not_admitted"));
      }
      if (stepIdentity) {
        const stepKey = ledgerKey(stepIdentity);
        const step = state.ledger.get(stepKey) ?? (yield* memory.history.getStep(stepKey));
        if (state.cancelled.has(stepKey) || step && step.status !== "active") return yield* Effect.fail(new ContextFailure("cancelled"));
        const activeStep = state.turnActive.get(key);
        if (activeStep && activeStep !== stepIdentity.stepId) return yield* Effect.fail(new ContextFailure("maintenance_busy"));
      }
      if (known && (canonicalJson(known.hostEpoch) !== canonicalJson(identity.hostEpoch)
        || known.serviceEpoch.incarnationId !== identity.serviceEpoch.incarnationId
        || canonicalJson(known.selection) !== canonicalJson(identity.selection))) return yield* Effect.fail(new ContextFailure("not_admitted"));
      if (known && witness?.ownership && (known.ownership.scopeId !== witness.ownership.scopeId || known.ownership.serverId !== witness.ownership.serverId)) {
        // Persist revocation in the original TURN domain. A later authority read
        // changing back must not make a previously rejected TURN executable.
        const prior = coldTurn(state, key) ?? archived;
        if (!prior) return yield* Effect.fail(new ContextFailure("not_admitted"));
        const revoked = { ...prior, turn: { ...prior.turn, lifecycle: "revoked" as const } };
        yield* memory.history.putTurn(key, revoked);
        state.turns.set(key, revoked.turn);
        return [new ContextFailure("not_admitted"), state] as const;
      }
      const previous = yield* memory.history.getContextSelection!(key);
      if (previous && (canonicalJson(previous.hostEpoch) !== canonicalJson(identity.hostEpoch)
        || previous.serviceEpoch.incarnationId !== identity.serviceEpoch.incarnationId
        || canonicalJson(previous.selection) !== canonicalJson(identity.selection))) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const expectedFingerprint = known?.fingerprint ?? previous?.authFingerprint;
      if (known && previous?.authFingerprint !== undefined && previous.authFingerprint !== known.fingerprint) {
        return yield* Effect.fail(new ContextFailure("auth_mismatch"));
      }
      const fingerprint = witness?.authFingerprint;
      if (fingerprint !== undefined && (typeof fingerprint !== "string" || !fingerprint || fingerprint.length > 256
        || /[\x00-\x1f]/.test(fingerprint) || expectedFingerprint !== undefined && expectedFingerprint !== fingerprint)) {
        return yield* Effect.fail(new ContextFailure("auth_mismatch"));
      }
      if (previous) {
        const authFingerprint = expectedFingerprint ?? fingerprint;
        const next = authFingerprint === undefined ? previous : { ...previous, authFingerprint };
        if (canonicalJson(next) !== canonicalJson(previous)) yield* memory.history.putContextSelection!(key, next);
        return [next, state] as const;
      }
      const config = yield* ConfigurationRead;
      const snapshot = yield* config.snapshot();
      const captured = known ? { kind: "managed" as const, ...known.selection } : captureManagedSelection(snapshot.models, identity.agentId);
      if (captured.kind !== "managed" || captured.modelId !== identity.selection.modelId
        || captured.selectionRevision !== identity.selection.selectionRevision) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const model = known?.model ?? modelForAgent(snapshot.models, identity.agentId);
      if (!model) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const policy = known?.contextPolicy ?? captureContextPolicy(snapshot.context, model.id, identity.agentId);
      const authFingerprint = expectedFingerprint ?? fingerprint;
      const next: ContextSelectionCapture = { version: 1, hostEpoch: identity.hostEpoch, serviceEpoch: identity.serviceEpoch,
        agentId: identity.agentId, turnId, selection: identity.selection, model, policy,
        ...(authFingerprint !== undefined ? { authFingerprint } : {}) };
      yield* memory.history.putContextSelection!(key, next);
      // A capture is not main admission and does not occupy/claim any STEP.
      return [next, state] as const;
    }));
    if (result instanceof ContextFailure) return yield* Effect.fail(result);
    return result;
  }).pipe(Effect.mapError(error => error instanceof ContextFailure ? error : new ContextFailure("not_admitted")));
}
