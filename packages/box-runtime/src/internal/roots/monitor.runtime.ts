import { randomUUID } from "node:crypto";
import { Cause, Clock, Effect, Exit, Semaphore } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { makeMonitorSample, monitorDelay, monitorInterval, monitorTargets, MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore, type MonitorStore } from "../io/monitor-store.node.ts";
import { readStorageConfiguration, type StorageConfiguration } from "../io/storage-configuration.node.ts";
import { readJournalBatch } from "../io/journal-cursor.node.ts";
import { maintainRegisteredJournals } from "../io/journal-maintenance.node.ts";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";

const singleAttempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
/** Retry only the exact local transaction/read, never the upstream RPC. A commit
 * settles before cancellation; late detached writes cannot escape the owner. */
const attempt = <A>(run: () => Promise<A>) => Effect.gen(function*() {
  for (;;) {
    const result = yield* Effect.result(Effect.uninterruptible(singleAttempt(run)));
    if (result._tag === "Success") return result.success;
    const busy = result.failure instanceof BoxRuntimeError
      && ["monitor_writer_busy", "monitor_reader_busy"].includes(result.failure.message);
    if (!busy) return yield* Effect.fail(result.failure);
    yield* Effect.sleep("50 millis");
  }
});
export type JournalSourceProgress = { source: "host" | "control"; sourceKey: string; state: string; observedAtMs: number;
  readBytes: number; inserted: number; hasMore: boolean; producerLiveness: "not_checked" };
type JournalProgress = { state: string; readBytes: number; inserted: number; hasMore: boolean; droppedEvents?: number; sources?: JournalSourceProgress[] };
type Changes = Awaited<ReturnType<MonitorStore["record"]>>["events"];
type Maintenance = Awaited<ReturnType<MonitorStore["maintain"]>> & { journals?: Awaited<ReturnType<typeof maintainRegisteredJournals>> };
type Tick = { changes: Changes; notifications: unknown[]; journal?: JournalProgress; maintenance?: Maintenance };
const emptyTick = (): Tick => ({ changes: [], notifications: [] });
export type MonitorRunOptions = {
  durableRoot: string; runRoot?: string; agentIds: string[]; read: OwnershipReader; signal: AbortSignal;
  once?: boolean; intervalMs?: number; includeControlJournal?: boolean; notifications?: "off";
  publish: (receipt: {
    process: "monitor"; collectorEpoch: string; sampleNumber: number; state: "observed" | "unavailable";
    notificationMode: "local_only"; productionAccepted: false;
    storagePolicy?: { revision: string; source: StorageConfiguration["source"]; scope: "monitor"; hotReload: false };
    nativeRunHealth?: { state: "not_observed" | "observed_window" | "partial"; observedAtMs: number | null; tasks: number };
    changes: Changes;
    snapshot: Awaited<ReturnType<MonitorStore["snapshot"]>>;
    journal?: JournalProgress; maintenance?: Maintenance;
    notifications?: unknown[];
  }) => void;
};

/** One Effect lifetime with three bounded children. Remote ownership reads never
 * hold the local writer or delay journal intake. Independent sleeps use the
 * runtime's elapsed-time scheduler; wall time remains observation metadata.
 * This is not three collectors, a second Runtime, or detached Promise loops. */
export function monitorProgram(input: MonitorRunOptions) {
  const ids = monitorTargets(input.agentIds), interval = monitorInterval(input.intervalMs ?? MONITOR_POLICY.intervalMs);
  if (input.signal.aborted) throw new BoxRuntimeError("invalid_usage", "monitor_cancelled");
  const epoch = randomUUID();
  let store: MonitorStore, storage: StorageConfiguration;
  const localWriter = Semaphore.makeUnsafe(1);
  let sampleNumber = 0, failures = 0;
  let sampleState: "observed" | "unavailable" = "unavailable", previousJournalState: string | undefined;
  let nativeRunHealth: NonNullable<Parameters<MonitorRunOptions["publish"]>[0]["nativeRunHealth"]> = { state: "not_observed", observedAtMs: null, tasks: 0 };
  const publish = (tick: Tick) => Effect.gen(function*() {
    const snapshot = yield* attempt(() => store.snapshot(Date.now()));
    const journal = tick.journal ?? { state: sources.length ? previousJournalState ?? "not_checked" : "not_configured", readBytes: 0, inserted: 0, hasMore: false, sources: [...sourceStates.values()] };
    const publication = yield* Effect.exit(Effect.sync(() => input.publish({ process: "monitor", collectorEpoch: epoch,
      sampleNumber, state: sampleState, notificationMode: "local_only", productionAccepted: false,
      storagePolicy: { revision: storage.revision, source: storage.source, scope: "monitor", hotReload: false }, nativeRunHealth,
      changes: tick.changes, snapshot, journal, maintenance: tick.maintenance, notifications: tick.notifications })));
    if (tick.notifications.length) yield* attempt(() => store.recordNotificationExport(epoch, tick.notifications, Exit.isSuccess(publication), Date.now()))
      .pipe(Effect.catchCause(() => Effect.void));
    if (Exit.isFailure(publication)) return yield* Effect.failCause(publication.cause);
  });
  const sample = Effect.gen(function*() {
    const startedAtMs = yield* Clock.currentTimeMillis;
    const response = yield* Effect.result(Effect.tryPromise({ try: signal => input.read(ids, signal), catch: () => "read_unavailable" })
      .pipe(Effect.timeout(`${MONITOR_POLICY.readTimeoutMs} millis`)));
    const completedAtMs = yield* Clock.currentTimeMillis;
    const observation = makeMonitorSample({ sampleId: randomUUID(), agentIds: ids, startedAtMs, completedAtMs,
      ...(response._tag === "Success" ? { response: response.success } : {}) });
    return yield* localWriter.withPermit(Effect.gen(function*() {
      const committed = yield* attempt(() => store.record(epoch, sampleNumber + 1, observation, input.notifications));
      nativeRunHealth = observation.runObservation ? { state: observation.runObservation.coverage,
        observedAtMs: observation.runObservation.observedAtMs, tasks: observation.runObservation.tasks.length }
        : { state: "not_observed", observedAtMs: null, tasks: 0 };
      const detected = observation.runObservation ? yield* attempt(() => store.detectUnsettled({ epoch, nowMs: Date.now(),
        sourceLiveness: new Map(), nativeRuns: observation.runObservation, notifications: input.notifications })) : undefined;
      sampleNumber++;
      sampleState = observation.failure === null ? "observed" : "unavailable";
      failures = observation.failure === null ? 0 : failures + 1;
      const tick: Tick = { changes: [...committed.events, ...(detected?.changes ?? [])], notifications: [...committed.notifications, ...(detected?.notifications ?? [])] };
      if (!input.once) yield* publish(tick);
      return tick;
    }));
  });
  const sourceStates = new Map<string, JournalSourceProgress>();
  const sources: Array<{ root: string; source: "host" | "control"; sourceKey: string }> = [];
  if (input.runRoot) sources.push({ root: input.runRoot, source: "host", sourceKey: sha256Text(`host-journal:${input.runRoot}`) });
  if (input.includeControlJournal && input.durableRoot !== input.runRoot) sources.push({ root: input.durableRoot, source: "control", sourceKey: sha256Text(`control-journal:${input.durableRoot}`) });
  const drainSource = (source: typeof sources[number]) => Effect.gen(function*() {
    const tick = emptyTick();
    tick.journal = { state: "not_checked", readBytes: 0, inserted: 0, hasMore: false };
    const { sourceKey } = source, begun = yield* Clock.monotonicTimeNanos;
    const gaps = new Set<string>();
    do {
      const saved = yield* attempt(() => store.evidenceCursor(sourceKey));
      const batch = yield* attempt(() => readJournalBatch(source.root, saved?.cursor ?? null));
      // A not-yet-created journal is not an execution failure. Disappearance
      // after a committed cursor is a genuine gap. Neither grants producer
      // liveness merely because a file can be read.
      if (!saved && batch.gap === "missing") {
        sourceStates.set(sourceKey, { source: source.source, sourceKey, state: "not_observed", observedAtMs: Date.now(), readBytes: 0, inserted: 0, hasMore: false, producerLiveness: "not_checked" });
        tick.journal = { state: "not_observed", readBytes: 0, inserted: 0, hasMore: false, sources: [...sourceStates.values()] };
        break;
      }
      yield* localWriter.withPermit(Effect.gen(function*() {
        const atMs = Date.now();
        const indexed = yield* attempt(() => store.ingestEvidence({ epoch, sourceKey,
          expectedCursor: saved?.cursor ?? null, nextCursor: batch.nextCursor ?? "null", events: batch.events, atMs, gap: batch.gap,
          notifications: input.notifications, sourceHealth: { name: "observation_source_health", schemaVersion: 1,
            at: new Date(atMs).toISOString(), collectorEpoch: epoch, sourceKey, source: source.source,
            state: batch.gap || batch.deferred ? "partial" : "observed", basis: "collector_read", producerLiveness: "not_checked",
            readBytes: batch.readBytes, records: batch.events.length, hasMore: batch.hasMore } }));
        if (batch.gap) gaps.add(batch.gap);
        if (indexed.storagePressure) gaps.add("storage_pressure");
        const state = gaps.size ? [...gaps].join(",") : batch.deferred ?? "observed";
        const previousSourceState = sourceStates.get(sourceKey)?.state;
        sourceStates.set(sourceKey, { source: source.source, sourceKey, state, observedAtMs: Date.now(), readBytes: batch.readBytes,
          inserted: indexed.inserted, hasMore: batch.hasMore, producerLiveness: "not_checked" });
        const journal = { state, readBytes: batch.readBytes, inserted: indexed.inserted, hasMore: batch.hasMore,
          droppedEvents: indexed.droppedEvents, sources: [...sourceStates.values()] };
        if (!input.once && (indexed.changes.length || indexed.inserted || indexed.droppedEvents || journal.state !== previousSourceState))
          yield* publish({ changes: indexed.changes, notifications: indexed.notifications ?? [], journal });
        previousJournalState = journal.state;
        // One-shot aggregate is bounded by the same drain slice; continuous
        // consumption publishes per batch and retains no growing result array.
        if (input.once) { tick.changes.push(...indexed.changes); tick.notifications.push(...(indexed.notifications ?? [])); }
        tick.journal = { ...journal, readBytes: tick.journal!.readBytes + batch.readBytes, inserted: tick.journal!.inserted + indexed.inserted, droppedEvents: (tick.journal!.droppedEvents ?? 0) + indexed.droppedEvents };
      }));
      if (!batch.hasMore || Number((yield* Clock.monotonicTimeNanos) - begun) / 1_000_000 >= 500) break;
      yield* Effect.yieldNow;
    } while (true);
    return tick;
  });
  const drain = Effect.gen(function* () {
    const result = emptyTick();
    result.journal = { state: "not_configured", readBytes: 0, inserted: 0, hasMore: false, sources: [] };
    for (const source of sources) {
      const tick = yield* drainSource(source);
      result.changes.push(...tick.changes); result.notifications.push(...tick.notifications);
      result.journal.readBytes += tick.journal?.readBytes ?? 0;
      result.journal.inserted += tick.journal?.inserted ?? 0;
      result.journal.hasMore ||= tick.journal?.hasMore === true;
    }
    result.journal.sources = [...sourceStates.values()];
    if (sources.length) result.journal.state = result.journal.sources.every(s => s.state === "observed") ? "observed" : "partial";
    return result;
  });
  const maintain = Effect.gen(function*() {
    // Filesystem housekeeping never holds the SQLite writer permit. Rotation
    // settles before scope cancellation; an occupied journal lock is skipped.
    const journals = yield* Effect.uninterruptible(singleAttempt(() => maintainRegisteredJournals({
      durableRoot: input.durableRoot, runRoot: input.runRoot, signal: input.signal,
    })));
    return yield* localWriter.withPermit(Effect.gen(function*() {
      const maintenance = { ...yield* attempt(() => store.maintain(Date.now())), journals };
      const tick: Tick = { ...emptyTick(), maintenance };
      if (!input.once) yield* publish(tick);
      return tick;
    }));
  });
  const program = Effect.scoped(Effect.gen(function*() {
    storage = yield* singleAttempt(() => readStorageConfiguration(input.durableRoot));
    store = openMonitorStore(input.durableRoot, storage.monitor);
    yield* Effect.acquireRelease(
      Effect.uninterruptible(singleAttempt(() => store.begin(epoch, Date.now(), ids))),
      () => Effect.promise(() => store.finish(epoch, Date.now())),
    );
    if (input.once) {
      const [source, local] = yield* Effect.all([sample, drain], { concurrency: 2 });
      const maintenance = yield* maintain;
      yield* localWriter.withPermit(publish({ changes: [...source.changes, ...local.changes], notifications: [...source.notifications, ...local.notifications], journal: local.journal, maintenance: maintenance.maintenance }));
      return;
    }
    const sourceLoop = Effect.forever(Effect.gen(function*() { yield* sample; yield* Effect.sleep(`${monitorDelay(interval, failures, Math.random())} millis`); }));
    const localLoop = sources.length ? Effect.forever(Effect.gen(function*() { const tick = yield* drain; yield* Effect.sleep(tick.journal?.hasMore ? "100 millis" : "1 second"); })) : Effect.void;
    // Delay the first maintenance slice so startup evidence need not compete
    // with housekeeping. It has its own clock and does not wait for remote reads.
    const maintenanceLoop = Effect.forever(Effect.gen(function*() { yield* Effect.sleep("30 seconds"); yield* maintain; }));
    yield* Effect.all([sourceLoop, localLoop, maintenanceLoop], { concurrency: 3, discard: true });
  }));
  return program;
}

export async function runMonitor(input: MonitorRunOptions): Promise<void> {
  const exit = await Effect.runPromiseExit(monitorProgram(input), { signal: input.signal });
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
  throw Cause.squash(exit.cause);
}
