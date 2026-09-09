import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { BoxRuntimeError, OWNED_SHUTDOWN_MS } from "@grokbox/runtime-kernel/contract";
import { AdmissionAuthority, ConfigurationRead } from "@grokbox/runtime-kernel/ports";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { configurationReadLayer, openRuntimeStore } from "../io/configuration.node.ts";
import { createLiveBackendAuth } from "../io/credentials.node.ts";
import { dispatchingModelBackendLayer } from "../backends/dispatch.ts";
import { probeModeldHealth, modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { serveModeld } from "../modeld/server.node.ts";
import type { ListenHooks, ResourceCounts } from "../modeld/unix-listen.node.ts";

/** Fail-closed: only desired.mode=route is admitted. Missing/disabled/unavailable → not admitted. */
export function liveAdmissionAuthorityLayer(): Layer.Layer<AdmissionAuthority, never, ConfigurationRead> {
  return Layer.effect(AdmissionAuthority, Effect.gen(function* () {
    const config = yield* ConfigurationRead;
    return {
      current: () => Effect.gen(function* () {
        const snap = yield* config.snapshot().pipe(Effect.result);
        if (snap._tag === "Failure") return { admitted: false };
        if (snap.success.desired.mode !== "route") return { admitted: false };
        return { admitted: true };
      }),
    };
  }));
}

export type ModeldRootOptions = {
  durableRoot: string;
  runRoot: string;
  env?: NodeJS.Dict<string>;
  fetch?: typeof fetch;
  counts?: ResourceCounts;
  hooks?: ListenHooks;
  maxClients?: number;
};

export function modeldRootLayer(options: {
  durableRoot: string;
  env?: NodeJS.Dict<string>;
  serviceEpoch: string;
  fetch?: typeof fetch;
}) {
  const store = openRuntimeStore(options.durableRoot, options.env);
  const config = configurationReadLayer(store);
  const auth = createLiveBackendAuth(options.env ?? {});
  const deny = Object.assign(async () => {
    throw new Error("modeld root has no fetch");
  }, { preconnect: async () => undefined }) as typeof fetch;
  const backend = dispatchingModelBackendLayer(options.fetch ?? deny, auth.unseal);
  return config.pipe(
    Layer.merge(liveAdmissionAuthorityLayer().pipe(Layer.provideMerge(config))),
    Layer.merge(auth.layer),
    Layer.merge(backend),
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
      fetch: options.fetch,
    });
    yield* Effect.gen(function* () {
      yield* serveModeld({
        path,
        generation,
        counts: options.counts,
        hooks: options.hooks,
        maxClients: options.maxClients,
      });
      yield* Effect.never;
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
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    const path = modeldSocketPath(options.runRoot);
    const healthy = yield* Effect.promise(() => probeModeldHealth(options.runRoot, 200));
    if (healthy) {
      yield* Deferred.succeed(ready, { kind: "borrowed", path });
      return;
    }
    if (existsSync(path)) {
      yield* Deferred.fail(ready, new BoxRuntimeError("invalid_usage", "modeld socket exists"));
      return;
    }
    const generation = randomUUID();
    const layer = modeldRootLayer({
      durableRoot: options.durableRoot,
      env: options.env,
      serviceEpoch: generation,
      fetch: options.fetch,
    });
    yield* Effect.gen(function* () {
      yield* serveModeld({
        path,
        generation,
        counts: options.counts,
        hooks: options.hooks,
        maxClients: options.maxClients,
      });
      yield* Deferred.succeed(ready, { kind: "owned", path, generation });
      yield* Effect.never;
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.catchCause((cause) => Deferred.fail(ready, new Error(String(cause)))))));
  const ensure = await Effect.runPromise(Deferred.await(ready));
  return {
    ensure,
    stop: async () => {
      await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.timeout(`${OWNED_SHUTDOWN_MS} millis`)),
      );
    },
  };
}
