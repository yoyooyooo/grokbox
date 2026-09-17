import { Effect } from "effect";
import { ConfigurationWrite } from "../../ports.ts";
import { canonicalJson } from "../../hash.ts";
import { ConfigError, configPathTokens, getConfigValue, isObject, replaceConfigValue, type JsonObject } from "../config/path.ts";
import { CONFIG_SCHEMA, configSchemaAt, effectiveOps, validateConfig, type UnifiedConfig } from "../config/schema.ts";
import { changedConfigPaths } from "../config/revision.ts";

export type ConfigChange = {
  operationId: string;
  expectedRevision?: string;
  scope: "client" | "box" | "target";
  confirm?: boolean;
  replaceArrays?: boolean;
} & (
  | { kind: "set"; path: string; value: unknown }
  | { kind: "unset"; path: string }
  | { kind: "replace"; value: unknown }
  | { kind: "preset"; preset: "user" | "maintainer"; resetOverrides?: boolean }
  | { kind: "keep"; action: "add" | "remove"; agentId: string }
);
export type ConfigCommitReceipt = {
  operationId: string;
  scope: ConfigChange["scope"];
  document: "config";
  commit: "committed" | "unchanged";
  configRevision: string;
  changedPaths: string[];
  applicationRevisions?: Partial<Record<"desktop" | "daemon" | "runtime" | "ops", string>>;
  application: { state: "not-required" | "pending" | "applied" | "restart-required"; reason?: string };
};

function requiresConfirmation(before: UnifiedConfig, next: UnifiedConfig, paths: readonly string[]): boolean {
  if (paths.some((path) => path.startsWith("/daemon/") || /\/(?:agentId|routineKey|allowedIntents|dataPolicy|reportTarget|fallbackTargets|credentialRef|repository)$/.test(path))) return true;
  if (paths.some((path) => /(?:maxAutomaticWakeupsPerDay|criticalReservePerDay)$/.test(path))) return true;
  const left = effectiveOps(before.ops); const right = effectiveOps(next.ops);
  if (left.enabled === false && right.enabled === true) return true;
  const oldNotifications = left.notifications as JsonObject; const newNotifications = right.notifications as JsonObject;
  if (oldNotifications.mode === "off" && newNotifications.mode !== "off") return true;
  if (newNotifications.digest === true && oldNotifications.digest !== true) return true;
  const oldTargets = left.targets as JsonObject; const newTargets = right.targets as JsonObject;
  for (const [key, value] of Object.entries(newTargets)) {
    if ((value as JsonObject).enabled === true && isObject(oldTargets[key]) && (oldTargets[key] as JsonObject).enabled === false) return true;
  }
  if ((right.diagnostics as JsonObject).mode === "automatic-bounded" && (left.diagnostics as JsonObject).mode !== "automatic-bounded") return true;
  if ((right.canary as JsonObject).enabled && !(left.canary as JsonObject).enabled) return true;
  if ((right.maintenance as JsonObject).mode === "low-risk" && (left.maintenance as JsonObject).mode !== "low-risk") return true;
  if ((right.support as JsonObject).submit === "preauthorized-summary" && (left.support as JsonObject).submit !== "preauthorized-summary") return true;
  return paths.some((path) => path.startsWith("/client/") && /(?:Ref|Url|sshHost)$/.test(path));
}

/** Called on the latest document *inside* the one cooperative commit lock. */
export function applyConfigChange(current: UnifiedConfig, command: ConfigChange): { document: UnifiedConfig; changedPaths: string[] } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(command.operationId)) throw new ConfigError("config_invalid", "Invalid configuration operation identity.");
  let candidate: unknown;
  if (command.kind === "replace") {
    if (!command.confirm || !command.expectedRevision) throw new ConfigError("config_conflict", "Document replacement requires confirmation and expected revision.");
    if (command.scope === "target") {
      if (!isObject(command.value) || Object.hasOwn(command.value, "client")) throw new ConfigError("config_scope_unavailable", "Target apply cannot replace client profiles.");
      candidate = { ...command.value, schemaVersion: 2, client: current.client };
    } else candidate = command.value;
  } else if (command.kind === "preset") {
    if (!command.confirm) throw new ConfigError("config_conflict", "Changing preset requires confirmation.");
    if (command.resetOverrides && !command.expectedRevision) throw new ConfigError("config_conflict", "Resetting overrides requires expected revision.");
    candidate = { ...current, ops: { ...(command.resetOverrides ? {} : current.ops), preset: command.preset, presetRevision: 1 } };
  } else if (command.kind === "keep") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(command.agentId)) throw new ConfigError("config_invalid", "Keep requires a canonical Agent UUID.");
    if (command.action === "remove" && !command.confirm) throw new ConfigError("config_conflict", "Removing keep protection requires confirmation.");
    const keep = current.desktop?.keepAgentIds ?? [];
    candidate = { ...current, desktop: { ...current.desktop, keepAgentIds: command.action === "add"
      ? [...new Set([...keep, command.agentId])].sort() : keep.filter((id) => id !== command.agentId) } };
  } else {
    const tokens = configPathTokens(command.path);
    const node = configSchemaAt(tokens);
    if (!tokens.length || tokens[0] === "schemaVersion") throw new ConfigError("config_path_invalid", "Use config apply for a complete document.");
    if (command.kind === "unset") {
      const parent = tokens.length > 1 ? configSchemaAt(tokens.slice(0, -1)) : CONFIG_SCHEMA;
      if (parent.required?.includes(tokens[tokens.length - 1]!)) throw new ConfigError("config_path_invalid", "Cannot unset a required configuration member.");
      candidate = replaceConfigValue(current, tokens, undefined, true);
    } else {
      if (node.sensitive && !command.confirm) throw new ConfigError("config_conflict", "Changing connection references requires confirmation.");
      candidate = replaceConfigValue(current, tokens, command.value);
    }
  }
  const document = validateConfig(candidate);
  const paths = changedConfigPaths(current, document);
  if (command.scope === "client" && paths.some((path) => !path.startsWith("/client/"))) throw new ConfigError("config_scope_unavailable", "This operation requires a qualified Box configuration scope.");
  if (command.scope === "target" && paths.some((path) => path.startsWith("/client/"))) throw new ConfigError("config_scope_unavailable", "Client profiles belong to the initiating machine.");
  if (paths.includes("/schemaVersion")) throw new ConfigError("config_path_invalid", "Schema version changes require migration.");
  if (command.kind !== "keep") {
    for (const path of paths) {
      const tokens = configPathTokens(path);
      if (Array.isArray(getConfigValue(current, tokens)) || Array.isArray(getConfigValue(document, tokens))) {
        if (!command.replaceArrays || !command.confirm || !command.expectedRevision) throw new ConfigError("config_conflict", "Array replacement requires --replace, confirmation and expected revision.");
      }
    }
  }
  if (requiresConfirmation(current, document, paths) && !command.confirm) throw new ConfigError("config_conflict", "This configuration change requires an impact preview and confirmation.");
  return { document, changedPaths: paths };
}

export function configApplication(paths: readonly string[]): ConfigCommitReceipt["application"] {
  if (!paths.length || paths.every((path) => path.startsWith("/client/"))) return { state: "not-required" };
  if (paths.some((path) => path === "/daemon" || path.startsWith("/daemon/"))) return { state: "restart-required", reason: "daemon-policy-changed" };
  return { state: "pending", reason: "consumer-not-observed" };
}

export function runConfigChange(command: ConfigChange) {
  return Effect.gen(function* () {
    const resource = yield* ConfigurationWrite;
    if (!resource.changeConfig) return yield* Effect.fail(new ConfigError("config_scope_unavailable", "Configuration change capability is unavailable."));
    return yield* resource.changeConfig(command);
  });
}
export function configChangeFingerprint(command: ConfigChange): string {
  // operationId and expected revision remain part of the identity: retry means
  // exactly the same admitted operation, never rebasing an old write silently.
  return canonicalJson(command);
}
