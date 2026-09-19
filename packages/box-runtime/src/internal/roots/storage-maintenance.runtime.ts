import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { openMonitorStore } from "../io/monitor-store.node.ts";
import { observeProcessLogStorage } from "../io/bounded-process-log.node.ts";
import { observeJournalStorage } from "../io/journal-storage.node.ts";
import { readStorageConfiguration, type StorageConfiguration } from "../io/storage-configuration.node.ts";
import { observeStorageMaintenance } from "../io/storage-maintenance-receipt.node.ts";
import { observeDiagnosticFootprint } from "../io/storage-footprint.node.ts";
import { observeDiagnosticAdmission } from "../host/diagnostic-budget.node.ts";
import { openOpsBindings } from "../io/ops-bindings.node.ts";
import type { ContinuityStorageOwners } from "@grokbox/runtime-kernel/observation";
import { measureContinuityStorage } from "../io/continuity-storage.node.ts";
import { openRoutineProvisionStore } from "../io/routine-provision.node.ts";

/** Read-only owner inventory. One unavailable source must not hide another.
 * This does not install a maintenance scheduler or enforce a global quota. */
export async function observeRuntimeStorage(input: { durableRoot: string; runRoot?: string; continuityOwners?: ContinuityStorageOwners }) {
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
  const journalIntent = storage ? { revision: storage.revision, policy: storage.policy.retention.journal } : undefined;
  const journals = [{ source: "control", ...await observeJournalStorage(input.durableRoot, journalIntent) }];
  if (input.runRoot && input.runRoot !== input.durableRoot) journals.push({ source: "host", ...await observeJournalStorage(input.runRoot, journalIntent) });
  const maintenance = input.runRoot ? await observeStorageMaintenance({ durableRoot: input.durableRoot, runRoot: input.runRoot })
    : { state: "not_configured", fileBytes: null };
  const footprint = await observeDiagnosticFootprint(input);
  const knownBytes = Math.max(footprint.fileBytes, footprint.allocatedBytes);
  const budgetComparison = { knownBytes, basis: "max_file_length_or_allocated", coverage: "partial",
    state: !storage ? "policy_unavailable" : knownBytes >= storage.policy.diagnostics.maxBytes ? "at_or_above_max"
      : knownBytes >= storage.policy.diagnostics.targetBytes ? "at_or_above_target" : "counted_namespaces_below_target",
    reservationEnforced: false };
  const continuityStorage = await measureContinuityStorage(input.continuityOwners);
  const routineProvision = await openRoutineProvisionStore(input.durableRoot).status().catch(() => ({
    owner: "routine_provision", state: "unavailable", fileBytes: null, diagnosticGcAllowed: false,
  }));
  const paired = await openOpsBindings(input.durableRoot).status();
  const pairingStorage = { owner: "ops_pairing_credentials", state: paired.state, fileBytes: paired.fileBytes,
    bindings: paired.state === "observed" ? paired.bindings.length : null, maxBindings: 8, maxFileBytes: 65536, maxStagingBytes: 65536,
    automaticGcAllowed: false, credentialValuesIncluded: false, diagnosticBudgetIncluded: false };
  const diagnosticAdmission = await observeDiagnosticAdmission(input.durableRoot);
  return { ...monitor, processLogs, journals, storageIntent, maintenance, footprint, budgetComparison, diagnosticAdmission, continuityStorage, routineProvision, pairingStorage, installationBudgetEnforced: false as const };
}
