import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import type { Server } from "node:net";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { BoxRuntimeError, OWNED_SHUTDOWN_MS, AUTHORITY_REASONS, providerRecoveryFromEnv, streamFailureDiagnostic, type AdmissionAuthorityResult, type AuthorityDiagnostic } from "@grokbox/runtime-kernel/contract";
import { AdmissionAuthority, type AuthorityReadControl } from "@grokbox/runtime-kernel/ports";
import type { RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { piCompactionAlgorithmLayer } from "../context/pi-compaction.ts";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { configurationReadLayer, openRuntimeStore } from "../io/configuration.node.ts";
import { createLiveBackendAuth } from "../io/credentials.node.ts";
import { modeldStorePorts } from "../io/store.node.ts";
import { type OwnershipReader } from "../io/ownership-admission.node.ts";
import { makeOwnershipCoordinator } from "../io/ownership-coordinator.node.ts";
import { writeModeldStepOutcome, writeModeldRecoveryProgress, writeModeldAuthorityProgress } from "../io/modeld-outcome.node.ts";
import { openExecutionHistory } from "../io/execution-history.node.ts";
import { openBoundedProcessLog, type ProcessLogEvent, type ProcessLogHealth } from "../io/bounded-process-log.node.ts";
import { noteJournalObservationTimeout } from "../host/journal-health.node.ts";
import { dispatchingModelBackendLayer } from "../backends/dispatch.ts";
import { probeModeldHealth, probeModeldIdentity, modeldRootId, modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { serveModeld } from "../modeld/server.node.ts";
import { sameConnectionHostCompactLayer } from "../modeld/same-connection-compact.ts";
import type { ListenHooks, ReleaseStatus, ResourceCounts } from "../modeld/unix-listen.node.ts";

/** Fail-closed: only store `committed` route+attestation+host is admitted. */
export function liveAdmissionAuthorityLayer(durableRoot: string, runRoot: string, ownershipRead?: OwnershipReader): Layer.Layer<AdmissionAuthority> {
  const ports = modeldStorePorts(durableRoot, runRoot);
  return Layer.effect(AdmissionAuthority, Effect.gen(function* () {
    const coordinator = yield* makeOwnershipCoordinator(ownershipRead);
    const current = (request: Pick<RunStepRequest, "hostEpoch" | "agentId">, control?: AuthorityReadControl): Effect.Effect<AdmissionAuthorityResult> => Effect.gen(function* () {
      const authority = yield* Effect.tryPromise({ try: () => ports.authority(), catch: () => "authority_unavailable" });
      if (authority.state !== "committed") return { admitted: false, reason: "authority_not_committed" } as const;
      const host = authority.host;
      if (request.hostEpoch.compile !== host.generationId || request.hostEpoch.source !== host.sourceSha
        || request.hostEpoch.hostIdentity !== host.identitySha) return { admitted: false, reason: "host_identity_mismatch" } as const;
      const observed = yield* coordinator.current({ agentId: request.agentId, gatewayPid: host.pid, hostGeneration: host.generationId }, control);
      // The native read can span a deployment: never combine two generations.
      const after = yield* Effect.tryPromise({ try: () => ports.authority(), catch: () => "authority_unavailable" });
      if (after.state !== "committed" || after.host.generationId !== host.generationId || after.host.identitySha !== host.identitySha) return { admitted: false, reason: "host_generation_changed" } as const;
      return { admitted: true as const, ownership: { ...observed.evidence,
        scopeId: sha256Text(canonicalJson([observed.evidence.scopeId, observed.gateway.pid, observed.gateway.startedAt])),
      }, evidenceId: observed.evidenceId,
        diagnostic: { authority: { reason: "unknown" as const, ownershipRead: observed.remote.readObservation,
          ownershipWait: observed.observation, readRecovery: observed.recovery } } };
    }).pipe(Effect.catch(error => {
      const reason = error instanceof BoxRuntimeError ? error.failureCode : error;
      const diagnostic = streamFailureDiagnostic(error);
      return Effect.succeed({ admitted: false as const, reason: typeof reason === "string" && (AUTHORITY_REASONS as readonly string[]).includes(reason) ? reason as AuthorityDiagnostic["reason"] : "unknown" as const,
        ...(diagnostic ? { diagnostic } : {}) });
    }));
    return { current, currentContext: current };
  }));
}

export function admitAllAuthorityLayer(): Layer.Layer<AdmissionAuthority> {
  const current = () => Effect.map(Clock.currentTimeMillis, observedAtMs => ({ admitted: true as const,
    ownership: { scopeId: "a".repeat(64), serverId: "owned-test-server", observedAtMs } }));
  return Layer.succeed(AdmissionAuthority, { current, currentContext: current });
}

/** Normal maintenance is configured per captured context policy. Native
 * capability, current ownership and the narrow recovery ledger remain mandatory. */
export function modeldCompactForIncoming() { return sameConnectionHostCompactLayer; }
function compactAttach() { return { compactForIncoming: modeldCompactForIncoming() }; }

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
    Layer.merge(piCompactionAlgorithmLayer),
    Layer.merge(Layer.unwrap(openExecutionHistory(options.runRoot, options.serviceEpoch).pipe(
      Effect.map(history => inferenceMemoryLayer({ serviceEpoch: options.serviceEpoch, history,
        providerRecovery: providerRecoveryFromEnv(options.env ?? process.env) })),
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
  | { kind: "owned"; path: string; generation: string; processLog?: ProcessLogHealth };

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
  return modeldServiceLifetime(options);
}

/** One acquisition program for the Effect and Promise host entrypoints. The
 * caller owns its root Scope; readiness is observation, not another lifecycle.
 * See Spec S10 / T44. */
function modeldServiceLifetime(options: ModeldRootOptions, ready: (value: ModeldEnsure) => Effect.Effect<void> = () => Effect.void) {
  return Effect.gen(function* () {
    const path = modeldSocketPath(options.runRoot);
    const healthy = yield* Effect.promise(() => probeModeldHealth(options.runRoot, 200));
    if (healthy) {
      const borrowed = yield* borrowModeld(options);
      yield* ready(borrowed);
      return borrowed;
    }
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
        observeRecovery: (request, recovery) => writeModeldRecoveryProgress(options.runRoot, request, recovery),
        observeAuthority: (request, authority, observedAt) => writeModeldAuthorityProgress(options.runRoot, request, authority, observedAt),
        onObservationTimeout: () => noteJournalObservationTimeout(options.runRoot, "modeld"),
        counts: options.counts,
        hooks: options.hooks,
        maxClients: options.maxClients,
        env: options.env ?? process.env,
        ...compactAttach(),
      });
      if (!listener.server.listening) return yield* Effect.fail(new BoxRuntimeError("invalid_usage", "modeld_listener_closed"));
      // Acquire only AFTER the real listener: a borrower or failed competing
      // owner must never rotate the active service's diagnostics. Scoped release
      // closes this writer before the listener removes its own socket.
      const processLog = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => openBoundedProcessLog({ runRoot: options.runRoot, generation, nowMs: Date.now() }), catch: () => "process_log_unavailable" })
          .pipe(Effect.catch(() => Effect.succeed(undefined))),
        log => log ? Effect.tryPromise({ try: () => log.close(), catch: () => "process_log_close_failed" }).pipe(Effect.catch(() => Effect.void)) : Effect.void,
      );
      const note = (event: ProcessLogEvent) => Effect.gen(function* () {
        const atMs = yield* Clock.currentTimeMillis;
        if (processLog) yield* Effect.uninterruptible(Effect.tryPromise({ try: () => processLog.append({ event, atMs }), catch: () => "process_log_write_failed" })).pipe(Effect.catch(() => Effect.void));
      });
      yield* note("ready");
      yield* ready({ kind: "owned", path, generation, processLog: processLog?.health() ?? {
        state: "unavailable", writtenRecords: 0, droppedRecords: 0, rotations: 0, reason: "storage_unavailable",
      } });
      yield* listenerLifetime(listener.server).pipe(Effect.onExit(exit =>
        note(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? "shutdown_requested" : "listener_failed"),
      ));
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
  const fiber = Effect.runFork(Effect.scoped(modeldServiceLifetime(
    { ...options, hooks }, value => Deferred.succeed(ready, value).pipe(Effect.asVoid),
  )).pipe(Effect.onExit(exit => Deferred.isDone(ready).pipe(
    // Complete failure only after the resource Scope has finalized. tapError
    // inside the Scope missed defects/interruption and could leave callers
    // waiting forever even though startup had already stopped.
    Effect.flatMap(done => done ? Effect.void : Exit.isFailure(exit)
      ? Deferred.failCause(ready, exit.cause)
      : Deferred.fail(ready, new BoxRuntimeError("invalid_usage", "modeld_stopped_before_ready"))),
  ))), { signal: options.signal });
  const ensure = await Effect.runPromise(Deferred.await(ready));
  const finished = Effect.runPromise(Fiber.await(fiber)).then(exit => {
    if (ensure.kind === "owned" && !release.ok) throw new BoxRuntimeError("invalid_usage", "cleanup_gap");
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
      if (Exit.isFailure(stopped)) throw new Error("cleanup_gap");
      // A borrower did not acquire this listener. Shared diagnostic counters
      // can legitimately still describe its external owner's live resources.
      if (ensure.kind === "owned" && (!release.ok || options.counts && options.counts.listeners > 0)) {
        throw new Error("cleanup_gap");
      }
    },
  };
}
