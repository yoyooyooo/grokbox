import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { BoxRuntimeError, OWNED_SHUTDOWN_MS } from "@grokbox/runtime-kernel/contract";
import { AdmissionAuthority } from "@grokbox/runtime-kernel/ports";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { configurationReadLayer, openRuntimeStore } from "../io/configuration.node.ts";
import { createLiveBackendAuth } from "../io/credentials.node.ts";
import { modeldStorePorts } from "../io/store.node.ts";
import { writeModeldStepOutcome } from "../io/modeld-outcome.node.ts";
import { dispatchingModelBackendLayer } from "../backends/dispatch.ts";
import { probeModeldHealth, modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { serveModeld } from "../modeld/server.node.ts";
import { sameConnectionHostCompactLayer } from "../modeld/same-connection-compact.ts";
import type { ListenHooks, ReleaseStatus, ResourceCounts } from "../modeld/unix-listen.node.ts";

/** Fail-closed: only store `committed` route+attestation+host is admitted. */
export function liveAdmissionAuthorityLayer(durableRoot: string, runRoot: string): Layer.Layer<AdmissionAuthority> {
  return Layer.succeed(AdmissionAuthority, {
    current: () => Effect.promise(async () => {
      try {
        const authority = await modeldStorePorts(durableRoot, runRoot).authority();
        return { admitted: authority.state === "committed" };
      } catch {
        return { admitted: false };
      }
    }),
  });
}

export function admitAllAuthorityLayer(): Layer.Layer<AdmissionAuthority> {
  return Layer.succeed(AdmissionAuthority, {
    current: () => Effect.succeed({ admitted: true }),
  });
}

export const MODELD_HOST_COMPACT_ENV = "GROKBOX_MODELD_HOST_COMPACT";

/** Explicit opt-in only. Any other value, including unset, keeps HostCompact off. Omitted env follows process.env so live `runtime modeld run` can set/read GATE=1. */
export function modeldHostCompactEnabled(env: NodeJS.Dict<string> = process.env): boolean {
  return env[MODELD_HOST_COMPACT_ENV] === "1";
}

/** Production attach for ensure/start. Undefined unless the env gate is exactly `1`. */
export function modeldCompactForIncoming(env: NodeJS.Dict<string> = process.env) {
  return modeldHostCompactEnabled(env) ? sameConnectionHostCompactLayer : undefined;
}

function compactAttach(env: NodeJS.Dict<string> = process.env) {
  const compactForIncoming = modeldCompactForIncoming(env);
  return compactForIncoming ? { compactForIncoming } : {};
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
  runRoot: string;
  env?: NodeJS.Dict<string>;
  serviceEpoch: string;
  fetch?: typeof fetch;
}) {
  const store = openRuntimeStore(options.durableRoot, options.env);
  const config = configurationReadLayer(store);
  const auth = createLiveBackendAuth(options.env ?? {});
  const backend = dispatchingModelBackendLayer(options.fetch ?? globalThis.fetch, auth.unseal);
  return config.pipe(
    Layer.merge(liveAdmissionAuthorityLayer(options.durableRoot, options.runRoot)),
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
      runRoot: options.runRoot,
      env: options.env,
      serviceEpoch: generation,
      fetch: options.fetch,
    });
    yield* Effect.gen(function* () {
      yield* serveModeld({
        path,
        generation,
        observeStep: (request, outcome) => writeModeldStepOutcome(options.runRoot, request, outcome),
        counts: options.counts,
        hooks: options.hooks,
        maxClients: options.maxClients,
        ...compactAttach(options.env ?? process.env),
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
  const release: ReleaseStatus = options.hooks?.release ?? { ok: true };
  const hooks: ListenHooks = { ...options.hooks, release };
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
      runRoot: options.runRoot,
      env: options.env,
      serviceEpoch: generation,
      fetch: options.fetch,
    });
    yield* Effect.gen(function* () {
      yield* serveModeld({
        path,
        generation,
        observeStep: (request, outcome) => writeModeldStepOutcome(options.runRoot, request, outcome),
        counts: options.counts,
        hooks,
        maxClients: options.maxClients,
        ...compactAttach(options.env ?? process.env),
      });
      yield* Deferred.succeed(ready, { kind: "owned", path, generation });
      yield* Effect.never;
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.tapError((error) => Deferred.isDone(ready).pipe(
    Effect.flatMap((done) => done ? Effect.void : Deferred.fail(ready, error instanceof Error ? error : new Error(String(error)))),
  )))));
  const ensure = await Effect.runPromise(Deferred.await(ready));
  return {
    ensure,
    stop: async () => {
      await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(
          Effect.timeout(`${OWNED_SHUTDOWN_MS} millis`),
          Effect.catchCause(() => Effect.void),
        ),
      );
      if (!release.ok) throw new Error("cleanup_gap");
      if (options.counts && options.counts.listeners > 0) throw new Error("cleanup_gap");
    },
  };
}
