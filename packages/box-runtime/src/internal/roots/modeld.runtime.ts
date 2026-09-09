import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { AdmissionAuthority } from "@grokbox/runtime-kernel/ports";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { configurationReadLayer, openRuntimeStore } from "../io/configuration.node.ts";
import { echoModelBackendLayer } from "../backends/echo.ts";
import { liveBackendAuthLayer } from "../io/credentials.node.ts";
import { probeModeldHealth, modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { serveModeld } from "../modeld/server.node.ts";
import type { ListenHooks, ResourceCounts } from "../modeld/unix-listen.node.ts";

export function liveAdmissionAuthorityLayer(): Layer.Layer<AdmissionAuthority> {
  return Layer.succeed(AdmissionAuthority, {
    current: () => Effect.succeed({ admitted: true }),
  });
}

export type ModeldRootOptions = {
  durableRoot: string;
  runRoot: string;
  env?: NodeJS.Dict<string>;
  counts?: ResourceCounts;
  hooks?: ListenHooks;
};

export function modeldRootLayer(options: { durableRoot: string; env?: NodeJS.Dict<string>; serviceEpoch: string }) {
  const store = openRuntimeStore(options.durableRoot, options.env);
  return configurationReadLayer(store).pipe(
    Layer.merge(liveAdmissionAuthorityLayer()),
    Layer.merge(echoModelBackendLayer),
    Layer.merge(liveBackendAuthLayer(options.env ?? {})),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: options.serviceEpoch })),
  );
}

export type ModeldEnsure =
  | { kind: "borrowed"; path: string }
  | { kind: "owned"; path: string; generation: string };

export function ensureModeld(options: ModeldRootOptions) {
  return Effect.gen(function* () {
    const path = modeldSocketPath(options.runRoot);
    const healthy = yield* Effect.promise(() => probeModeldHealth(options.runRoot, 200));
    if (healthy) return { kind: "borrowed" as const, path };
    if (existsSync(path)) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld socket exists"));
    }
    const generation = randomUUID();
    const layer = modeldRootLayer({
      durableRoot: options.durableRoot,
      env: options.env,
      serviceEpoch: generation,
    });
    yield* serveModeld({
      path,
      generation,
      counts: options.counts,
      hooks: options.hooks,
    }).pipe(Effect.provide(layer));
    return { kind: "owned" as const, path, generation };
  });
}

export type StartedModeld = {
  ensure: ModeldEnsure;
  stop: () => Promise<void>;
};

export async function startModeldProcess(options: ModeldRootOptions): Promise<StartedModeld> {
  const ready = await Effect.runPromise(Deferred.make<ModeldEnsure, Error>());
  const fiber = Effect.runFork(Effect.scoped(
    ensureModeld(options).pipe(
      Effect.tap((ensure) => Deferred.succeed(ready, ensure)),
      Effect.flatMap((ensure) => ensure.kind === "owned" ? Effect.never : Effect.void),
      Effect.catchCause((cause) => Deferred.fail(ready, new Error(String(cause)))),
    ),
  ));
  const ensure = await Effect.runPromise(Deferred.await(ready));
  return {
    ensure,
    stop: async () => {
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}
