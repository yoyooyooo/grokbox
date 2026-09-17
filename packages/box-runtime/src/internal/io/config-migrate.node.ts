import { lstat, readdir, readFile, readlink, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  ConfigError, defaultConfig, isObject, validateConfig, migrateConfigV2, validateDaemonIntent, configRevision,
  type ConnectionProfile, type JsonObject, type UnifiedConfig,
} from "@grokbox/runtime-kernel/config";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseModelsFile, parseDesiredFile } from "@grokbox/runtime-kernel/selection";
import { acquireConfigurationLease, inspectConfigurationLease } from "./config-lock.node.ts";
import { assertSafeDirectory, publishConfigFile, publishLayoutAliases, readConfigFile, readConfigSource, validateInstallationState, type InstallationState } from "./config-layout.node.ts";

export type MigrationOptions = { configDir: string; root: string; role: "client" | "box"; prefer?: "canonical" | "legacy" };
export type MigrationWriter = { pid: number; kind: string };
export type MigrationPorts = {
  writers?: (options: MigrationOptions) => Promise<MigrationWriter[]>;
  checkpoint?: (phase: string) => Promise<void>;
};
type Source = { key: string; path: string; sha256: string; text: string; value: unknown; retire: boolean };
export type MigrationPlan = {
  schemaVersion: 1; options: MigrationOptions; planDigest: string;
  sources: Source[]; candidate: UnifiedConfig; installation?: InstallationState;
  models: unknown; modelsExist: boolean;
  conflicts: string[]; blockedWriters: MigrationWriter[]; canApply: boolean;
  opsRevalidation: boolean;
};
type Manifest = {
  schemaVersion: 1; operationId: string; phase: "prepared" | "publishing" | "published" | "activated" | "retired";
  options: MigrationOptions; planDigest: string; candidateDigest: string; installationId?: string; installationDigest?: string;
  sources: Array<{ key: string; path: string; sha256: string; retire: boolean }>;
  modelsExist: boolean; opsRevalidation: boolean;
};
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });
const oldProfileKeys: Record<string, keyof ConnectionProfile> = {
  transport: "transport", server_url: "serverUrl", daemon_token_ref: "daemonTokenRef", daemon_socket: "daemonSocket",
  gateway_url: "gatewayUrl", gateway_token_ref: "gatewayTokenRef", gateway_headers_ref: "gatewayHeadersRef", gateway_discovery: "gatewayDiscovery", ssh_host: "sshHost",
};
function requireObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new ConfigError("config_invalid", `Unrecognized ${label} fields; migration preserves the source unchanged.`);
  return value;
}
function migrateProfile(value: unknown): ConnectionProfile {
  const raw = requireObject(value, ["version", ...Object.keys(oldProfileKeys), "sandbox", "quota"], "legacy Profile");
  if (raw.version !== 1) throw new ConfigError("config_invalid", "Unsupported legacy Profile version.");
  const next: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(oldProfileKeys)) if (raw[key] !== undefined) next[target] = raw[key];
  if (raw.sandbox !== undefined) {
    const sandbox = requireObject(raw.sandbox, ["access_token_ref", "keepalive_interval_ms"], "legacy sandbox");
    next.sandbox = { ...(sandbox.access_token_ref !== undefined ? { accessTokenRef: sandbox.access_token_ref } : {}), ...(sandbox.keepalive_interval_ms !== undefined ? { keepaliveIntervalMs: sandbox.keepalive_interval_ms } : {}) };
  }
  if (raw.quota !== undefined) {
    const quota = requireObject(raw.quota, ["source", "access_token_ref"], "legacy quota");
    next.quota = { source: quota.source, accessTokenRef: quota.access_token_ref };
  }
  return next as ConnectionProfile;
}
function migrateDesktop(value: unknown) {
  const desktop = requireObject(value, ["stopWindowPath", "floorAgentIds", "keepAgentIds", "minIdleMs", "pruneEnabled"], "legacy desktop");
  const normalizeIds = (ids: unknown): unknown => Array.isArray(ids) ? ids.map((id) => typeof id === "string" ? id.toLowerCase() : id) : ids;
  return {
    intent: {
      idleReclaim: { ...(desktop.pruneEnabled !== undefined ? { enabled: desktop.pruneEnabled } : {}), ...(desktop.minIdleMs !== undefined ? { minIdleMs: desktop.minIdleMs } : {}) },
      ...(desktop.keepAgentIds !== undefined ? { keepAgentIds: normalizeIds(desktop.keepAgentIds) } : {}),
    },
    security: { ...(desktop.floorAgentIds !== undefined ? { floorAgentIds: normalizeIds(desktop.floorAgentIds) } : {}), ...(desktop.stopWindowPath !== undefined ? { stopWindowPath: desktop.stopWindowPath } : {}) },
  };
}

/** Only safe process metadata is returned. No argv/environment is persisted or
 * logged. A process not proven to use another root blocks the affected cutover. */
export async function inspectConfigurationWriters(options: MigrationOptions): Promise<MigrationWriter[]> {
  if (process.platform !== "linux") return [{ pid: 0, kind: "process-fence-unqualified" }];
  const result: MigrationWriter[] = [];
  for (const entry of await readdir("/proc")) {
    const pid = Number(entry); if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      const info = await lstat(`/proc/${pid}`); if (process.getuid && info.uid !== process.getuid()) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (!argv.some((arg) => /(?:grokbox|box-runtime|modeld|\/dist\/index\.js|\/packages\/cli\/src\/index\.ts)/.test(arg)) || !/(?:node|bun|grokbox)/.test(argv[0] ?? "")) continue;
      const relevant = argv.some((arg) => ["daemon", "modeld", "runtime", "ops", "config", "profile", "on", "off", "upgrade", "models", "init"].includes(arg));
      if (!relevant) continue;
      const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      const configured = env.find((item) => item.startsWith("GROKBOX_CONFIG_DIR="))?.slice("GROKBOX_CONFIG_DIR=".length);
      const durable = env.find((item) => item.startsWith("GROKBOX_BOX_RUNTIME_ROOT="))?.slice("GROKBOX_BOX_RUNTIME_ROOT=".length);
      const inspectedHome = env.find((item) => item.startsWith("HOME="))?.slice("HOME=".length);
      const inspectedConfig = configured ?? (inspectedHome ? join(inspectedHome, ".grokbox") : undefined);
      const locator = inspectedConfig ? await readConfigFile(join(inspectedConfig, "state", "layout.json"), true) : undefined;
      if (locator !== undefined && (!isObject(locator) || locator.schemaVersion !== 1 || typeof locator.root !== "string")) throw new ConfigError("config_layout_conflict", "An identified consumer has an invalid installation locator.");
      const inspectedRoot = durable ?? (isObject(locator) && typeof locator.root === "string" ? locator.root : "/workspace/.grokbox/box-runtime");
      const sameConfig = inspectedConfig === undefined || resolve(inspectedConfig) === resolve(options.configDir);
      const sameRoot = resolve(inspectedRoot) === resolve(options.root);
      if (sameConfig || (options.role === "box" && sameRoot)) result.push({ pid, kind: argv.includes("modeld") ? "modeld" : argv.includes("daemon") ? "daemon" : "configuration-consumer" });
    } catch (error) {
      // Vanishing processes are harmless; an unreadable identified process is not.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") result.push({ pid, kind: "process-identity-unavailable" });
    }
  }
  return result;
}

export async function planConfigurationMigration(input: MigrationOptions, ports: MigrationPorts = {}): Promise<MigrationPlan> {
  const options = { ...input, configDir: resolve(input.configDir), root: resolve(input.role === "client" ? input.configDir : input.root) };
  const sources: Source[] = []; const conflicts: string[] = [];
  async function capture(key: string, path: string, retire = false): Promise<unknown | undefined> {
    if (sources.some((source) => source.path === path)) return sources.find((source) => source.path === path)!.value;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path));
        if ([join(options.root, "config.json"), join(options.root, "models.json")].includes(target)) return undefined;
        throw new ConfigError("config_layout_conflict", "Unmanaged alias blocks migration.");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const source = await readConfigSource(path, true);
    if (!source) return undefined;
    sources.push({ key, path, ...source, retire }); return source.value;
  }
  const canonicalPath = join(options.root, "config.json");
  const canonical = await capture("canonical", canonicalPath);
  const home = canonicalPath === join(options.configDir, "config.json") ? canonical : await capture("home", join(options.configDir, "config.json"), true);
  const unified = (raw: unknown) => isObject(raw) && (raw.schemaVersion === 2 || raw.schemaVersion === 3);
  const upgrade = (raw: unknown) => isObject(raw) && raw.schemaVersion === 2 ? migrateConfigV2(raw) : validateConfig(raw);
  let candidate = unified(canonical) ? upgrade(canonical) : defaultConfig();
  const canonicalPresent = unified(canonical);
  function choose(key: keyof UnifiedConfig, value: unknown) {
    if (canonicalPresent && candidate[key] !== undefined && canonicalJson(candidate[key]) !== canonicalJson(value)) {
      if (!options.prefer) conflicts.push(key);
      if (options.prefer !== "legacy") return;
    }
    (candidate as unknown as Record<string, unknown>)[key] = value;
  }
  let legacyCurrent: string | undefined;
  for (const raw of new Set([canonical, home])) if (raw !== undefined) {
    if (unified(raw)) {
      if (raw !== canonical) {
        const other = upgrade(raw);
        for (const [key, value] of Object.entries(other)) if (key !== "schemaVersion") choose(key as keyof UnifiedConfig, value);
      }
    } else {
      const global = requireObject(raw, ["version", "current_profile"], "legacy global");
      if (global.version !== 1 || (global.current_profile !== undefined && typeof global.current_profile !== "string")) throw new ConfigError("config_invalid", "Unsupported legacy global configuration.");
      legacyCurrent = global.current_profile as string | undefined;
    }
  }
  const legacyProfiles: Record<string, ConnectionProfile> = {};
  let profileEntries: string[] = [];
  try { profileEntries = await readdir(join(options.configDir, "profiles")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const name of profileEntries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new ConfigError("config_invalid", "Unrecognized legacy Profile directory.");
    const raw = await capture(`profile-${name}`, join(options.configDir, "profiles", name, "config.json"), true);
    if (raw !== undefined) legacyProfiles[name] = migrateProfile(raw);
  }
  if (Object.keys(legacyProfiles).length || legacyCurrent) choose("client", {
    currentProfile: legacyCurrent ?? candidate.client.currentProfile,
    profiles: { default: { transport: "auto" }, ...candidate.client.profiles, ...legacyProfiles },
  });
  const installed = await capture("installation", join(options.root, "state", "installation.json"));
  const installationId = isObject(installed) && typeof installed.installationId === "string" ? installed.installationId : undefined;
  let security: Record<string, unknown> = isObject(installed) ? structuredClone(installed) : {};
  const daemonRaw = await capture("daemon", join(options.configDir, "daemon", "config.json"), true);
  if (daemonRaw !== undefined) {
    if (options.role !== "box") conflicts.push("daemon-requires-box-role");
    const daemon = requireObject(daemonRaw, ["version", "network", "serve", "filesystem", "process", "desktop"], "legacy daemon");
    if (daemon.version !== 1) throw new ConfigError("config_invalid", "Unsupported daemon configuration version.");
    const intent: Record<string, unknown> = {};
    for (const key of ["serve", "filesystem", "process"]) if (daemon[key] !== undefined) intent[key] = daemon[key];
    if (daemon.network !== undefined) {
      const network = requireObject(daemon.network, ["host", "port", "tokenSha256"], "legacy network");
      if (typeof network.tokenSha256 !== "string" || !/^[0-9a-f]{64}$/.test(network.tokenSha256)) throw new ConfigError("config_invalid", "Invalid legacy credential verifier.");
      intent.network = { host: network.host, port: network.port }; security.daemon = { tokenSha256: network.tokenSha256 };
    }
    choose("daemon", validateDaemonIntent(intent));
    if (daemon.desktop !== undefined) {
      const desktop = migrateDesktop(daemon.desktop); choose("desktop", desktop.intent); security.desktop = desktop.security;
    }
  }
  const desired = await capture("desired", join(options.root, "state", "desired.json"), true);
  if (desired !== undefined) {
    requireObject(desired, ["version", "mode"], "legacy runtime intent");
    if (options.role !== "box") conflicts.push("runtime-requires-box-role");
    choose("runtime", { ...candidate.runtime, desiredMode: parseDesiredFile(desired).mode });
  }
  const ops = await capture("ops", join(options.root, "ops-policy.json"), true);
  let opsRevalidation = false;
  if (ops !== undefined) {
    const raw = requireObject(ops, ["schemaVersion", "enabled", "preset", "presetRevision", "overrides", "targets", "routing", "binding", "bindings", "maintenanceGrants", "issueGrants"], "prototype ops");
    if (raw.schemaVersion !== 1) throw new ConfigError("config_invalid", "Unsupported prototype ops schema.");
    const preferences: Record<string, unknown> = {};
    for (const key of ["enabled", "preset", "presetRevision", "targets", "routing"]) if (raw[key] !== undefined) preferences[key] = raw[key];
    if (raw.overrides !== undefined) {
      const overrides = requireObject(raw.overrides, ["monitor", "notifications", "diagnostics", "canary", "maintenance", "support"], "ops overrides");
      Object.assign(preferences, overrides);
    }
    choose("ops", preferences);
    opsRevalidation = ["binding", "bindings", "maintenanceGrants", "issueGrants"].some((key) => raw[key] !== undefined);
    if (options.role !== "box") conflicts.push("ops-requires-box-role");
  }
  const models = await capture("models", join(options.root, "models.json"));
  if (models !== undefined) parseModelsFile(models); // validation only: never normalize/rewrite an existing model file
  const homeModelsPath = join(options.configDir, "models.json");
  if (options.role === "box" && homeModelsPath !== join(options.root, "models.json")) {
    const homeModels = await capture("home-models", homeModelsPath, true);
    if (homeModels !== undefined && canonicalJson(homeModels) !== canonicalJson(models)) conflicts.push("models-alias-contains-independent-data");
  }
  candidate = validateConfig(candidate);
  if (options.role === "client" && [candidate.daemon, candidate.desktop, candidate.runtime, candidate.ops].some((value) => value !== undefined)) conflicts.push("client-document-contains-box-intent");
  security = { ...security, schemaVersion: 1, role: "box", root: options.root, installationId: installationId ?? "unassigned-at-preview" };
  if (options.role === "box") validateInstallationState({ ...security, installationId: installationId ?? "00000000-0000-4000-8000-000000000000" }, options.root);
  const blockedWriters = await (ports.writers ?? inspectConfigurationWriters)(options);
  const modelDocument = models ?? { version: 2, models: {}, assignments: { main: null, agents: {} } };
  // A preview also binds generated model bytes: a schema upgrade cannot reuse
  // the old empty-seed plan digest while publishing a different document.
  const descriptor = { options, sources: sources.map(({ key, path, sha256, retire }) => ({ key, path, sha256, retire })), candidate,
    modelInitialization: models === undefined && options.role === "box" ? modelDocument : null,
    security: options.role === "box" ? security : null, opsRevalidation };
  return {
    schemaVersion: 1, options, planDigest: sha256Text(canonicalJson(descriptor)), sources, candidate,
    ...(options.role === "box" ? { installation: security as InstallationState } : {}),
    models: modelDocument,
    modelsExist: models !== undefined, conflicts: [...new Set(conflicts)], blockedWriters,
    canApply: conflicts.length === 0 && blockedWriters.length === 0, opsRevalidation,
  };
}
export function migrationPreview(plan: MigrationPlan) {
  return { schemaVersion: 1, planDigest: plan.planDigest, role: plan.options.role, canApply: plan.canApply,
    sources: plan.sources.map(({ key, sha256, retire }) => ({ key, sha256, disposition: retire ? "backup-and-retire" : "preserve" })),
    conflicts: plan.conflicts, blockedWriters: plan.blockedWriters, models: plan.modelsExist ? "preserved-in-place" : plan.options.role === "box" ? "initialize-empty" : "not-created",
    credentials: "existing-reference-locations-preserved", opsAuthorization: plan.opsRevalidation ? "revalidation-required" : "not-created" };
}
function parseMigrationManifest(value: unknown, root: string): Manifest {
  const fail = () => { throw new ConfigError("config_commit_unknown", "Migration manifest requires manual recovery."); };
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.operationId !== "string" || !/^[0-9a-f-]{36}$/.test(value.operationId) ||
    !isObject(value.options) || value.options.root !== resolve(root) || typeof value.options.configDir !== "string" || !isAbsolute(value.options.configDir) ||
    !["box", "client"].includes(String(value.options.role)) || (value.options.prefer !== undefined && !["canonical", "legacy"].includes(String(value.options.prefer))) ||
    !["prepared", "publishing", "published", "activated", "retired"].includes(String(value.phase)) ||
    typeof value.planDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.planDigest) || typeof value.candidateDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.candidateDigest) ||
    typeof value.modelsExist !== "boolean" || typeof value.opsRevalidation !== "boolean" || !Array.isArray(value.sources) || value.sources.length > 256) return fail();
  const configDir = resolve(value.options.configDir);
  if (value.options.role === "client" && configDir !== resolve(root)) return fail();
  if (value.options.role === "box" && (typeof value.installationId !== "string" || !/^[0-9a-f-]{36}$/.test(value.installationId) ||
    typeof value.installationDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.installationDigest))) return fail();
  const expected: Record<string, string> = { canonical: join(root, "config.json"), home: join(configDir, "config.json"),
    daemon: join(configDir, "daemon", "config.json"), desired: join(root, "state", "desired.json"),
    ops: join(root, "ops-policy.json"), installation: join(root, "state", "installation.json"),
    models: join(root, "models.json"), "home-models": join(configDir, "models.json") };
  const keys = new Set<string>(), paths = new Set<string>();
  for (const row of value.sources) {
    if (!isObject(row) || typeof row.key !== "string" || typeof row.path !== "string" || typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sha256) || typeof row.retire !== "boolean" || keys.has(row.key) || paths.has(row.path)) return fail();
    let path = expected[row.key];
    if (row.key.startsWith("profile-")) {
      const name = row.key.slice(8);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return fail();
      path = join(configDir, "profiles", name, "config.json");
    }
    if (!path || row.path !== path || row.retire !== !["canonical", "models", "installation"].includes(row.key)) return fail();
    keys.add(row.key); paths.add(row.path);
  }
  return value as Manifest;
}
async function acquireMigrationLease(root: string, recover = false) {
  const installer = await acquireConfigurationLease(root, recover, "config-bootstrap");
  try {
    const writer = await acquireConfigurationLease(root, recover);
    return { release: async () => { try { await writer.release(); } finally { await installer.release(); } } };
  } catch (error) { await installer.release(); throw error; }
}
function manifestPath(root: string) { return join(root, "state", "config-migration.json"); }
function workDir(manifest: Manifest) { return join(manifest.options.root, "state", "config-migrations", manifest.operationId); }
async function checkpoint(manifest: Manifest, phase: Manifest["phase"], ports: MigrationPorts) {
  manifest.phase = phase; await publishConfigFile(manifestPath(manifest.options.root), manifest);
  await ports.checkpoint?.(phase);
}
async function retireSource(source: Manifest["sources"][number], manifest: Manifest): Promise<void> {
  if (!source.retire || source.path === join(manifest.options.root, "config.json")) return;
  const retired = join(workDir(manifest), `retired-${source.key}.json`);
  const current = await readConfigSource(source.path, true).catch(async (error) => {
    try {
      const target = resolve(dirname(source.path), await readlink(source.path));
      if ([join(manifest.options.root, "config.json"), join(manifest.options.root, "models.json")].includes(target)) return undefined;
    } catch { /* Preserve the original error. */ }
    throw error;
  });
  if (!current) {
    if ((await readConfigSource(retired, true))?.sha256 !== source.sha256) throw new ConfigError("config_commit_unknown", "A migration source vanished without a verified retirement receipt.");
    return;
  }
  if (current.sha256 !== source.sha256) throw new ConfigError("config_conflict", "Legacy source changed before retirement; preserved for operator review.");
  if (await readConfigSource(retired, true)) throw new ConfigError("config_conflict", "Retirement destination already exists while the legacy source was recreated.");
  await rename(source.path, retired);
}

async function finishMigration(manifest: Manifest, ports: MigrationPorts) {
  const { root, configDir, role } = manifest.options; const directory = workDir(manifest);
  if (manifest.phase !== "activated" && manifest.phase !== "retired") {
    const candidate = validateConfig(await readConfigFile(join(directory, "candidate.json")));
    if (configRevision(candidate) !== manifest.candidateDigest) throw new ConfigError("config_commit_unknown", "Migration candidate integrity mismatch.");
    const installation = role === "box" ? validateInstallationState(await readConfigFile(join(directory, "installation.json")), root) : undefined;
    if (installation && sha256Text(canonicalJson(installation)) !== manifest.installationDigest) throw new ConfigError("config_commit_unknown", "Migration installation evidence does not match its checkpoint.");
    if (manifest.phase === "prepared") {
      for (const source of manifest.sources) {
        const current = await readConfigSource(source.path, true);
        if (current?.sha256 !== source.sha256) throw new ConfigError("config_conflict", "Migration source changed after preview.");
      }
      await checkpoint(manifest, "publishing", ports);
    }
    if (manifest.phase === "publishing") {
      const current = await readConfigSource(join(root, "config.json"), true);
      const original = manifest.sources.find((source) => source.path === join(root, "config.json"));
      let alreadyPublished = false;
      if (current) {
        try { alreadyPublished = configRevision(validateConfig(current.value)) === manifest.candidateDigest; } catch { /* May still be the captured legacy document. */ }
      }
      if (!alreadyPublished && (current ? current.sha256 !== original?.sha256 : original !== undefined)) {
        throw new ConfigError("config_conflict", "Canonical configuration changed during interrupted migration; preserve it for review.");
      }
      if (!alreadyPublished) await publishConfigFile(join(root, "config.json"), candidate);
      if (role === "box") {
        if (!manifest.modelsExist) {
          const models = await readConfigFile(join(directory, "models.json"));
          const existing = await readConfigFile(join(root, "models.json"), true);
          if (existing !== undefined && canonicalJson(existing) !== canonicalJson(models)) throw new ConfigError("config_conflict", "Model file appeared during migration.");
          if (existing === undefined) await publishConfigFile(join(root, "models.json"), models);
        }
        const priorInstallation = manifest.sources.find((source) => source.key === "installation");
        const currentInstallation = await readConfigSource(join(root, "state", "installation.json"), true);
        if (currentInstallation && currentInstallation.sha256 !== priorInstallation?.sha256 &&
          sha256Text(canonicalJson(currentInstallation.value)) !== manifest.installationDigest) throw new ConfigError("config_conflict", "Installation security changed during migration; preserve it for review.");
        if (!currentInstallation && priorInstallation) throw new ConfigError("config_conflict", "Installation security vanished during migration.");
        await publishConfigFile(join(root, "state", "installation.json"), installation!);
        if (manifest.opsRevalidation) {
          await publishConfigFile(join(root, "state", "ops-bindings.json"), { schemaVersion: 1, installationId: manifest.installationId, requiresRevalidation: true, bindings: {} });
          await publishConfigFile(join(root, "state", "ops-grants.json"), { schemaVersion: 1, installationId: manifest.installationId, requiresRevalidation: true, maintenanceGrants: {}, issueGrants: {} });
        }
      }
      await checkpoint(manifest, "published", ports);
    }
    if (role === "box") {
      for (const source of manifest.sources.filter((item) => item.key === "home" || item.key === "home-models")) await retireSource(source, manifest);
      await publishLayoutAliases(configDir, root, manifest.installationId!);
    }
    const published = validateConfig(await readConfigFile(join(root, "config.json")));
    if (configRevision(published) !== manifest.candidateDigest) throw new ConfigError("config_commit_unknown", "Published migration candidate changed before activation.");
    await checkpoint(manifest, "activated", ports);
  }
  if (manifest.phase === "activated") {
    for (const source of manifest.sources) if (!["home", "home-models"].includes(source.key)) await retireSource(source, manifest);
    await checkpoint(manifest, "retired", ports);
  }
  return { operationId: manifest.operationId, phase: manifest.phase, role, configRevision: manifest.candidateDigest,
    models: manifest.modelsExist ? "preserved-in-place" : role === "box" ? "initialized" : "not-created", servicesStarted: false,
    application: "restart-required", credentialRetention: "not-proven", opsAuthorization: manifest.opsRevalidation ? "revalidation-required" : "not-created" };
}

export async function applyConfigurationMigration(options: MigrationOptions, planDigest: string, ports: MigrationPorts = {}) {
  const rootForReceipt = resolve(options.role === "client" ? options.configDir : options.root);
  const completed = await readConfigFile(manifestPath(rootForReceipt), true);
  if (isObject(completed) && completed.phase === "retired" && completed.planDigest === planDigest && isObject(completed.options) && completed.options.root === rootForReceipt) {
    return await finishMigration(parseMigrationManifest(completed, rootForReceipt), ports);
  }
  const plan = await planConfigurationMigration(options, ports);
  if (plan.planDigest !== planDigest) throw new ConfigError("config_conflict", "Migration plan changed; preview again.");
  if (!plan.canApply) throw new ConfigError("config_conflict", "Migration is blocked by conflicts or active/unqualified writers.");
  const root = plan.options.root;
  return await Effect.runPromise(Effect.acquireUseRelease(
    attempt(async () => {
      await assertSafeDirectory(join(root, "state"), true);
      return await acquireMigrationLease(root);
    }),
    () => attempt(async () => {
      const existing = await readConfigFile(manifestPath(root), true);
      if (existing !== undefined) throw new ConfigError("config_migration_required", "An existing migration must be inspected or recovered, not overwritten.");
      const refreshed = await planConfigurationMigration(options, ports);
      if (refreshed.planDigest !== planDigest || !refreshed.canApply) throw new ConfigError("config_conflict", "Migration evidence changed while acquiring the writer fence.");
      const manifest: Manifest = { schemaVersion: 1, operationId: randomUUID(), phase: "prepared", options: plan.options,
        planDigest, candidateDigest: configRevision(plan.candidate), sources: plan.sources.map(({ key, path, sha256, retire }) => ({ key, path, sha256, retire })),
        modelsExist: plan.modelsExist, opsRevalidation: plan.opsRevalidation,
        ...(plan.options.role === "box" ? { installationId: plan.installation?.installationId === "unassigned-at-preview" ? randomUUID() : plan.installation?.installationId } : {}),
      };
      const directory = workDir(manifest);
      for (const source of plan.sources) await publishConfigFile(join(directory, `backup-${source.key}.json`), source.value, source.text);
      await publishConfigFile(join(directory, "candidate.json"), plan.candidate);
      if (plan.options.role === "box") {
        await publishConfigFile(join(directory, "models.json"), plan.models);
        const installation = validateInstallationState({ ...plan.installation, installationId: manifest.installationId }, root);
        manifest.installationDigest = sha256Text(canonicalJson(installation));
        await publishConfigFile(join(directory, "installation.json"), installation);
      }
      await checkpoint(manifest, "prepared", ports);
      return await finishMigration(manifest, ports);
    }),
    (lease) => attempt(() => lease.release()).pipe(Effect.orDie),
  ));
}
export async function configurationMigrationStatus(root: string) {
  const value = await readConfigFile(manifestPath(root), true);
  if (value === undefined) return { state: "not-started" };
  const manifest = parseMigrationManifest(value, root);
  return { state: manifest.phase, operationId: manifest.operationId, planDigest: manifest.planDigest, writer: await inspectConfigurationLease(root) };
}
export async function recoverConfigurationMigration(root: string, ports: MigrationPorts = {}) {
  const raw = await readConfigFile(manifestPath(root));
  const manifest = parseMigrationManifest(raw, root);
  if ((await (ports.writers ?? inspectConfigurationWriters)(manifest.options)).length) throw new ConfigError("config_conflict", "Active writers block migration recovery.");
  const lease = await acquireMigrationLease(root, true);
  try { return await finishMigration(manifest, ports); } finally { await lease.release(); }
}
