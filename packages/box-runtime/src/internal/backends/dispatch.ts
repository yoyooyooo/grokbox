import { Effect, Layer, Stream } from "effect";
import { BackendFailure } from "@grokbox/runtime-kernel/contract";
import { ModelBackend, type AuthLease, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { backendKindForModel, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { echoModelBackendLayer } from "./echo.ts";
import { aiSdkModelBackendLayer, type UnsealAuth } from "./ai-sdk.ts";
import { readPreparedCall } from "./prepared.ts";

/** Exact kind dispatch. No echo fallback for openai*. */
export function dispatchingModelBackendLayer(fetchImpl: typeof fetch, unseal: UnsealAuth): Layer.Layer<ModelBackend> {
  const sdkLayer = aiSdkModelBackendLayer(fetchImpl, unseal);
  return Layer.succeed(ModelBackend, {
    prepare: (selection: unknown, snapshot: unknown) => Effect.gen(function* () {
      const kind = backendKindForModel(selection as ModelRecord);
      const layer = kind === "echo" ? echoModelBackendLayer : sdkLayer;
      return yield* Effect.gen(function* () {
        const backend = yield* ModelBackend;
        return yield* backend.prepare(selection, snapshot);
      }).pipe(Effect.provide(layer));
    }),
    infer: (admitted: unknown, prepared: PreparedCall, lease: AuthLease) => {
      const payload = readPreparedCall(prepared);
      if (!payload) return Stream.fail(new BackendFailure("invalid_prepared_call"));
      const layer = payload.kind === "echo" ? echoModelBackendLayer : sdkLayer;
      return Stream.unwrap(Effect.gen(function* () {
        const backend = yield* ModelBackend;
        return backend.infer(admitted, prepared, lease);
      }).pipe(Effect.provide(layer)));
    },
  });
}
