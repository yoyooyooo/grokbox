import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  commitConfigChange, openConfigStore, readConfigLayout, readInstallation,
  installConfigurationResources,
} from "@grokbox/box-runtime/runtime";
import {
  ConfigError, configSchemaAt, validateNode, validateDaemonIntent,
  type ConfigCommitReceipt,
} from "@grokbox/runtime-kernel/config";
import { CliError } from "../errors.ts";
import { isRecord } from "../util.ts";

export type DaemonNetworkConfig = { host: "127.0.0.1"; port: number; tokenSha256: string };
export type DaemonServeConfig = { httpsPort: number; dnsName: string; proxyUrl: string };
export type DaemonFilesystemRootConfig = { name: string; path: string; operations: Array<"stat" | "list" | "read" | "download" | "write" | "mkdir" | "upload" | "remove" | "remove-recursive" | "exec"> };
export type DaemonFilesystemConfig = { roots: DaemonFilesystemRootConfig[] };
export type DaemonProcessConfig = { cwdRoots: string[]; defaultCwdRoot: string; executables: Array<{ name: string; path: string }>;
  environment: string[]; maxConcurrent: number; maxQueued: number; maxRuntimeMs: number; maxOutputBytes: number; shell?: { executable: string } };
export type DaemonDesktopConfig = { stopWindowPath?: string; floorAgentIds?: string[]; keepAgentIds?: string[]; minIdleMs?: number; pruneEnabled?: boolean };
/** Daemon launch resources, assembled from intent and installation security state.
 * This is not an on-disk daemon config or a second source of user preferences. */
export type DaemonConfig = { version: 1; network?: DaemonNetworkConfig; serve?: DaemonServeConfig;
  filesystem?: DaemonFilesystemConfig; process?: DaemonProcessConfig; desktop?: DaemonDesktopConfig;
  observation?: { runRoot: string; agentIds: string[] } };

export function validateDaemonConfig(input: unknown): DaemonConfig {
  if (!isRecord(input) || input.version !== 1 || Object.keys(input).some((key) => !["version", "network", "serve", "filesystem", "process", "desktop", "observation"].includes(key))) throw new CliError("profile_invalid", "Invalid daemon launch resources.");
  const resources = structuredClone(input);
  const intent: Record<string, unknown> = {};
  for (const key of ["serve", "filesystem", "process", "observation"]) if (input[key] !== undefined) intent[key] = input[key];
  if (input.network !== undefined) {
    const network = input.network;
    if (!isRecord(network) || Object.keys(network).some((key) => !["host", "port", "tokenSha256"].includes(key)) || typeof network.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(network.tokenSha256)) throw new CliError("profile_invalid", "Daemon credential verifier is invalid.");
    intent.network = { host: network.host, port: network.port };
  }
  try { validateDaemonIntent(intent); }
  catch { throw new CliError("profile_invalid", "Daemon policy does not satisfy the shared configuration schema."); }
  if (resources.desktop !== undefined) {
    const desktop = resources.desktop;
    if (!isRecord(desktop) || Object.keys(desktop).some((key) => !["stopWindowPath", "floorAgentIds", "keepAgentIds", "minIdleMs", "pruneEnabled"].includes(key))) throw new CliError("profile_invalid", "Invalid desktop policy.");
    for (const field of ["keepAgentIds", "floorAgentIds"] as const) {
      if (Array.isArray(desktop[field])) desktop[field] = (desktop[field] as unknown[]).map((value) => typeof value === "string" ? value.toLowerCase() : value);
    }
    try {
      validateNode({
        idleReclaim: { ...(desktop.pruneEnabled !== undefined ? { enabled: desktop.pruneEnabled } : {}), ...(desktop.minIdleMs !== undefined ? { minIdleMs: desktop.minIdleMs } : {}) },
        ...(desktop.keepAgentIds !== undefined ? { keepAgentIds: desktop.keepAgentIds } : {}),
      }, configSchemaAt(["desktop"]));
      if (desktop.floorAgentIds !== undefined) validateNode(desktop.floorAgentIds, configSchemaAt(["desktop", "keepAgentIds"]));
    } catch { throw new CliError("profile_invalid", "Desktop policy does not satisfy the shared configuration schema."); }
    if (desktop.stopWindowPath !== undefined && (typeof desktop.stopWindowPath !== "string" || !isAbsolute(desktop.stopWindowPath) || desktop.stopWindowPath.includes("\0"))) throw new CliError("profile_invalid", "Stop-window executable must be an absolute path.");
  }
  return resources as DaemonConfig;
}

export async function readDaemonConfig(configDir: string): Promise<DaemonConfig> {
  const layout = await readConfigLayout(configDir);
  const { document } = await openConfigStore(layout).read();
  const installation = layout.role === "box" ? await readInstallation(layout.root) : undefined;
  const intent = document.daemon;
  const tokenSha256 = installation?.daemon?.tokenSha256;
  if (intent?.network && !tokenSha256) throw new CliError("daemon_credential_required", "The listener requires an installed credential verifier.");
  const desktop = document.desktop;
  const security = installation?.desktop;
  return {
    version: 1, ...(intent as Omit<DaemonConfig, "version" | "network" | "desktop">),
    ...(intent?.network && tokenSha256 ? { network: { ...intent.network, tokenSha256 } } : {}),
    ...(desktop || security ? { desktop: {
      ...security,
      ...(desktop?.keepAgentIds !== undefined ? { keepAgentIds: [...desktop.keepAgentIds] } : {}),
      ...(desktop?.idleReclaim?.enabled !== undefined ? { pruneEnabled: desktop.idleReclaim.enabled } : {}),
      ...(desktop?.idleReclaim?.minIdleMs !== undefined ? { minIdleMs: desktop.idleReclaim.minIdleMs } : {}),
    } } : {}),
  };
}

/** Explicit installation boundary for bootstrap/test installations. Operational
 * keep/on/off writers must use the field/domain commands below instead. */
export async function writeDaemonConfig(configDir: string, resources: DaemonConfig, durableRoot?: string, operationId: string = randomUUID()): Promise<void> {
  const config = validateDaemonConfig(resources);
  const existing = await readConfigLayout(configDir);
  const root = durableRoot ? resolve(durableRoot) : existing.role === "box" ? existing.root : resolve(configDir);
  await installConfigurationResources({ configDir, root, operationId }, {
    daemon: {
      ...(config.network ? { network: { host: config.network.host, port: config.network.port } } : {}),
      ...(config.serve ? { serve: config.serve } : {}), ...(config.filesystem ? { filesystem: config.filesystem } : {}),
      ...(config.process ? { process: config.process } : {}),
      ...(config.observation ? { observation: config.observation } : {}),
    },
    ...(config.desktop ? { desktop: {
      idleReclaim: { ...(config.desktop.pruneEnabled !== undefined ? { enabled: config.desktop.pruneEnabled } : {}),
        ...(config.desktop.minIdleMs !== undefined ? { minIdleMs: config.desktop.minIdleMs } : {}) },
      ...(config.desktop.keepAgentIds !== undefined ? { keepAgentIds: config.desktop.keepAgentIds } : {}),
    } } : {}),
    security: {
      ...(config.network ? { daemon: { tokenSha256: config.network.tokenSha256 } } : {}),
      ...(config.desktop ? { desktop: {
        ...(config.desktop.floorAgentIds !== undefined ? { floorAgentIds: config.desktop.floorAgentIds } : {}),
        ...(config.desktop.stopWindowPath ? { stopWindowPath: config.desktop.stopWindowPath } : {}),
      } } : {}),
    },
  });
}

export async function setDesktopEnabled(configDir: string, enabled: boolean): Promise<ConfigCommitReceipt> {
  const layout = await readConfigLayout(configDir);
  if (layout.role !== "box") throw new ConfigError("config_scope_unavailable", "Desktop configuration requires a Box installation.");
  return await commitConfigChange(openConfigStore(layout), { operationId: randomUUID(), scope: "box", kind: "set", path: "desktop.idleReclaim.enabled", value: enabled });
}
export async function changeDesktopKeep(configDir: string, agentId: string, action: "add" | "remove", confirm = false): Promise<ConfigCommitReceipt> {
  const layout = await readConfigLayout(configDir);
  if (layout.role !== "box") throw new ConfigError("config_scope_unavailable", "Desktop keep requires a Box installation.");
  return await commitConfigChange(openConfigStore(layout), { operationId: randomUUID(), scope: "box", kind: "keep", agentId, action, confirm });
}
