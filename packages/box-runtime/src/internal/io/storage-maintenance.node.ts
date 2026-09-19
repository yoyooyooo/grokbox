import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import type { ContinuityStorageOwners } from "@grokbox/runtime-kernel/observation";
import { maintainContinuityStorage } from "./continuity-storage.node.ts";
import { openMonitorStore } from "./monitor-store.node.ts";
import { readStorageConfiguration } from "./storage-configuration.node.ts";
import { maintainRegisteredJournals, type JournalMaintenanceReceipt } from "./journal-maintenance.node.ts";
import type { BoundedProcessLog, ProcessLogMaintenance } from "./bounded-process-log.node.ts";

export const STORAGE_MAINTENANCE_INTERVAL_MS = 30_000;
export type StorageMaintenanceCycle = {
  atMs: number; elapsedMs: number; budgetExceeded: boolean;
  state: "completed" | "partial" | "configuration_unavailable";
  policyRevision: string | null;
  execution?: { state: "maintained" | "protected" | "unavailable"; retiredSteps: number; closedTurns: number; blockedActiveSteps: number; fileBytes: number | null; maxBytes: number | null };
  continuity?: Awaited<ReturnType<typeof maintainContinuityStorage>>;
  monitor: { state: "maintained" | "busy" | "not_initialized" | "migration_required" | "unavailable" | "not_checked";
    removedEvidence: number; expiredSnapshots: number; physicalBytes: number | null; clockState: string | null };
  journals: JournalMaintenanceReceipt[];
  processLog: ProcessLogMaintenance | { state: "not_owned" | "policy_changed" | "not_checked"; reclaimedBytes: 0; activeSegmentPreserved: true };
};
export type StorageMaintenanceInput = {
  durableRoot: string; runRoot: string; nowMs?: number;
  processLog?: BoundedProcessLog; processPolicyRevision?: string;
  continuityOwners?: ContinuityStorageOwners;
};
/** One finite pass using existing owners, never a second collector. No Gateway,
 * models, initialization, migration, full VACUUM or arbitrary file deletion.
 * Store transactions and journal/writer locks remain the mutation authorities;
 * concurrent housekeeping skips contention instead of waiting in a retry loop. */
export async function maintainObservationStorage(input: StorageMaintenanceInput): Promise<StorageMaintenanceCycle> {
  const atMs = input.nowMs ?? Date.now(), started = performance.now();
  if (!Number.isSafeInteger(atMs) || atMs < 1) throw new Error("storage_maintenance_invalid_time");
  const result: StorageMaintenanceCycle = {
    atMs, elapsedMs: 0, budgetExceeded: false, state: "configuration_unavailable", policyRevision: null,
    monitor: { state: "not_checked", removedEvidence: 0, expiredSnapshots: 0, physicalBytes: null, clockState: null }, journals: [],
    processLog: { state: "not_checked", reclaimedBytes: 0, activeSegmentPreserved: true },
  };
  const finish = () => { result.elapsedMs = Math.max(0, performance.now() - started); result.budgetExceeded = result.elapsedMs > 50; return result; };
  let storage;
  try { storage = await readStorageConfiguration(input.durableRoot); }
  catch { return finish(); }
  result.policyRevision = storage.revision; result.state = "completed";
  try {
    const retired = await openMonitorStore(input.durableRoot, storage.monitor).maintain(atMs);
    result.monitor = { state: "maintained", removedEvidence: retired.removedEvidence,
      expiredSnapshots: retired.retention.expiredSnapshots, physicalBytes: "physical" in retired ? retired.physical?.allocatedBytes ?? null : null,
      clockState: retired.retention.state };
    if (!retired.retention.mayExpire) result.state = "partial";
  } catch (error) {
    const reason = error instanceof BoxRuntimeError ? error.message : "unknown";
    result.monitor.state = reason === "monitor_not_initialized" ? "not_initialized" : reason === "monitor_migration_required" ? "migration_required"
      : ["monitor_writer_busy", "monitor_reader_busy"].includes(reason) ? "busy" : "unavailable";
    if (result.monitor.state !== "not_initialized") result.state = "partial";
  }
  // Filesystem work happens after the database transaction has settled. No
  // database lock is held while inspecting/reclaiming another owner's files.
  try { result.journals = (await maintainRegisteredJournals({ durableRoot: input.durableRoot, runRoot: input.runRoot, nowMs: atMs })).roots; }
  catch { result.journals = [{ source: "control", state: "unavailable", reclaimedBytes: 0, elapsedMs: 0 }]; }
  if (result.journals.some(r => r.state === "unavailable" || r.state === "busy")) result.state = "partial";
  if (!input.processLog) { result.processLog = { state: "not_owned", reclaimedBytes: 0, activeSegmentPreserved: true }; result.state = "partial"; }
  else if (input.processPolicyRevision !== storage.revision) {
    result.processLog = { state: "policy_changed", reclaimedBytes: 0, activeSegmentPreserved: true }; result.state = "partial";
  } else {
    try { result.processLog = await input.processLog.maintain(atMs); }
    catch { result.processLog = { state: "unavailable", reclaimedBytes: 0, activeSegmentPreserved: true }; }
    if (result.processLog.state !== "maintained") result.state = "partial";
  }
  result.continuity = await maintainContinuityStorage(input.continuityOwners, atMs);
  if (result.continuity.some(r => r.state === "unavailable" || r.receipt?.state === "blocked")) result.state = "partial";
  return finish();
}
