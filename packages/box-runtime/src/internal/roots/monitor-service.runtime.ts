import { Cause, Effect, Exit, Fiber } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";
import { readMonitorServiceConfiguration, validateMonitorRoot } from "../io/monitor-installation.node.ts";
import { monitorProgram, type MonitorRunOptions, type JournalSourceProgress } from "./monitor.runtime.ts";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { readStorageConfiguration } from "../io/storage-configuration.node.ts";

export type MonitorServiceStatus = {
  state: "not_configured" | "disabled" | "starting" | "running" | "degraded" | "blocked" | "stopping" | "stopped";
  reason: string | null; desiredRevision: string | null; collectorEpoch: string | null;
  startedAtMs: number; lastReceiptAtMs: number | null; replacements: number;
  ownershipState: "not_observed" | "observed" | "unavailable";
  targets: number; sources: JournalSourceProgress[]; notificationsEnabled: boolean | null;
  nativeRunHealth: NonNullable<Parameters<MonitorRunOptions["publish"]>[0]["nativeRunHealth"]>;
  owner: "management-server"; createsDatabase: boolean; notifiesDirectly: false; bootInstalled: false;
};
export type MonitorServiceInput = { durableRoot: string; read: OwnershipReader };
/** One management-Server-owned Scope. Configuration polling is local-only; there is at most
 * one collector and its real source/DB writes settle before replacement. Reads
 * never migrate storage, invoke a model or start another daemon. When Host
 * observation is enabled without Bot monitoring, this same owner initializes
 * only a fresh installation intake. Existing damaged/history stores still fail. */
export function startMonitorService(input: MonitorServiceInput, testPorts: { pollMs?: number } = {}) {
  const pollMs = testPorts.pollMs ?? 5000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5000) throw new Error("monitor_invalid_service_interval");
  let state: MonitorServiceStatus = { state: "not_configured", reason: null, desiredRevision: null, collectorEpoch: null,
    startedAtMs: Date.now(), lastReceiptAtMs: null, replacements: 0, ownershipState: "not_observed", targets: 0, sources: [], notificationsEnabled: null,
    nativeRunHealth: { state: "not_observed", observedAtMs: null, tasks: 0 },
    owner: "management-server", createsDatabase: false, notifiesDirectly: false, bootInstalled: false };
  const signal = new AbortController();
  let child: Fiber.Fiber<void, unknown> | undefined, childSignal: AbortController | undefined;
  let finished = false, failures = 0, nextAttemptAt = 0, expectedSourceCount = 0, installationOnly = false;
  const stopChild = Effect.gen(function* () {
    if (!child) return;
    childSignal?.abort();
    yield* Fiber.interrupt(child);
    child = undefined; childSignal = undefined; finished = false;
  });
  const publish: MonitorRunOptions["publish"] = receipt => {
    const sources = receipt.journal?.sources ?? state.sources;
    const sourceComplete = sources.length === expectedSourceCount && sources.every(source => source.state === "observed");
    const nativeRunHealth = receipt.nativeRunHealth ?? state.nativeRunHealth;
    state = { ...state, state: installationOnly || receipt.state === "observed" && sourceComplete && nativeRunHealth.state === "observed_window" ? "running" : "degraded",
      reason: installationOnly ? null : receipt.state !== "observed" ? "ownership_source_unavailable" : !sourceComplete ? "journal_coverage_partial"
        : nativeRunHealth.state !== "observed_window" ? "native_run_health_unavailable" : null, nativeRunHealth,
      collectorEpoch: receipt.collectorEpoch, lastReceiptAtMs: Date.now(), ownershipState: installationOnly ? "not_observed" : receipt.state,
      sources };
    failures = 0;
  };
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.gen(function* () { state = { ...state, state: "stopping" }; yield* stopChild; state = { ...state, state: "stopped" }; }));
    yield* Effect.forever(Effect.gen(function* () {
      const read = yield* Effect.result(Effect.tryPromise({ try: () => readMonitorServiceConfiguration(input.durableRoot), catch: () => "configuration_unavailable" }));
      const configuration = read._tag === "Success" ? read.success : null;
      const inactive = read._tag === "Failure" ? "configuration_unavailable" : !configuration ? "not_configured" : !configuration.enabled ? "disabled" : null;
      if (inactive) {
        yield* stopChild;
        state = { ...state, state: inactive === "configuration_unavailable" ? "blocked" : inactive as "disabled" | "not_configured",
          reason: inactive, desiredRevision: configuration?.revision ?? null, collectorEpoch: null, targets: configuration?.agentIds.length ?? 0, createsDatabase: false,
          sources: [], ownershipState: "not_observed", lastReceiptAtMs: null, notificationsEnabled: configuration?.notificationsEnabled ?? null,
          nativeRunHealth: { state: "not_observed", observedAtMs: null, tasks: 0 } };
      } else if (configuration) {
        const changed = state.desiredRevision !== configuration.revision;
        if (changed || finished) {
          yield* stopChild;
          if (changed) { nextAttemptAt = 0; failures = 0; }
        }
        if (!child && Date.now() >= nextAttemptAt) {
          const root = yield* Effect.result(Effect.tryPromise({ try: () => validateMonitorRoot(configuration.runRoot), catch: () => "source_root_unavailable" }));
          state = { ...state, desiredRevision: configuration.revision, targets: configuration.agentIds.length };
          if (root._tag === "Failure") {
            state = { ...state, state: "blocked", reason: root.failure };
          } else {
            childSignal = new AbortController(); finished = false;
            installationOnly = configuration.mode === "installation";
            expectedSourceCount = installationOnly ? 0 : root.success === input.durableRoot ? 1 : 2;
            state = { ...state, state: "starting", reason: null, collectorEpoch: null, sources: [], ownershipState: "not_observed", lastReceiptAtMs: null,
              notificationsEnabled: configuration.notificationsEnabled, createsDatabase: installationOnly,
              nativeRunHealth: { state: "not_observed", observedAtMs: null, tasks: 0 }, replacements: state.replacements + 1 };
            const collectorSignal = childSignal.signal, initialize = installationOnly;
            const run = Effect.gen(function* () {
              if (initialize) {
                const storage = yield* Effect.tryPromise({ try: () => readStorageConfiguration(input.durableRoot), catch: error => error });
                // The original initializer preserves every existing database and
                // rejects a missing ledger inside an already-owned directory.
                yield* Effect.uninterruptible(Effect.tryPromise({
                  try: () => openMonitorStore(input.durableRoot, storage.monitor).initialize(), catch: error => error,
                }));
              }
              yield* monitorProgram({ durableRoot: input.durableRoot, ...(!initialize ? { runRoot: root.success } : {}), agentIds: configuration.agentIds,
                read: input.read, signal: collectorSignal, intervalMs: configuration.intervalMs, includeControlJournal: !initialize,
                ...(configuration.notificationsEnabled ? {} : { notifications: "off" as const }), publish });
            });
            child = yield* Effect.forkScoped(run.pipe(Effect.onExit(exit => Effect.sync(() => {
              finished = true;
              if (Exit.isSuccess(exit)) {
                state = { ...state, state: "degraded", reason: "collector_exited" };
              } else if (!Cause.hasInterruptsOnly(exit.cause)) {
                const error = Cause.squash(exit.cause), reason = error instanceof BoxRuntimeError && /^monitor_[a-z_]+$/.test(error.message) ? error.message : "collector_failed";
                failures = Math.min(6, failures + 1); nextAttemptAt = Date.now() + Math.min(60_000, pollMs * 2 ** failures);
                state = { ...state, state: "blocked", reason };
              }
            }))));
          }
        }
      }
      yield* Effect.sleep(`${pollMs} millis`);
    }));
  }));
  const done = Effect.runPromiseExit(program, { signal: signal.signal }).then(exit => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) state = { ...state, state: "blocked", reason: "monitor_service_failed" };
    return exit;
  });
  return {
    status: (): MonitorServiceStatus => {
      const fresh = state.lastReceiptAtMs !== null && Date.now() - state.lastReceiptAtMs <= 90_000 && Date.now() >= state.lastReceiptAtMs;
      const result = { ...state, nativeRunHealth: { ...state.nativeRunHealth }, sources: state.sources.map(source => ({ ...source })) };
      if (finished && (result.state === "running" || result.state === "degraded")) { result.state = "degraded"; result.reason = "collector_exited"; }
      else if ((result.state === "running" || result.state === "degraded") && !fresh) { result.state = "degraded"; result.reason = "collector_receipt_stale"; }
      return result;
    },
    close: async () => {
      signal.abort(); const exit = await done;
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw new Error("monitor_service_cleanup_failed");
    },
  };
}
