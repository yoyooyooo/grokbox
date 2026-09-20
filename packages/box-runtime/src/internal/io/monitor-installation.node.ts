import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { ConfigError, effectiveOps, effectiveStorage, type ConfigCommitReceipt } from "@grokbox/runtime-kernel/config";
import { monitorTargets, monitorInterval } from "@grokbox/runtime-kernel/monitor";
import { commitConfigChange, openConfigStore } from "./config-store.node.ts";
import { rootConfigLayout } from "./config-layout.node.ts";
import { readStorageConfiguration } from "./storage-configuration.node.ts";
import { openMonitorStore } from "./monitor-store.node.ts";

export type MonitorServiceConfiguration = {
  state: "configured"; runRoot: string; agentIds: string[]; enabled: boolean; notificationsEnabled: boolean;
  intervalMs: number; revision: string; configRevision: string;
};
export async function validateMonitorRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || path.length > 4096 || resolve(path) === "/") throw new ConfigError("config_invalid", "monitor_invalid_run_root");
  const normalized = resolve(path), info = await lstat(normalized);
  if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) throw new ConfigError("config_invalid", "monitor_unsafe_run_root");
  return normalized;
}
/** Canonical configuration only; neither HOME nor a transient shell variable is
 * an installation contract. Missing/malformed policy never starts collection. */
export async function readMonitorServiceConfiguration(durableRoot: string): Promise<MonitorServiceConfiguration | null> {
  const snapshot = await openConfigStore(rootConfigLayout(durableRoot)).read();
  const installation = snapshot.document.daemon?.observation;
  if (!installation) return null;
  const ops = effectiveOps(snapshot.document.ops), monitor = ops.monitor as Record<string, unknown>;
  const enabled = monitor.enabled === true;
  const notifications = ops.notifications as Record<string, unknown>;
  const policy = { runRoot: resolve(installation.runRoot), agentIds: monitorTargets(installation.agentIds,true), enabled,
    notificationsEnabled: ops.enabled === true && notifications.mode !== "off", intervalMs: monitorInterval(Number(monitor.intervalMs)) };
  // The storage domain is captured by each collector lifetime. Policy changes
  // require a settled replacement. Only the notification enable boundary is
  // relevant here, not receiver identities, credentials or other routing edits.
  const storage = effectiveStorage(snapshot.document.storage);
  return { state: "configured", ...policy, revision: sha256Text(canonicalJson({ ...policy, storage })), configRevision: snapshot.revision };
}
export type MonitorInstallationInput = {
  durableRoot: string; runRoot: string; agentIds: string[];
  confirmed?: boolean; operationId?: string; expectedRevision?: string;
};
/** Explicit, recoverable installation: initialization is its own durable owner,
 * config publication its own CAS. If phase two fails, the initialized empty DB
 * is retained and no missing-config collector starts. Never rolls back newer
 * user edits, starts a process, migrates business state or changes notifications. */
export async function configureMonitorService(input: MonitorInstallationInput) {
  const runRoot = await validateMonitorRoot(input.runRoot), agentIds = monitorTargets(input.agentIds,true);
  const store = openConfigStore(rootConfigLayout(input.durableRoot)), before = await store.read();
  if (!input.confirmed) return { state: "preview" as const, expectedRevision: before.revision,
    observation: { runRoot, agentIds }, databaseInitialized: false, serviceStarted: false, notificationsChanged: false };
  if (!input.operationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.operationId)
    || !input.expectedRevision || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new ConfigError("config_invalid", "monitor_install_requires_operation_and_revision");
  const existing = await store.receipt(input.operationId);
  if (!existing && before.revision !== input.expectedRevision) throw new ConfigError("config_conflict", "monitor_install_configuration_changed");
  const command = { kind: "set" as const, scope: "box" as const, path: "daemon.observation",
    value: { runRoot, agentIds }, confirm: true, replaceArrays: true, operationId: input.operationId, expectedRevision: input.expectedRevision };
  if (existing) {
    // Validate the original operation fingerprint before touching storage. A
    // replayed successful install must not rebuild a missing/cleared evidence
    // database or apply today's different storage policy as a hidden new write.
    const configuration = await commitConfigChange(store, command);
    const current = await readMonitorServiceConfiguration(input.durableRoot);
    return { state: "configured" as const, database: { state: "not_reinitialized" as const }, configuration,
      currentMatches: current?.runRoot === runRoot && canonicalJson(current.agentIds) === canonicalJson(agentIds),
      serviceStarted: false, notificationsChanged: false, bootInstallation: "external_service_owner_required" as const };
  }
  const storage = await readStorageConfiguration(input.durableRoot);
  // Explicit install is allowed to initialize/migrate the observation DB, never
  // an implicit status/read or management Server startup. Existing active collectors block
  // migrations in the DB owner's existing implementation.
  const database = await openMonitorStore(input.durableRoot, storage.monitor).initialize();
  let configuration: ConfigCommitReceipt;
  try {
    configuration = await commitConfigChange(store, command);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config_commit_unknown", "monitor_initialized_configuration_requires_reconciliation", { operationId: input.operationId });
  }
  const current = await readMonitorServiceConfiguration(input.durableRoot);
  return { state: "configured" as const, database, configuration,
    currentMatches: current?.runRoot === runRoot && canonicalJson(current.agentIds) === canonicalJson(agentIds),
    serviceStarted: false, notificationsChanged: false, bootInstallation: "external_service_owner_required" as const };
}
