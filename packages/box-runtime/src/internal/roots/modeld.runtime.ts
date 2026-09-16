import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import type { Server } from "node:net";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BoxRuntimeError, OWNED_SHUTDOWN_MS, AUTHORITY_REASONS } from "@grokbox/runtime-kernel/contract";
import { AdmissionAuthority } from "@grokbox/runtime-kernel/ports";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { configurationReadLayer, openRuntimeStore } from "../io/configuration.node.ts";
import { createLiveBackendAuth } from "../io/credentials.node.ts";
import { modeldStorePorts } from "../io/store.node.ts";
import { readManagedOwnership, type OwnershipReader } from "../io/ownership-admission.node.ts";
import { writeModeldStepOutcome } from "../io/modeld-outcome.node.ts";
import { openExecutionHistory } from "../io/execution-history.node.ts";
import { noteJournalObservationTimeout } from "../host/journal-health.node.ts";
import { dispatchingModelBackendLayer } from "../backends/dispatch.ts";
import { probeModeldHealth, probeModeldIdentity, modeldRootId, modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { serveModeld } from "../modeld/server.node.ts";
import { sameConnectionHostCompactLayer } from "../modeld/same-connection-compact.ts";
import type { ListenHooks, ReleaseStatus, ResourceCounts } from "../modeld/unix-listen.node.ts";

/** Fail-closed: only store `committed` route+attestation+host is admitted. */
export function liveAdmissionAuthorityLayer(durableRoot: string, runRoot: string, ownershipRead?: OwnershipReader): Layer.Layer<AdmissionAuthority> {
  const ports = modeldStorePorts(durableRoot, runRoot);
  return Layer.succeed(AdmissionAuthority, {
    current: (request) => Effect.gen(function* () {
      const authority = yield* Effect.tryPromise({ try: () => ports.authority(), catch: () => "authority_unavailable" });
      if (authority.state !== "committed") return { admitted: false, reason: "authority_not_committed" };
      if (!request) return { admitted: true };
      const host = authority.host;
      if (request.hostEpoch.compile !== host.generationId || request.hostEpoch.source !== host.sourceSha
        || request.hostEpoch.hostIdentity !== host.identitySha) return { admitted: false, reason: "host_identity_mismatch" };
      const observed = yield* readManagedOwnership({ agentId: request.agentId, read: ownershipRead, gatewayPid: host.pid });
      // The native read can span a deployment: never combine two generations.
      const after = yield* Effect.tryPromise({ try: () => ports.authority(), catch: () => "authority_unavailable" });
      if (after.state !== "committed" || after.host.generationId !== host.generationId || after.host.identitySha !== host.identitySha) return { admitted: false, reason: "host_generation_changed" };
      return { admitted: true, ownership: { ...observed.evidence,
        scopeId: sha256Text(canonicalJson([observed.evidence.scopeId, observed.gateway.pid, observed.gateway.startedAt])),
      } };
    }).pipe(Effect.catch(error => {
      const reason = error instanceof BoxRuntimeError ? error.failureCode : error;
      return Effect.succeed({ admitted: false, reason: typeof reason === "string" && (AUTHORITY_REASONS as readonly string[]).includes(reason) ? reason : "unknown" });
    })),
  });
}

export function admitAllAuthorityLayer(): Layer.Layer<AdmissionAuthority> {
  return Layer.succeed(AdmissionAuthority, {
    current: () => Effect.map(Clock.currentTimeMillis, observedAtMs => ({ admitted: true,
      ownership: { scopeId: "a".repeat(64), serverId: "owned-test-server", observedAtMs } })),
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
  ownershipRead?: OwnershipReader;
  /** The command/root lifetime, not a request or browser subscription. Borrowed
   * services are never interrupted by this signal. */
  signal?: AbortSignal;
};

export function modeldRootLayer(options: {
  durableRoot: string;
  runRoot: string;
  env?: NodeJS.Dict<string>;
  serviceEpoch: string;
  fetch?: typeof fetch;
  ownershipRead?: OwnershipReader;
}) {
  const store = openRuntimeStore(options.durableRoot, options.env);
  const config = configurationReadLayer(store);
  const auth = createLiveBackendAuth(options.env ?? {}, {
    homedir: homedir(),
    durableRoot: options.durableRoot,
  });
  const backend = dispatchingModelBackendLayer(options.fetch ?? globalThis.fetch, auth.unseal);
  return config.pipe(
    Layer.merge(liveAdmissionAuthorityLayer(options.durableRoot, options.runRoot, options.ownershipRead)),
    Layer.merge(auth.layer),
    Layer.merge(backend),
    Layer.merge(Layer.unwrap(openExecutionHistory(options.runRoot, options.serviceEpoch).pipe(
      Effect.map(history => inferenceMemoryLayer({ serviceEpoch: options.serviceEpoch, history })),
    ))),
  );
}

/** The wait unregisters callbacks before normal listener finalization. */
function listenerLifetime(server: Server): Effect.Effect<never, BoxRuntimeError> {
  return Effect.callback<never, BoxRuntimeError>(resume => {
    const closed = () => resume(Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_listener_closed")));
    const failed = () => resume(Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_listener_error")));
    if (!server.listening) { closed(); return; }
    server.once("close", closed);
    server.once("error", failed);
    return Effect.sync(() => { server.off("close", closed); server.off("error", failed); });
  });
}

export type ModeldEnsure =
  | { kind: "borrowed"; path: string; generation?: string }
  | { kind: "owned"; path: string; generation: string };

/** A responsive old/foreign service is not proof that it consumes this root.
 * Refuse instead of rewriting configuration under another service's socket. */
function borrowModeld(options: ModeldRootOptions) {
  return Effect.gen(function* () {
    const identity = yield* Effect.promise(() => probeModeldIdentity(options.runRoot, 500));
    if (!identity) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_identity_unavailable"));
    if (identity.rootId !== modeldRootId(options.durableRoot, options.runRoot)) {
      return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_root_mismatch"));
    }
    return { kind: "borrowed" as const, path: modeldSocketPath(options.runRoot), generation: identity.generation };
  });
}

export function ensureModeld(options: ModeldRootOptions) {
  return Effect.gen(function* () {
    const path = modeldSocketPath(options.runRoot);
    const healthy = yield* Effect.promise(() => probeModeldHealth(options.runRoot, 200));
    if (healthy) return yield* borrowModeld(options);
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
      ownershipRead: options.ownershipRead,
    });
    yield* Effect.gen(function* () {
      const listener = yield* serveModeld({
        path,
        generation,
        rootId: modeldRootId(options.durableRoot, options.runRoot),
        observeStep: (request, outcome) => writeModeldStepOutcome(options.runRoot, request, outcome),
        onObservationTimeout: () => noteJournalObservationTimeout(options.runRoot),
        counts: options.counts,
        hooks: options.hooks,
        maxClients: options.maxClients,
        env: options.env ?? process.env,
        ...compactAttach(options.env ?? process.env),
      });
      yield* listenerLifetime(listener.server);
    }).pipe(Effect.provide(layer));
    return { kind: "owned" as const, path, generation };
  });
}

export type StartedModeld = {
  ensure: ModeldEnsure;
  /** This acquired lifetime, not the borrowed external owner's lifetime.
   * Settles after Scope cleanup; unexpected service loss rejects. */
  finished: Promise<void>;
  stop: () => Promise<void>;
};

export async function startModeldProcess(options: ModeldRootOptions): Promise<StartedModeld> {
  const ready = await Effect.runPromise(Deferred.make<ModeldEnsure, Error>());
  const release: ReleaseStatus = options.hooks?.release ?? { ok: true };
  const hooks: ListenHooks = { ...options.hooks, release };
  // runFork may be interrupted before evaluating its first instruction when the
  // signal is already aborted. Refuse before starting that otherwise-unobserved
  // fiber so the public ready promise cannot be left pending forever.
  if (options.signal?.aborted) throw new BoxRuntimeError("invalid_usage", "modeld_start_cancelled");
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    const path = modeldSocketPath(options.runRoot);
    const healthy = yield* Effect.promise(() => probeModeldHealth(options.runRoot, 200));
    if (healthy) {
      yield* Deferred.succeed(ready, yield* borrowModeld(options));
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
      ownershipRead: options.ownershipRead,
    });
    yield* Effect.gen(function* () {
      const listener = yield* serveModeld({
        path,
        generation,
        rootId: modeldRootId(options.durableRoot, options.runRoot),
        observeStep: (request, outcome) => writeModeldStepOutcome(options.runRoot, request, outcome),
        onObservationTimeout: () => noteJournalObservationTimeout(options.runRoot),
        counts: options.counts,
        hooks,
        maxClients: options.maxClients,
        env: options.env ?? process.env,
        ...compactAttach(options.env ?? process.env),
      });
      if (!listener.server.listening) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_listener_closed"));
      yield* Deferred.succeed(ready, { kind: "owned", path, generation });
      yield* listenerLifetime(listener.server);
    }).pipe(Effect.provide(layer));
  })).pipe(Effect.onExit(exit => Deferred.isDone(ready).pipe(
    // Complete failure only after the resource Scope has finalized. tapError
    // inside the Scope missed defects/interruption and could leave callers
    // waiting forever even though startup had already stopped.
    Effect.flatMap(done => done ? Effect.void : Exit.isFailure(exit)
      ? Deferred.failCause(ready, exit.cause)
      : Deferred.fail(ready, new BoxRuntimeError("invalid_usage", "modeld_stopped_before_ready"))),
  ))), { signal: options.signal });
  const ensure = await Effect.runPromise(Deferred.await(ready));
  const finished = Effect.runPromise(Fiber.await(fiber)).then(exit => {
    if (!release.ok) throw new BoxRuntimeError("invalid_usage", "cleanup_gap");
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
  });
  // The lifetime can end while the caller is still publishing readiness.
  void finished.catch(() => undefined);
  return {
    ensure, finished,
    stop: async () => {
      const stopped = await Effect.runPromise(Effect.exit(
        Fiber.interrupt(fiber).pipe(Effect.timeout(`${OWNED_SHUTDOWN_MS} millis`)),
      ));
      // Optional counters are diagnostics, not proof that a timed-out finalizer
      // completed. A later caller may wait again, but this receipt stays a gap.
      if (Exit.isFailure(stopped) || !release.ok) throw new Error("cleanup_gap");
      if (options.counts && options.counts.listeners > 0) throw new Error("cleanup_gap");
    },
  };
}
