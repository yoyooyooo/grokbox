import { Effect } from "effect";
import type { ExecutionRetirementReceipt } from "@grokbox/runtime-kernel/inference";
import { maintainObservationStorage, STORAGE_MAINTENANCE_INTERVAL_MS, type StorageMaintenanceCycle, type StorageMaintenanceInput } from "../io/storage-maintenance.node.ts";
import { createStorageMaintenanceRecorder } from "../io/storage-maintenance-receipt.node.ts";

/** Internal injectable boundaries for deterministic lifetime tests. Production
 * calls use the real finite pass, recorder and fixed delay; no environment or
 * public config switch can replace the owner, perform model calls or disable GC. */
export type StorageLifetimePorts = {
  intervalMs?: number;
  cycle?: () => Promise<StorageMaintenanceCycle>;
  recorder?: () => Promise<{ record: (cycle: StorageMaintenanceCycle | null) => Promise<void>; stop: () => Promise<void> }>;
};
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => "storage_maintenance_unavailable" });

/** A child of the acquired modeld listener, not an independently started daemon.
 * A pass settles before interruption and before the process log/listener close.
 * Fixed-delay scheduling never overlaps passes or catches up in a burst. */
export function modeldStorageMaintenance(input: StorageMaintenanceInput & { serviceEpoch: string; retireExecution?: () => Effect.Effect<ExecutionRetirementReceipt, unknown> }, ports: StorageLifetimePorts = {}) {
  const interval = ports.intervalMs ?? STORAGE_MAINTENANCE_INTERVAL_MS;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > STORAGE_MAINTENANCE_INTERVAL_MS) throw new Error("storage_maintenance_invalid_interval");
  return Effect.scoped(Effect.gen(function* () {
    const recorder = yield* Effect.acquireRelease(
      Effect.uninterruptible(io(ports.recorder ?? (() => createStorageMaintenanceRecorder(input))))
        .pipe(Effect.catch(() => Effect.succeed(undefined))),
      value => value ? io(() => value.stop()).pipe(Effect.catch(() => Effect.void)) : Effect.void,
    );
    yield* Effect.forever(Effect.gen(function* () {
      // Real filesystem/SQLite operations cannot be abandoned while they are
      // still mutating. Listener shutdown reports its existing cleanup timeout
      // if this slice cannot settle; there is no detached late writer.
      yield* Effect.uninterruptible(Effect.gen(function* () {
        const result = yield* io(ports.cycle ?? (() => maintainObservationStorage(input)))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (input.retireExecution) {
          const execution = yield* input.retireExecution().pipe(Effect.result);
          if (result) {
            result.execution = execution._tag === "Success" ? { state: execution.success.state,
              retiredSteps: execution.success.retiredSteps, closedTurns: execution.success.closedTurns,
              blockedActiveSteps: execution.success.blockedActiveSteps, fileBytes: execution.success.fileBytes, maxBytes: execution.success.maxBytes }
              : { state: "unavailable", retiredSteps: 0, closedTurns: 0, blockedActiveSteps: 0, fileBytes: null, maxBytes: null };
            if (result.execution.state !== "maintained" && result.state === "completed") result.state = "partial";
          }
        }
        if (recorder) yield* io(() => recorder.record(result)).pipe(Effect.catch(() => Effect.void));
      }));
      yield* Effect.sleep(`${interval} millis`);
    }));
  }));
}
