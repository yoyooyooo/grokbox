import { Effect } from "effect";
import { ModelConfiguration } from "@grokbox/runtime-kernel/ports";
import { runModelChange } from "@grokbox/runtime-kernel/commands";
import type { ModelCaller } from "@grokbox/runtime-kernel/model-management";
import { managedModelAdmission } from "@grokbox/box-runtime/runtime";
import { HttpFailure } from "./access.ts";

/** A submitted command outlives the HTTP connection, not the Server Scope.
 * Shutdown aborts authority waits and joins the original durable settlement. */
export function ownedModelChange(caller: ModelCaller, input: unknown,
  admission: Parameters<typeof managedModelAdmission>[0], authorize?: (signal: AbortSignal) => Promise<void>) {
  return Effect.scoped(Effect.gen(function* () {
    if (!authorize) return yield* Effect.fail(new HttpFailure(503, "unavailable", "The model publication authority is unavailable."));
    const store = yield* ModelConfiguration;
    const task = yield* Effect.acquireRelease(Effect.sync(() => {
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      const promise = Effect.runPromise(runModelChange(caller, input, managedModelAdmission({ ...admission, publication: { signal, authorize } }))
        .pipe(Effect.provideService(ModelConfiguration, store)), { signal });
      void promise.catch(() => undefined);
      return { controller, promise };
    }), task => Effect.promise(async () => { task.controller.abort(); await task.promise.catch(() => undefined); }));
    return yield* Effect.tryPromise({ try: () => task.promise, catch: error => error });
  }));
}
