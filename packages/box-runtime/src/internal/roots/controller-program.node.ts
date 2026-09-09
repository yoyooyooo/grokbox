import { Effect, Layer } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { ControlResources, type ControllerReceipt, type ControllerRequest } from "@grokbox/runtime-kernel/ports";

/** Live default: inspect-capable, mutation always fail-closed. No SIGCONT/spawn on this box. */
export function liveControlResourcesLayer(): Layer.Layer<ControlResources> {
  return Layer.succeed(ControlResources, {
    lease: (_input: { operationId: string }) => Effect.acquireRelease(
      Effect.succeed({ duplicate: false }),
      () => Effect.void,
    ),
    preflight: (_input: ControllerRequest) => Effect.succeed({ ok: false, reason: "preflight-incomplete" }),
    recheck: (_input: ControllerRequest) => Effect.succeed({ ok: false, reason: "preflight-incomplete" }),
    signal: (_input: ControllerRequest) => Effect.succeed({ signaled: false }),
    spawn: (_input: ControllerRequest) => Effect.succeed({ spawned: false }),
    armGuardian: (_input: ControllerRequest) => Effect.succeed({ guardian: false }),
    wait: (_input: ControllerRequest) => Effect.void,
    commit: (_input: ControllerRequest) => Effect.succeed({ committed: false }),
  });
}

export async function startControlOperation(request: ControllerRequest): Promise<ControllerReceipt> {
  return Effect.runPromise(
    Effect.scoped(runControllerOperation(request).pipe(Effect.provide(liveControlResourcesLayer()))),
  );
}
