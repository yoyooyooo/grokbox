import { Clock, Effect } from "effect";
import { ConfigurationRead } from "../../ports.ts";
import { captureManagedSelection, modelForAgent } from "../../selection.ts";
import { captureContextPolicy } from "../config/context-policy.ts";
import { ContextFailure, type ContextMaintenanceIdentity, type ContextSelectionCapture } from "../contract/context-maintenance.ts";
import { canonicalJson } from "../../hash.ts";
import { InferenceMemory, modifyExecutionState, turnKey } from "./route-binding.ts";

/** The same TURN lock as main admission, not a second selection store/reader.
 * Captures policy before Host preflight and survives cooling; never pins a fake STEP. */
export function captureContextSelection(identity: ContextMaintenanceIdentity) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    if (!memory.history.getContextSelection || !memory.history.putContextSelection) return yield* Effect.fail(new ContextFailure("capability_unqualified"));
    const turnId = identity.parent?.turnId ?? `maintenance:${identity.operationId}`;
    const key = turnKey({ hostEpoch: identity.hostEpoch, agentId: identity.agentId, turnId });
    return yield* modifyExecutionState(memory, key, state => Effect.gen(function* () {
      if (state.serviceEpoch !== identity.serviceEpoch.incarnationId) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const previous = yield* memory.history.getContextSelection!(key);
      const known = state.bindings.get(key) ?? (yield* memory.history.getTurn(key))?.binding;
      if (previous) {
        if (canonicalJson(previous.hostEpoch) !== canonicalJson(identity.hostEpoch)
          || previous.serviceEpoch.incarnationId !== identity.serviceEpoch.incarnationId
          || canonicalJson(previous.selection) !== canonicalJson(identity.selection)) return yield* Effect.fail(new ContextFailure("not_admitted"));
        return [previous, state] as const;
      }
      const config = yield* ConfigurationRead;
      const snapshot = yield* config.snapshot();
      const captured = known ? { kind: "managed" as const, ...known.selection } : captureManagedSelection(snapshot.models, identity.agentId);
      if (captured.kind !== "managed" || captured.modelId !== identity.selection.modelId
        || captured.selectionRevision !== identity.selection.selectionRevision) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const model = known?.model ?? modelForAgent(snapshot.models, identity.agentId);
      if (!model) return yield* Effect.fail(new ContextFailure("not_admitted"));
      const policy = captureContextPolicy(snapshot.context, model.id, identity.agentId);
      const next: ContextSelectionCapture = { version: 1, hostEpoch: identity.hostEpoch, serviceEpoch: identity.serviceEpoch,
        agentId: identity.agentId, turnId, selection: identity.selection, model, policy };
      yield* memory.history.putContextSelection!(key, next);
      // A capture is not main admission and does not occupy/claim any STEP.
      return [next, state] as const;
    })).pipe(Effect.mapError(error => error instanceof ContextFailure ? error : new ContextFailure("not_admitted")));
  });
}
