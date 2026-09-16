import { randomUUID } from "node:crypto";
import { Cause, Clock, Effect, Exit } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { makeMonitorSample, monitorDelay, monitorInterval, monitorTargets, MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { openMonitorStore, type MonitorStore } from "../io/monitor-store.node.ts";
import { readJournalBatch } from "../io/journal-cursor.node.ts";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";

const singleAttempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
/** SQLite busy is temporary scheduling pressure, not a lifetime quota. Retry
 * the exact transaction/read, never the upstream RPC or any model/tool call.
 * Each transaction settles before cancellation; only the intervening wait is
 * interruptible, so a cancelled waiter cannot leave a late detached write. */
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
type JournalProgress = { state: string; readBytes: number; inserted: number; hasMore: boolean };
export type MonitorRunOptions = {
  durableRoot: string; runRoot?: string; agentIds: string[]; read: OwnershipReader; signal: AbortSignal;
  once?: boolean; intervalMs?: number;
  publish: (receipt: {
    process: "monitor"; collectorEpoch: string; sampleNumber: number; state: "observed" | "unavailable";
    notificationMode: "local_only"; productionAccepted: false;
    changes: Awaited<ReturnType<MonitorStore["record"]>>["events"];
    snapshot: Awaited<ReturnType<MonitorStore["snapshot"]>>;
    journal?: JournalProgress; maintenance?: Awaited<ReturnType<MonitorStore["maintain"]>>;
    notifications?: unknown[];
  }) => void;
};

/** A single explicitly started Effect owner. Journal catch-up never accelerates
 * authenticated ownership RPCs. Local polling, upstream cadence and maintenance
 * are separate clocks in the same loop, not detached workers/runtimes. */
export async function runMonitor(input: MonitorRunOptions): Promise<void> {
  const ids = monitorTargets(input.agentIds), interval = monitorInterval(input.intervalMs ?? MONITOR_POLICY.intervalMs);
  if (input.signal.aborted) throw new BoxRuntimeError("invalid_usage", "monitor_cancelled");
  const store = openMonitorStore(input.durableRoot), epoch = randomUUID();
  let sampleNumber = 0, failures = 0, nextSampleAt = 0, nextMaintenanceAt = 0;
  let sampleState: "observed" | "unavailable" = "unavailable", previousJournalState: string | undefined;
  const program = Effect.scoped(Effect.gen(function*() {
    const at = yield* Clock.currentTimeMillis;
    yield* Effect.acquireRelease(
      Effect.uninterruptible(singleAttempt(() => store.begin(epoch, at, ids))),
      () => Effect.promise(() => store.finish(epoch, Date.now())),
    );
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const sampled = now >= nextSampleAt;
      const changes: Awaited<ReturnType<MonitorStore["record"]>>["events"] = [];
      const notifications: unknown[] = [];
      if (sampled) {
        const response = yield* Effect.result(Effect.tryPromise({ try: signal => input.read(ids, signal), catch: () => "read_unavailable" })
          .pipe(Effect.timeout(`${MONITOR_POLICY.readTimeoutMs} millis`)));
        const completedAtMs = yield* Clock.currentTimeMillis;
        const sample = makeMonitorSample({ sampleId: randomUUID(), agentIds: ids, startedAtMs: now, completedAtMs,
          ...(response._tag === "Success" ? { response: response.success } : {}) });
        sampleNumber++;
        const committed = yield* attempt(() => store.record(epoch, sampleNumber, sample));
        changes.push(...committed.events); notifications.push(...committed.notifications);
        sampleState = sample.failure === null ? "observed" : "unavailable";
        failures = sample.failure === null ? 0 : failures + 1;
        nextSampleAt = completedAtMs + monitorDelay(interval, failures, Math.random());
      }
      let journal: JournalProgress = { state: "not_configured", readBytes: 0, inserted: 0, hasMore: false };
      const journalGaps = new Set<string>();
      if (input.runRoot) {
        const sourceKey = sha256Text(`host-journal:${input.runRoot}`), drainStarted = yield* Clock.currentTimeMillis;
        // A scheduling slice, not a retained-record limit. Cursor and evidence
        // commit atomically; the next iteration resumes exactly the remainder.
        do {
          const saved = yield* attempt(() => store.evidenceCursor(sourceKey));
          const batch = yield* attempt(() => readJournalBatch(input.runRoot!, saved?.cursor ?? null));
          const indexed = yield* attempt(() => store.ingestEvidence({ epoch, sourceKey,
            expectedCursor: saved?.cursor ?? null, nextCursor: batch.nextCursor ?? "null", events: batch.events, atMs: Date.now(), gap: batch.gap }));
          changes.push(...indexed.changes); notifications.push(...(indexed.notifications ?? []));
          if (batch.gap) journalGaps.add(batch.gap);
          journal = { state: journalGaps.size ? [...journalGaps].join(",") : "observed", readBytes: journal.readBytes + batch.readBytes,
            inserted: (journal?.inserted ?? 0) + indexed.inserted, hasMore: batch.hasMore };
          if (!batch.hasMore || (yield* Clock.currentTimeMillis) - drainStarted >= 500) break;
          yield* Effect.yieldNow;
        } while (true);
      }
      const current = yield* Clock.currentTimeMillis;
      let maintenance: Awaited<ReturnType<MonitorStore["maintain"]>> | undefined;
      if (current >= nextMaintenanceAt) {
        maintenance = yield* attempt(() => store.maintain(current));
        nextMaintenanceAt = current + 30_000;
      }
      const changed = sampled || changes.length > 0 || (journal?.inserted ?? 0) > 0 || journal?.state !== previousJournalState || maintenance !== undefined;
      previousJournalState = journal?.state;
      if (changed) {
        const snapshot = yield* attempt(() => store.snapshot(current));
        const publication = yield* Effect.exit(Effect.sync(() => input.publish({ process: "monitor", collectorEpoch: epoch,
          sampleNumber, state: sampleState, notificationMode: "local_only", productionAccepted: false,
          changes, snapshot, journal, maintenance, notifications })));
        if (notifications.length) yield* attempt(() => store.recordNotificationExport(epoch, notifications, Exit.isSuccess(publication), Date.now()))
          .pipe(Effect.catchCause(() => Effect.void));
        if (Exit.isFailure(publication)) return yield* Effect.failCause(publication.cause);
      }
      if (input.once) return;
      const remaining = Math.max(1, nextSampleAt - (yield* Clock.currentTimeMillis));
      const localDelay = input.runRoot ? journal?.hasMore ? 100 : 1000 : remaining;
      yield* Effect.sleep(`${Math.min(remaining, localDelay)} millis`);
    }
  }));
  const exit = await Effect.runPromiseExit(program, { signal: input.signal });
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
  throw Cause.squash(exit.cause);
}
