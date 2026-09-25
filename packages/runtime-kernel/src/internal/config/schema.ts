import { ConfigError, FORBIDDEN_CONFIG_KEYS, isObject, type JsonObject, type JsonValue } from "./path.ts";
import { validateContextIntent, type ContextIntent } from "./context-policy.ts";
import { effectiveStorage, type StorageIntent } from "./storage-policy.ts";
import { MIB, OBSERVATION_RETENTION } from "../observation/retention-policy.ts";
import { CONFIG_SCHEMA_VERSION } from "./version.ts";
export { CONFIG_SCHEMA_VERSION } from "./version.ts";

export type ConnectionProfile = {
  transport?: "auto" | "daemon" | "local" | "gateway";
  serverUrl?: string; daemonTokenRef?: string; daemonSocket?: string; installationId?: string;
  gatewayUrl?: string; gatewayTokenRef?: string; gatewayHeadersRef?: string; gatewayDiscovery?: string;
  sshHost?: string;
  sandbox?: { accessTokenRef?: string; keepaliveIntervalMs?: number };
  quota?: { source: "cursor-web"; accessTokenRef: string };
};
export type FilesystemPolicy = { roots: Array<{ name: string; path: string; operations: string[] }> };
export type ProcessPolicy = {
  cwdRoots: string[]; defaultCwdRoot: string; executables: Array<{ name: string; path: string }>;
  environment: string[]; maxConcurrent: number; maxQueued: number; maxRuntimeMs: number;
  maxOutputBytes: number; shell?: { executable: string };
};
export type DaemonObservationIntent = { runRoot: string; agentIds: string[] };
export type DaemonIntent = {
  observation?: DaemonObservationIntent;
  network?: { host: "127.0.0.1"; port: number };
  filesystem?: FilesystemPolicy;
  process?: ProcessPolicy;
};
export type DesktopIntent = {
  idleReclaim?: { enabled?: boolean; minIdleMs?: number };
  keepAgentIds?: string[];
};
export type UnifiedConfig = {
  materials?: import("../../materials.ts").MaterialsConfiguration;
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  client: { currentProfile: string; profiles: Record<string, ConnectionProfile> };
  daemon?: DaemonIntent;
  desktop?: DesktopIntent;
  runtime?: { desiredMode?: "disabled" | "observe" | "identity" | "route"; context?: ContextIntent; continuity?: JsonObject };
  ops?: JsonObject;
  storage?: StorageIntent;
};
export type SchemaNode = {
  type: "object" | "map" | "array" | "string" | "integer" | "boolean";
  properties?: Record<string, SchemaNode>; values?: SchemaNode; items?: SchemaNode;
  required?: string[]; enum?: readonly (string | number)[]; min?: number; max?: number;
  pattern?: string; format?: "path" | "url" | "secret" | "ssh" | "repository";
  unique?: boolean; sensitive?: boolean; dangerous?: boolean;
};
const object = (properties: Record<string, SchemaNode>, required: string[] = []): SchemaNode => ({ type: "object", properties, required });
const string = (max = 256, pattern?: string): SchemaNode => ({ type: "string", min: 1, max, ...(pattern ? { pattern } : {}) });
const integer = (min: number, max: number): SchemaNode => ({ type: "integer", min, max });
const boolean: SchemaNode = { type: "boolean" };
const enumeration = (...values: string[]): SchemaNode => ({ type: "string", enum: values });
const array = (items: SchemaNode, max: number, min = 0): SchemaNode => ({ type: "array", items, max, min, unique: true });
const map = (values: SchemaNode, max: number, pattern: string): SchemaNode => ({ type: "map", values, max, pattern });
const path: SchemaNode = { ...string(4096), format: "path", sensitive: true };
const secret: SchemaNode = { ...string(4096), format: "secret", sensitive: true, dangerous: true };
const url: SchemaNode = { ...string(4096), format: "url", sensitive: true, dangerous: true };
const uuid = string(36, "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
export const TARGET_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";
export const PROFILE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
export const OPS_INTENTS = ["brief-notice", "diagnose-or-report", "maintainer-digest", "report-result"] as const;
export const OPS_SOURCE_KINDS = ["host-seam", "runtime", "ownership", "provider", "observer", "controller", "support"] as const;
export const OPS_SEVERITIES = ["notice", "warning", "error", "critical"] as const;
const profile = object({
  transport: enumeration("auto", "daemon", "local", "gateway"), serverUrl: url,
  installationId: { ...string(36, "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"), sensitive: true },
  daemonTokenRef: secret, daemonSocket: path, gatewayUrl: url, gatewayTokenRef: secret,
  gatewayHeadersRef: secret, gatewayDiscovery: path,
  sshHost: { ...string(255), format: "ssh", sensitive: true },
  sandbox: object({ accessTokenRef: secret, keepaliveIntervalMs: integer(1000, 86_400_000) }),
  quota: object({ source: enumeration("cursor-web"), accessTokenRef: secret }, ["source", "accessTokenRef"]),
});
export const DAEMON_INTENT_SCHEMA = object({
  observation: object({ runRoot: path, agentIds: array({ ...uuid, sensitive: true }, 32) }, ["runRoot", "agentIds"]),
  network: object({ host: enumeration("127.0.0.1"), port: integer(1, 65535) }, ["host", "port"]),
  filesystem: object({ roots: array(object({
    name: string(32, "^[a-z][a-z0-9-]{0,31}$"), path,
    operations: array(enumeration("stat", "list", "read", "download", "write", "mkdir", "upload", "remove", "remove-recursive", "restore", "exec"), 11, 1),
  }, ["name", "path", "operations"]), 16) }, ["roots"]),
  process: object({
    cwdRoots: array(string(32), 16, 1), defaultCwdRoot: string(32),
    executables: array(object({ name: string(32, "^[a-z][a-z0-9._-]{0,63}$"), path }, ["name", "path"]), 64, 1),
    environment: array(string(64, "^[A-Z_][A-Z0-9_]{0,63}$"), 32),
    maxConcurrent: integer(1, 16), maxQueued: integer(1, 256), maxRuntimeMs: integer(100, 86_400_000),
    maxOutputBytes: integer(1024, 8 * 1024 * 1024), shell: object({ executable: path }, ["executable"]),
  }, ["cwdRoots", "defaultCwdRoot", "executables", "environment", "maxConcurrent", "maxQueued", "maxRuntimeMs", "maxOutputBytes"]),
});
DAEMON_INTENT_SCHEMA.dangerous = true;
const target = object({
  enabled: boolean, agentId: { ...uuid, sensitive: true }, routineKey: string(64, "^[a-z][a-z0-9_-]{0,63}$"),
  allowedIntents: array(enumeration(...OPS_INTENTS), OPS_INTENTS.length, 1),
  dataPolicy: enumeration("safe-summary", "diagnostic-summary"),
  maxAutomaticWakeupsPerDay: integer(0, 1000), modelChangePolicy: enumeration("require-rebind"),
});
const rule = object({
  id: string(64, "^[a-z][a-z0-9_-]{0,63}$"), enabled: boolean,
  when: object({ intents: array(enumeration(...OPS_INTENTS), 4, 1), sourceKinds: array(enumeration(...OPS_SOURCE_KINDS), 7, 1),
    severities: array(enumeration(...OPS_SEVERITIES), 4, 1), audiences: array(enumeration("user", "maintainer"), 2, 1),
    incidentRules: array(string(96, "^[a-z][a-z0-9._-]{0,95}$"), 32, 1),
  }),
  action: object({ type: enumeration("deliver", "suppress"), target: string(32, TARGET_NAME_PATTERN),
    fallbackTargets: array(string(32, TARGET_NAME_PATTERN), 2),
  }, ["type"]),
}, ["id", "when", "action"]);
export const OPS_SCHEMA = object({
  enabled: boolean, preset: enumeration("user", "maintainer"), presetRevision: { type: "integer", enum: [1] },
  observation: object({ enabled: boolean }),
  maintainer: object({ enabled: boolean, target: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" },
    maxAutomaticWakeupsPerDay: integer(0, 1000) }),
  monitor: object({ enabled: boolean, deepReplay: boolean, upstreamAdvisory: boolean, intervalMs: integer(10_000, 300_000) }),
  notifications: object({ mode: enumeration("off", "actionable-user"), channel: enumeration("bot-webhook"),
    maxAutomaticWakeupsPerDay: integer(0, 1000), criticalReservePerDay: integer(0, 100),
    digest: boolean, allowDuplicateDelivery: boolean }),
  diagnostics: object({ mode: enumeration("off", "on-request", "automatic-bounded") }),
  canary: object({ enabled: boolean }), maintenance: object({ mode: enumeration("off", "low-risk") }),
  targets: map(target, 8, TARGET_NAME_PATTERN),
  routing: object({ enabled: boolean, defaultTarget: string(32, TARGET_NAME_PATTERN),
    reportTarget: string(32, TARGET_NAME_PATTERN), rules: array(rule, 32) }),
});
const contextOverride = object({
  windowTokens: integer(1024, 16777216),
  compaction: object({ mode: enumeration("auto", "manual"), reserveTokens: integer(1, 16777215), keepRecentTokens: integer(0, 16777215),
    limits: object({ maxSummaryRequests: integer(1, 64), maxSummaryInputTokens: integer(1, 16777216), timeoutMs: integer(1000, 120000) }),
  }),
});
export const CONTEXT_SCHEMA = object({ ...contextOverride.properties,
  models: map(contextOverride, 128, "^[^\\x00-\\x1f]{1,256}$"),
  agents: { ...map(contextOverride, 1024, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"), sensitive: true },
});
export const CONTINUITY_SCHEMA = object({
  enabled: boolean, intervalMs: integer(10000, 300000),
  bots: { ...map(object({ enabled: boolean, mode: enumeration("alert", "prepare", "auto-replace"), tier: enumeration("observe", "memory", "resume", "archive"),
    pauseOnOwnershipLoss: boolean, captureIntervalMs: integer(10000, 86400000), maxReplacementsPerDay: integer(0, 16), cooldownMs: integer(60000, 86400000),
    handover: object({ routines: enumeration("move", "keep-source"), groups: boolean, directMessages: boolean, oldBotAssistance: boolean,
      titles: boolean, sidebar: boolean, allowUserMessages: boolean, automaticDelete: boolean,
      minGraceMs: integer(60000, 90 * 86400000), quietMs: integer(60000, 90 * 86400000) }),
  }), 128, "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"), sensitive: true },
});
CONTINUITY_SCHEMA.dangerous = true;
export const STORAGE_SCHEMA = object({
  policyRevision: { type: "integer", enum: [1] },
  diagnostics: object({ targetBytes: integer(MIB, OBSERVATION_RETENTION.maxBytes), maxBytes: integer(4 * MIB, OBSERVATION_RETENTION.maxBytes),
    reserveBytes: integer(MIB, OBSERVATION_RETENTION.maxBytes), detailDays: integer(1, 30), summaryDays: integer(1, 365) }),
  retention: object({
    monitor: object({ maxBytes: integer(MIB, OBSERVATION_RETENTION.monitorDatabaseBytes) }),
    journal: object({ segmentBytes: integer(128 * 1024, OBSERVATION_RETENTION.journalSegmentBytes), maxBytes: integer(256 * 1024, OBSERVATION_RETENTION.journalMaxBytes), maxAgeMs: integer(60_000, OBSERVATION_RETENTION.journalMaxAgeMs) }),
    process: object({ segmentBytes: integer(2048, OBSERVATION_RETENTION.processSegmentBytes), maxBytes: integer(4096, OBSERVATION_RETENTION.processMaxBytes), maxAgeMs: integer(60_000, OBSERVATION_RETENTION.journalMaxAgeMs) }),
  }),
});
// Only the explicit migrator can read the retired support shape. It is absent
// from current config paths, effective defaults, exports and execution owners.
const LEGACY_OPS_SCHEMA = object({ ...OPS_SCHEMA.properties,
  support: object({ offerIssue: boolean, draft: enumeration("after-consent"), submit: enumeration("off", "confirm-each", "preauthorized-summary"),
    repository: { ...string(201), format: "repository" }, attachments: enumeration("none"), credentialRef: secret,
    reportProfile: string(64, "^[a-z][a-z0-9._-]{0,63}$") }),
});
export const CONFIG_SCHEMA = object({
  schemaVersion: { type: "integer", enum: [CONFIG_SCHEMA_VERSION] },
  client: object({ currentProfile: string(64, PROFILE_NAME_PATTERN), profiles: map(profile, 64, PROFILE_NAME_PATTERN) }, ["currentProfile", "profiles"]),
  daemon: DAEMON_INTENT_SCHEMA,
  desktop: object({ idleReclaim: object({ enabled: boolean, minIdleMs: integer(600_000, 86_400_000) }), keepAgentIds: array({ ...uuid, sensitive: true }, 64) }),
  runtime: object({ desiredMode: enumeration("disabled", "observe", "identity", "route"), context: CONTEXT_SCHEMA, continuity: CONTINUITY_SCHEMA }),
  ops: OPS_SCHEMA,
  storage: STORAGE_SCHEMA,
  materials: { ...object({ enabled: boolean, intervalMs: integer(10000, 300000), sources: array(object({
    id: string(32, "^[a-z][a-z0-9-]{0,31}$"), kind: enumeration("native-memory", "files"), root: { ...path, sensitive: true },
    accountScope: string(64, "^[a-f0-9]{64}$"), writable: boolean,
    agentIds: array(uuid, 32), projects: array(string(96, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$"), 64),
  }, ["id", "kind", "root", "accountScope"]), 8) }, ["enabled", "intervalMs", "sources"]), dangerous: true },
}, ["schemaVersion", "client"]);

function bad(message = "Configuration does not satisfy its schema."): never { throw new ConfigError("config_invalid", message); }
function absolute(value: string): boolean { return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value); }
export function validateNode(value: unknown, schema: SchemaNode): void {
  if (schema.type === "object" || schema.type === "map") {
    if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype) bad();
    const keys = Object.keys(value);
    if (keys.some((key) => FORBIDDEN_CONFIG_KEYS.has(key))) bad();
    if (schema.type === "object") {
      if (keys.some((key) => !Object.hasOwn(schema.properties!, key)) || schema.required?.some((key) => !Object.hasOwn(value, key))) bad("Unknown or missing configuration member.");
      for (const key of keys) validateNode(value[key], schema.properties![key]!);
    } else {
      if (keys.length > (schema.max ?? 64) || keys.some((key) => !new RegExp(schema.pattern!).test(key))) bad();
      for (const key of keys) validateNode(value[key], schema.values!);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.min ?? 0) || value.length > (schema.max ?? 64)) bad();
    if (schema.unique && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) bad("Duplicate array member.");
    for (const item of value) validateNode(item, schema.items!);
    return;
  }
  if (schema.type === "boolean") { if (typeof value !== "boolean") bad(); return; }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (schema.min ?? -Number.MAX_SAFE_INTEGER) || value > (schema.max ?? Number.MAX_SAFE_INTEGER) || (schema.enum && !schema.enum.includes(value))) bad();
    return;
  }
  if (typeof value !== "string" || value.length < (schema.min ?? 0) || value.length > (schema.max ?? 4096) ||
    /[\u0000-\u001f]/u.test(value) || (schema.enum && !schema.enum.includes(value)) ||
    (schema.pattern && !new RegExp(schema.pattern).test(value))) bad();
  if (schema.format === "path" && !absolute(value)) bad("Path must be absolute.");
  if (schema.format === "repository" && !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9._-]{1,100}$/.test(value)) bad("Repository must be owner/name.");
  if (schema.format === "ssh" && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/.test(value)) bad();
  if (schema.format === "secret" && !(
    /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    (value.startsWith("file:") && absolute(value.slice(5))) || /^keychain:[^/]+\/.+$/.test(value)
  )) bad("Secret values must be protected references.");
  if (schema.format === "url") {
    let parsed: URL; try { parsed = new URL(value); } catch { return bad(); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) bad("Connection URL must not contain credentials or query parameters.");
    if (parsed.protocol === "http:" && !["localhost", "[::1]"].includes(parsed.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(parsed.hostname)) bad("Non-loopback connections require HTTPS.");
  }
}
export function configSchemaAt(tokens: readonly string[]): SchemaNode {
  let schema = CONFIG_SCHEMA;
  for (const key of tokens) {
    if (schema.type === "map") {
      if (!new RegExp(schema.pattern!).test(key) || FORBIDDEN_CONFIG_KEYS.has(key)) throw new ConfigError("config_path_invalid", "Invalid map key.");
      schema = schema.values!;
    } else if (schema.type === "object" && Object.hasOwn(schema.properties!, key)) schema = schema.properties![key]!;
    else throw new ConfigError("config_path_invalid", "Unknown, protected or non-traversable configuration path.");
  }
  return schema;
}
export function defaultConfig(): UnifiedConfig {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, client: { currentProfile: "default", profiles: { default: { transport: "auto" } } } };
}

export function validateDaemonIntent(value: unknown): DaemonIntent {
  validateNode(value, DAEMON_INTENT_SCHEMA);
  const intent = structuredClone(value) as DaemonIntent;
  const roots = intent.filesystem?.roots ?? [];
  if (new Set(roots.map((root) => root.name)).size !== roots.length) bad("Duplicate filesystem root.");
  for (const root of roots) {
    const normalized = root.path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".").join("/");
    const absolutePath = root.path.startsWith("/") ? `/${normalized}` : normalized;
    if (normalized.split("/").includes("..") || ["/", "/dev", "/proc", "/run", "/sys"].some((blocked) => absolutePath === blocked || (blocked !== "/" && absolutePath.startsWith(`${blocked}/`)))) bad("Unsafe filesystem root.");
  }
  if (intent.process) {
    const process = intent.process;
    if (!process.cwdRoots.includes(process.defaultCwdRoot) || process.cwdRoots.some((name) => !roots.find((root) => root.name === name)?.operations.includes("exec"))) bad("Process roots require filesystem exec admission.");
    if (new Set(process.executables.map((entry) => entry.name)).size !== process.executables.length || new Set(process.executables.map((entry) => entry.path)).size !== process.executables.length) bad("Duplicate executable policy.");
    if (process.environment.some((name) => ["PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "NODE_OPTIONS"].includes(name) || /^(LD_|DYLD_)/.test(name))) bad("Unsafe process environment policy.");
  }
  return intent;
}

const DEFAULT_OPS: JsonObject = {
  enabled: true, preset: "user", presetRevision: 1,
  observation: { enabled: true },
  maintainer: { enabled: false, target: "maintainer", maxAutomaticWakeupsPerDay: 2 },
  monitor: { enabled: true, deepReplay: false, upstreamAdvisory: false, intervalMs: 30_000 },
  notifications: { mode: "actionable-user", channel: "bot-webhook", maxAutomaticWakeupsPerDay: 2, criticalReservePerDay: 1, digest: false, allowDuplicateDelivery: false },
  diagnostics: { mode: "on-request" }, canary: { enabled: false }, maintenance: { mode: "off" },
  targets: { default: { enabled: true } }, routing: { enabled: false, defaultTarget: "default", rules: [] },
};
/** Apply defaults only through declared object fields; map entries and arrays replace.
 * This is not an arbitrary deep merge and never copies unknown members. */
function withDefaults(input: Record<string, unknown>, fallback: Record<string, unknown>, schema: SchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema.properties ?? {})) {
    const value = input[key]; const defaults = fallback[key]; const child = schema.properties![key]!;
    if (value === undefined) { if (defaults !== undefined) result[key] = structuredClone(defaults); }
    else if (child.type === "object" && isObject(value) && isObject(defaults)) result[key] = withDefaults(value, defaults, child);
    else result[key] = structuredClone(value);
  }
  return result;
}
export function effectiveOps(input: JsonObject | undefined): JsonObject {
  validateNode(input ?? {}, OPS_SCHEMA);
  const defaults = structuredClone(DEFAULT_OPS);
  if (input?.preset === "maintainer") (defaults.monitor as JsonObject).deepReplay = true;
  const result = withDefaults(input ?? {}, defaults, OPS_SCHEMA) as JsonObject;
  const targets = result.targets as JsonObject;
  for (const [key, value] of Object.entries(targets)) {
    targets[key] = { enabled: true, allowedIntents: [...OPS_INTENTS], dataPolicy: "safe-summary", modelChangePolicy: "require-rebind", ...(value as JsonObject) };
  }
  return result;
}
function validateRouting(ops: JsonObject): void {
  const targets = ops.targets as JsonObject;
  const routing = ops.routing as JsonObject;
  const targetKeys = new Set(Object.keys(targets));
  if (!targetKeys.has(routing.defaultTarget as string) || (routing.reportTarget !== undefined && !targetKeys.has(routing.reportTarget as string))) bad("Routing refers to a missing target.");
  const seen = new Set<string>(); const edges = new Map<string, Set<string>>();
  for (const value of routing.rules as JsonValue[]) {
    const row = value as JsonObject; const id = row.id as string; const action = row.action as JsonObject;
    if (seen.has(id)) bad("Duplicate route ID."); seen.add(id);
    if (action.type === "suppress") {
      if (action.target !== undefined || action.fallbackTargets !== undefined) bad("Suppress cannot deliver.");
      continue;
    }
    const primary = action.target as string;
    if (!targetKeys.has(primary)) bad("Route target is missing.");
    const fallbacks = (action.fallbackTargets ?? []) as string[];
    if (fallbacks.some((name) => name === primary || !targetKeys.has(name))) bad("Invalid fallback target.");
    const set = edges.get(primary) ?? new Set<string>(); fallbacks.forEach((name) => set.add(name)); edges.set(primary, set);
  }
  function visit(key: string, parents: Set<string>): void {
    if (parents.has(key)) bad("Fallback cycle.");
    const next = new Set(parents); next.add(key);
    for (const child of edges.get(key) ?? []) visit(child, next);
  }
  for (const key of targetKeys) visit(key, new Set());
}
export function validateConfig(input: unknown): UnifiedConfig {
  if (isObject(input) && (input.version !== undefined || input.schemaVersion === 1 || input.schemaVersion === 2 || input.schemaVersion === 3)) {
    throw new ConfigError("config_migration_required", "Run grokbox config migrate --preview before using this configuration.");
  }
  validateNode(input, CONFIG_SCHEMA);
  const result = structuredClone(input) as UnifiedConfig;
  if (!Object.hasOwn(result.client.profiles, result.client.currentProfile) || !Object.hasOwn(result.client.profiles, "default")) bad("Current and default profiles must exist.");
  if (result.daemon) result.daemon = validateDaemonIntent(result.daemon);
  if (result.ops) validateRouting(effectiveOps(result.ops));
  if (result.storage) effectiveStorage(result.storage);
  if (result.materials) {
    const sources = result.materials.sources;
    if (new Set(sources.map(s => s.id)).size !== sources.length) bad("Material source IDs must be unique.");
    for (const source of sources) {
      if (source.kind === "native-memory") {
        if (!Array.isArray(source.agentIds) || !Array.isArray(source.projects) || Object.hasOwn(source, "writable")
          || new Set(source.agentIds).size !== source.agentIds.length || new Set(source.projects).size !== source.projects.length) bad("Native materials require explicit unique Bot and Project allowlists and are read-only.");
      } else if (typeof source.writable !== "boolean" || Object.hasOwn(source, "agentIds") || Object.hasOwn(source, "projects")) bad("File source permissions must be explicit.");
    }
  }
  if (result.runtime?.context) {
    try { result.runtime.context = validateContextIntent(result.runtime.context); }
    catch { throw new ConfigError("config_invalid", "Context policy has invalid fields or incompatible budgets."); }
  }
  return result;
}

/** Validate legacy fields before retiring them; unknown data must not be silently
 * dropped by migration. Existing off, targets, cost and data policies survive. */
export function migrateLegacyOps(input: unknown): JsonObject {
  validateNode(input, LEGACY_OPS_SCHEMA);
  const result = structuredClone(input) as JsonObject;
  delete result.support;
  return result;
}
/** Retired network metadata is accepted only by explicit import. Its former
 * grammar and loopback relationship must hold before any field is discarded. */
export function migrateLegacyDaemonIntent(input: unknown): DaemonIntent {
  if (!isObject(input)) bad();
  validateNode(input, object({ ...DAEMON_INTENT_SCHEMA.properties,
    serve: object({ httpsPort: integer(1, 65535), dnsName: string(253, "^[A-Za-z0-9.-]+$"), proxyUrl: url }, ["httpsPort", "dnsName", "proxyUrl"]),
  }));
  const { serve, ...remaining } = input;
  const intent = validateDaemonIntent(remaining);
  if (serve !== undefined && (!isObject(serve) || !intent.network || serve.proxyUrl !== `http://127.0.0.1:${intent.network.port}`)) {
    bad("Legacy Serve proxy must match the loopback listener.");
  }
  return intent;
}
function migrateLegacyConfig(input: unknown, version: 2 | 3): UnifiedConfig {
  if (!isObject(input) || input.schemaVersion !== version || Object.hasOwn(input, "storage")
    || version === 2 && isObject(input.runtime) && input.runtime.context !== undefined) {
    throw new ConfigError("config_invalid", "Unsupported legacy configuration shape.");
  }
  const candidate = { ...input, schemaVersion: CONFIG_SCHEMA_VERSION,
    ...(input.daemon !== undefined ? { daemon: migrateLegacyDaemonIntent(input.daemon) } : {}),
    ...(input.ops !== undefined ? { ops: migrateLegacyOps(input.ops) } : {}) };
  return validateConfig(candidate);
}
/** Explicit migrators only. Ordinary readers/writers reject both old schemas. */
export function migrateConfigV2(input: unknown): UnifiedConfig { return migrateLegacyConfig(input, 2); }
export function migrateConfigV3(input: unknown): UnifiedConfig { return migrateLegacyConfig(input, 3); }

/** Safe tree for regular output, not an apply-able backup. */
export function redactConfig(value: unknown, schema: SchemaNode = CONFIG_SCHEMA): unknown {
  if (schema.sensitive) return value === undefined ? undefined : "[redacted]";
  if (schema.type === "object" && isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactConfig(item, schema.properties![key]!)]));
  if (schema.type === "map" && isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactConfig(item, schema.values!)]));
  if (schema.type === "array" && Array.isArray(value)) return value.map((item) => redactConfig(item, schema.items!));
  return value;
}
export function portableConfig(input: UnifiedConfig): UnifiedConfig {
  function project(value: unknown, node: SchemaNode): unknown {
    if (node.sensitive) return undefined;
    if (node.type === "object" && isObject(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      const projected = project(item, node.properties![key]!); return projected === undefined ? [] : [[key, projected]];
    }));
    if (node.type === "map" && isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, project(item, node.values!)]));
    if (node.type === "array" && Array.isArray(value)) return value.flatMap((item) => { const projected = project(item, node.items!); return projected === undefined ? [] : [projected]; });
    return value;
  }
  // Client credentials/endpoints and privileged daemon roots require re-onboarding.
  const result = defaultConfig();
  if (input.desktop) result.desktop = { idleReclaim: structuredClone(input.desktop.idleReclaim ?? {}), keepAgentIds: [] };
  if (input.runtime) result.runtime = { desiredMode: "disabled" };
  if (input.ops) result.ops = project(input.ops, OPS_SCHEMA) as JsonObject;
  if (input.storage) result.storage = structuredClone(input.storage);
  return validateConfig(result);
}
