import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Cause, Clock, Effect, Exit } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { makeMonitorSample, monitorDelay, monitorInterval, monitorTargets, MONITOR_POLICY } from "@grokbox/runtime-kernel/monitor";
import { acquireExclusiveLock } from "../io/op-lock.ts";
import { openMonitorStore, type MonitorStore } from "../io/monitor-store.node.ts";
import type { OwnershipReader } from "../io/ownership-admission.node.ts";

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });

export type MonitorRunOptions = {
  durableRoot: string; agentIds: string[]; read: OwnershipReader; signal: AbortSignal;
  once?: boolean; intervalMs?: number;
  publish: (receipt: { process: "monitor"; collectorEpoch: string; sampleNumber: number; state: "observed"|"unavailable";
    notificationMode: "local_only"; productionAccepted: false;
    changes: Awaited<ReturnType<MonitorStore["record"]>>["events"];
    snapshot: Awaited<ReturnType<MonitorStore["snapshot"]>> }) => void;
};

/** Browser independent and inference independent. One explicitly started
 * collector batches its targets. Queries never call this root or the Server.
 * DB locks/corruption fail this root; they cannot disable the separate admission
 * authority, rewrite models, signal Host or replay work. */
export async function runMonitor(input: MonitorRunOptions): Promise<void> {
  const ids = monitorTargets(input.agentIds), interval = monitorInterval(input.intervalMs ?? MONITOR_POLICY.intervalMs);
  if (input.signal.aborted) throw new BoxRuntimeError("invalid_usage", "monitor_cancelled");
  const store = openMonitorStore(input.durableRoot);
  // Refuse uninitialized/corrupt storage before creating a collector lock.
  await store.snapshot();
  const epoch = randomUUID(); let number = 0, failures = 0;
  const program = Effect.scoped(Effect.gen(function* () {
    yield* Effect.acquireRelease(
      attempt(async () => {
        const lease = await acquireExclusiveLock(join(input.durableRoot,"observability","collector.lock"));
        if (!lease.ok) throw new BoxRuntimeError("invalid_usage", "monitor_already_running_or_recovery_required");
        return lease.lock;
      }),
      lease => Effect.promise(() => lease.release()),
    );
    const at = yield* Clock.currentTimeMillis;
    yield* Effect.uninterruptible(attempt(() => store.begin(epoch,at,ids)));
    yield* Effect.addFinalizer(() => Effect.promise(async () => { await store.finish(epoch,Date.now()); }));
    for (;;) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const response = yield* Effect.result(Effect.tryPromise({ try: signal => input.read(ids,signal), catch: () => "read_unavailable" })
        .pipe(Effect.timeout(`${MONITOR_POLICY.readTimeoutMs} millis`)));
      const completedAtMs = yield* Clock.currentTimeMillis;
      const sample = makeMonitorSample({ sampleId: randomUUID(), agentIds: ids, startedAtMs, completedAtMs,
        ...(response._tag === "Success" ? { response: response.success } : {}) });
      number++;
      // An atomic snapshot commit is short and non-cancellable. Only after its
      // durable receipt may observers see the new result; no dangling late write.
      const committed = yield* Effect.uninterruptible(attempt(() => store.record(epoch,number,sample)));
      const snapshot = yield* attempt(() => store.snapshot(completedAtMs));
      yield* Effect.sync(() => input.publish({ process: "monitor", collectorEpoch: epoch, sampleNumber: number,
        state: sample.failure === null ? "observed" : "unavailable", notificationMode: "local_only",
        productionAccepted: false, changes: committed.events, snapshot }));
      if (input.once) return;
      // Serial, completion-relative cadence: no catch-up storm, overlapped poll
      // or separate refresh per subscriber. Admission freshness remains separate.
      failures = sample.failure === null ? 0 : failures + 1;
      yield* Effect.sleep(`${monitorDelay(interval,failures,Math.random())} millis`);
    }
  }));
  const exit = await Effect.runPromiseExit(program,{ signal: input.signal });
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
  throw Cause.squash(exit.cause);
}
