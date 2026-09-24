import { Effect } from "effect";
import { ConfigurationWrite } from "../../ports.ts";
import { canonicalJson } from "../../hash.ts";
import { ConfigError, configPathTokens, getConfigValue, isObject, replaceConfigValue, type JsonObject } from "../config/path.ts";
import { CONFIG_SCHEMA_VERSION, CONFIG_SCHEMA, configSchemaAt, effectiveOps, validateConfig, type UnifiedConfig } from "../config/schema.ts";
import { changedConfigPaths } from "../config/revision.ts";
import { botProtection, continuityProtection } from "../continuity/protection.ts";

export type NotificationSettingsChange = {
  alias: string; agentId: string; routineKey: string; mode: "off" | "actionable-user";
  installationBudget: number; targetBudget: number;
};

export type ConfigChange = {
  operationId: string;
  expectedRevision?: string;
  scope: "client" | "box" | "target";
  confirm?: boolean;
  replaceArrays?: boolean;
} & (
  | { kind: "domain"; domain: "daemon" | "runtime" | "ops" | "storage" | "materials"; mode: "patch" | "replace" | "reset"; value?: unknown }
  | { kind: "connection"; name: string; connection: { endpoint: string; installationId: string; credentialRef: string } | null }
  | { kind: "set"; path: string; value: unknown }
  | { kind: "unset"; path: string }
  | { kind: "replace"; value: unknown }
  | { kind: "preset"; preset: "user" | "maintainer"; resetOverrides?: boolean }
  | { kind: "keep"; action: "add" | "remove"; agentId: string }
  | { kind: "notification-settings"; settings: NotificationSettingsChange }
  | { kind: "protection-settings"; change: { action: "system"; enabled: boolean } | { action: "set"; agentId: string; patch: unknown } | { action: "reset"; agentId: string } }
);
export type ConfigCommitReceipt = {
  operationId: string;
  scope: ConfigChange["scope"];
  document: "config";
  commit: "committed" | "unchanged";
  configRevision: string;
  changedPaths: string[];
  applicationRevisions?: Partial<Record<"desktop" | "daemon" | "runtime" | "ops" | "storage", string>>;
  application: { state: "not-required" | "pending" | "applied" | "restart-required"; reason?: string };
};

function requiresConfirmation(before: UnifiedConfig, next: UnifiedConfig, paths: readonly string[]): boolean {
  // Desktop helper effects can remove per-display browser profiles. Generic
  // config writes must not bypass the management domain's explicit approval.
  if (next.desktop?.idleReclaim?.enabled === true && before.desktop?.idleReclaim?.enabled !== true) return true;
  if ((before.desktop?.keepAgentIds ?? []).some(id => !(next.desktop?.keepAgentIds ?? []).includes(id))) return true;
  if ((next.desktop?.idleReclaim?.minIdleMs ?? 600000) < (before.desktop?.idleReclaim?.minIdleMs ?? 600000)) return true;
  // Context policy can enable paid summaries or enlarge their request budget.
  // Require an explicit impact acknowledgement, including parent replacement/unset.
  if (paths.some(path => path === "/runtime/context" || path.startsWith("/runtime/context/") || path === "/runtime/continuity" || path.startsWith("/runtime/continuity/"))) return true;
  // Lowering retention can destroy evidence; raising budgets consumes disk.
  // Parent unset/replacement must not bypass the same preview boundary.
  if (paths.some(path => path === "/storage" || path.startsWith("/storage/") || path === "/materials" || path.startsWith("/materials/"))) return true;
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
  return paths.some((path) => path.startsWith("/client/") && /(?:Ref|Url|sshHost)$/.test(path));
}

/** Called on the latest document *inside* the one cooperative commit lock. */
export function applyConfigChange(current: UnifiedConfig, command: ConfigChange): { document: UnifiedConfig; changedPaths: string[] } {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(command.operationId)) throw new ConfigError("config_invalid", "Invalid configuration operation identity.");
  let candidate: unknown;
  if (command.kind === "domain") {
    if (command.scope !== "target" || !command.confirm || !command.expectedRevision
      || !["daemon", "runtime", "ops", "storage", "materials"].includes(command.domain)) throw new ConfigError("config_invalid", "Invalid target config domain.");
    const merge = (before: unknown, patch: unknown): unknown => {
      if (!isObject(patch)) return patch;
      const merged: Record<string, unknown> = isObject(before) ? { ...before } : {};
      for (const [key, value] of Object.entries(patch)) {
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new ConfigError("config_invalid", "Invalid configuration member.");
        merged[key] = merge(merged[key], value);
      }
      return merged;
    };
    if (command.mode !== "reset" && !isObject(command.value)) throw new ConfigError("config_invalid", "Config domain declarations must be objects.");
    candidate = replaceConfigValue(current, [command.domain], command.mode === "patch"
      ? merge(current[command.domain], command.value) : command.value, command.mode === "reset");
  } else if (command.kind === "connection") {
    if (command.scope !== "client" || !command.confirm || !command.expectedRevision
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(command.name)
      || ["__proto__", "constructor", "prototype"].includes(command.name)) throw new ConfigError("config_invalid", "Invalid explicit connection change.");
    const profiles = { ...current.client.profiles };
    if (command.connection === null) {
      if (command.name === "default" || current.client.currentProfile === command.name) throw new ConfigError("config_conflict", "The fixed local or legacy-selected connection cannot be deleted.");
      delete profiles[command.name];
    } else {
      profiles[command.name] = { ...profiles[command.name], serverUrl: command.connection.endpoint,
        installationId: command.connection.installationId, daemonTokenRef: command.connection.credentialRef };
    }
    candidate = { ...current, client: { ...current.client, profiles } };
  } else if (command.kind === "protection-settings") {
    const c = command.change;
    if (!command.confirm || !command.expectedRevision || command.scope !== "box" || !isObject(c)) throw new ConfigError("config_invalid","Protection changes require explicit confirmed scope and revision.");
    const previous = current.runtime?.continuity ?? {}, bots: Record<string,unknown> = { ...(isObject(previous.bots) ? previous.bots : {}) };
    if (c.action === "system") {
      if (Object.keys(c).some(k=>!["action","enabled"].includes(k)) || typeof c.enabled !== "boolean") throw new ConfigError("config_invalid","Invalid protection policy.");
      candidate = { ...current, runtime: { ...current.runtime, continuity: { ...previous, enabled: c.enabled } } };
    } else {
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c.agentId) || Object.keys(c).some(k=>!["action","agentId",...(c.action==="set"?["patch"]:[])].includes(k))) throw new ConfigError("config_invalid","Invalid protection target.");
      if (c.action === "reset") delete bots[c.agentId];
      else if (c.action === "set" && isObject(c.patch)) {
        const selected = bots[c.agentId], prior = isObject(selected) ? selected : {};
        // Preserve other Bot overrides and any omitted handover policy. Only
        // reset removes an override; it never deletes snapshots or native data.
        const next = { ...prior, ...c.patch, ...(c.patch.handover === undefined ? {} : { handover: { ...(isObject(prior.handover)?prior.handover:{}), ...(isObject(c.patch.handover)?c.patch.handover:{}) } }) };
        botProtection(c.patch); botProtection(next); bots[c.agentId] = next;
      } else throw new ConfigError("config_invalid","Invalid protection change.");
      candidate = { ...current, runtime: { ...current.runtime, continuity: { ...previous, bots } } };
    }
    continuityProtection((candidate as UnifiedConfig).runtime?.continuity);
  } else if (command.kind === "notification-settings") {
    const s = command.settings;
    if (!command.confirm || !command.expectedRevision || command.scope !== "box" || !s
      || Object.keys(s).some(k => !["alias", "agentId", "routineKey", "mode", "installationBudget", "targetBudget"].includes(k))
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(s.alias) || !/^[a-z][a-z0-9_-]{0,63}$/.test(s.routineKey)
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s.agentId)
      || !["off", "actionable-user"].includes(s.mode)
      || ![s.installationBudget, s.targetBudget].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000)) {
      throw new ConfigError("config_invalid", "Invalid explicit notification settings.");
    }
    const ops = current.ops ?? {}, targets = isObject(ops.targets) ? ops.targets : {};
    const targetBefore = targets[s.alias];
    // A narrow domain update, not wholesale ops replacement. Preserve other
    // targets, monitor/protection policy and routing rules. Configuration is
    // not a private receiver grant, Routine change or credential request.
    candidate = { ...current, ops: { ...ops,
      notifications: { ...(isObject(ops.notifications) ? ops.notifications : {}), mode: s.mode, maxAutomaticWakeupsPerDay: s.installationBudget },
      routing: { ...(isObject(ops.routing) ? ops.routing : {}), defaultTarget: s.alias },
      targets: { ...targets, [s.alias]: { ...(isObject(targetBefore) ? targetBefore : {}),
        enabled: true, agentId: s.agentId, routineKey: s.routineKey, maxAutomaticWakeupsPerDay: s.targetBudget } },
    } };
  } else if (command.kind === "replace") {
    if (!command.confirm || !command.expectedRevision) throw new ConfigError("config_conflict", "Document replacement requires confirmation and expected revision.");
    if (command.scope === "target") {
      if (!isObject(command.value) || Object.hasOwn(command.value, "client")) throw new ConfigError("config_scope_unavailable", "Target apply cannot replace client profiles.");
      candidate = { ...command.value, schemaVersion: CONFIG_SCHEMA_VERSION, client: current.client };
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
  if (command.kind === "domain") {
    const beforeOps = effectiveOps(current.ops), afterOps = effectiveOps(document.ops);
    const protectedValues = [
      [current.runtime?.continuity, document.runtime?.continuity],
      // Defaults and presets participate in notification eligibility and its
      // retained authorization revision, even when raw subtrees are unchanged.
      ...["enabled", "preset", "presetRevision", "notifications", "targets", "routing"].map(key => [beforeOps[key], afterOps[key]]),
    ];
    if (protectedValues.some(([before, after]) => canonicalJson(before ?? null) !== canonicalJson(after ?? null))) {
      throw new ConfigError("config_scope_unavailable", "Use the protection or notification settings domain for its managed policy.");
    }
  }
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
