import { Effect } from "effect";
import { ModelConfiguration } from "../../ports.ts";
import { ModelManagementError, modelOperationLocator, modelOperationKey, parseModelChangeRequest, applyModelChange, type ModelCaller, type ModelChange, type ModelPublicationCheck } from "../../model-management.ts";
import type { ModelsFile } from "../../selection.ts";

export function readModelOperation(caller: ModelCaller, requestId: string) {
  return Effect.gen(function* () {
    const locator = yield* Effect.try({ try: () => modelOperationLocator(caller, requestId), catch: error => error as ModelManagementError });
    return yield* (yield* ModelConfiguration).lookup(locator);
  });
}
/** Authentication belongs to the caller boundary. Replay precedes first-use
 * admission; a lost response survives later revision and ownership changes. */
export function runModelChange(caller: ModelCaller, input: unknown, admit: (change: ModelChange, next: ModelsFile) => Effect.Effect<void | ModelPublicationCheck, unknown>) {
  return Effect.gen(function* () {
    const request = yield* Effect.try({ try: () => parseModelChangeRequest(input), catch: error => error as ModelManagementError });
    const key = yield* Effect.try({ try: () => modelOperationKey(caller, request), catch: error => error as ModelManagementError });
    const store = yield* ModelConfiguration;
    const previous = yield* store.lookup(key);
    if (previous) return previous;
    const current = yield* store.read();
    if (current.revision !== request.expectedRevision) return yield* Effect.fail(new ModelManagementError("revision_conflict", "Model configuration changed; reread before submitting a new request."));
    const next = yield* Effect.try({ try: () => applyModelChange(current.models, request.change), catch: error => error as ModelManagementError });
    const beforePublish = yield* admit(request.change, next);
    return yield* store.commit(key, current, next, request.change, beforePublish || undefined);
  });
}
