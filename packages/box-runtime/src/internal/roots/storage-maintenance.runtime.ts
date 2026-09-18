import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { observeProcessLogStorage } from "../io/bounded-process-log.node.ts";
import { observeJournalStorage } from "../io/journal-storage.node.ts";
import { readStorageConfiguration, type StorageConfiguration } from "../io/storage-configuration.node.ts";

/** Read-only owner inventory. One unavailable source must not hide another.
 * This does not install a maintenance scheduler or enforce a global quota. */
export async function observeRuntimeStorage(input: { durableRoot: string; runRoot?: string }) {
  let storage: StorageConfiguration | undefined;
  try { storage = await readStorageConfiguration(input.durableRoot); } catch { /* config does not hide local storage evidence */ }
  const storageIntent = storage ? { state: "available", ...storage, application: "not-observed", aggregateConsumer: "not-installed" }
    : { state: "unavailable", reason: "storage_configuration_unavailable", application: "not-observed" };
  let monitor: Awaited<ReturnType<ReturnType<typeof openMonitorStore>["storageHealth"]>> | {
    scope: "monitor_database_only"; state: "not_initialized" | "unavailable";
    reason: string; fileBytes: null; installationBudgetEnforced: false;
  };
  try { monitor = await openMonitorStore(input.durableRoot, storage?.monitor).storageHealth(); }
  catch (error) {
    const absent = error instanceof BoxRuntimeError && error.message === "monitor_not_initialized";
    monitor = { scope: "monitor_database_only", state: absent ? "not_initialized" : "unavailable",
      reason: absent ? "monitor_not_initialized" : "monitor_storage_unavailable", fileBytes: null, installationBudgetEnforced: false };
  }
  const processLogs = input.runRoot ? await observeProcessLogStorage(input.runRoot)
    : { state: "not_configured" as const, scope: "owned_modeld_process_segments" as const, bytes: null };
  const journals = [{ source: "control", ...await observeJournalStorage(input.durableRoot) }];
  if (input.runRoot && input.runRoot !== input.durableRoot) journals.push({ source: "host", ...await observeJournalStorage(input.runRoot) });
  return { ...monitor, processLogs, journals, storageIntent, installationBudgetEnforced: false as const };
}
