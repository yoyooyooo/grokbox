import { randomUUID } from "node:crypto";
import { Cause, Clock, Effect, Exit, Semaphore } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { makeMonitorSample, monitorDelay, monitorInterval, monitorTargets, MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore, type MonitorStore } from "../io/monitor-store.node.ts";
import { readStorageConfiguration, type StorageConfiguration } from "../io/storage-configuration.node.ts";
import { readJournalBatch } from "../io/journal-cursor.node.ts";
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
type JournalProgress = { state: string; readBytes: number; inserted: number; hasMore: boolean; droppedEvents?: number };
type Changes = Awaited<ReturnType<MonitorStore["record"]>>["events"];
type Maintenance = Awaited<ReturnType<MonitorStore["maintain"]>>;
type Tick = { changes: Changes; notifications: unknown[]; journal?: JournalProgress; maintenance?: Maintenance };
const emptyTick = (): Tick => ({ changes: [], notifications: [] });
export type MonitorRunOptions = {
  durableRoot: string; runRoot?: string; agentIds: string[]; read: OwnershipReader; signal: AbortSignal;
  once?: boolean; intervalMs?: number;
  publish: (receipt: {
    process: "monitor"; collectorEpoch: string; sampleNumber: number; state: "observed" | "unavailable";
    notificationMode: "local_only"; productionAccepted: false;
    storagePolicy?: { revision: string; source: StorageConfiguration["source"]; scope: "monitor"; hotReload: false };
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
export async function runMonitor(input: MonitorRunOptions): Promise<void> {
  const ids = monitorTargets(input.agentIds), interval = monitorInterval(input.intervalMs ?? MONITOR_POLICY.intervalMs);
  if (input.signal.aborted) throw new BoxRuntimeError("invalid_usage", "monitor_cancelled");
  const epoch = randomUUID();
  let store: MonitorStore, storage: StorageConfiguration;
  const localWriter = Semaphore.makeUnsafe(1);
  let sampleNumber = 0, failures = 0;
  let sampleState: "observed" | "unavailable" = "unavailable", previousJournalState: string | undefined;
  const publish = (tick: Tick) => Effect.gen(function*() {
    const snapshot = yield* attempt(() => store.snapshot(Date.now()));
    const journal = tick.journal ?? { state: input.runRoot ? previousJournalState ?? "not_checked" : "not_configured", readBytes: 0, inserted: 0, hasMore: false };
    const publication = yield* Effect.exit(Effect.sync(() => input.publish({ process: "monitor", collectorEpoch: epoch,
      sampleNumber, state: sampleState, notificationMode: "local_only", productionAccepted: false,
      storagePolicy: { revision: storage.revision, source: storage.source, scope: "monitor", hotReload: false },
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
      const committed = yield* attempt(() => store.record(epoch, sampleNumber + 1, observation));
      sampleNumber++;
      sampleState = observation.failure === null ? "observed" : "unavailable";
      failures = observation.failure === null ? 0 : failures + 1;
      const tick: Tick = { changes: committed.events, notifications: committed.notifications };
      if (!input.once) yield* publish(tick);
      return tick;
    }));
  });
  const drain = Effect.gen(function*() {
    const tick = emptyTick();
    tick.journal = { state: "not_configured", readBytes: 0, inserted: 0, hasMore: false };
    if (!input.runRoot) return tick;
    const sourceKey = sha256Text(`host-journal:${input.runRoot}`), begun = yield* Clock.monotonicTimeNanos;
    const gaps = new Set<string>();
    do {
      const saved = yield* attempt(() => store.evidenceCursor(sourceKey));
      const batch = yield* attempt(() => readJournalBatch(input.runRoot!, saved?.cursor ?? null));
      yield* localWriter.withPermit(Effect.gen(function*() {
        const indexed = yield* attempt(() => store.ingestEvidence({ epoch, sourceKey,
          expectedCursor: saved?.cursor ?? null, nextCursor: batch.nextCursor ?? "null", events: batch.events, atMs: Date.now(), gap: batch.gap }));
        if (batch.gap) gaps.add(batch.gap);
        if (indexed.storagePressure) gaps.add("storage_pressure");
        const journal = { state: gaps.size ? [...gaps].join(",") : batch.deferred ?? "observed", readBytes: batch.readBytes, inserted: indexed.inserted, hasMore: batch.hasMore, droppedEvents: indexed.droppedEvents };
        if (!input.once && (indexed.changes.length || indexed.inserted || indexed.droppedEvents || journal.state !== previousJournalState))
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
  const maintain = localWriter.withPermit(Effect.gen(function*() {
    const maintenance = yield* attempt(() => store.maintain(Date.now()));
    const tick = { ...emptyTick(), maintenance };
    if (!input.once) yield* publish(tick);
    return tick;
  }));
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
    const localLoop = input.runRoot ? Effect.forever(Effect.gen(function*() { const tick = yield* drain; yield* Effect.sleep(tick.journal?.hasMore ? "100 millis" : "1 second"); })) : Effect.void;
    // Delay the first maintenance slice so startup evidence need not compete
    // with housekeeping. It has its own clock and does not wait for remote reads.
    const maintenanceLoop = Effect.forever(Effect.gen(function*() { yield* Effect.sleep("30 seconds"); yield* maintain; }));
    yield* Effect.all([sourceLoop, localLoop, maintenanceLoop], { concurrency: 3, discard: true });
  }));
  const exit = await Effect.runPromiseExit(program, { signal: input.signal });
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
  throw Cause.squash(exit.cause);
}
