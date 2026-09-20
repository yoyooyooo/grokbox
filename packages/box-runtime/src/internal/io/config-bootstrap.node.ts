import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  ConfigError, configRevision, defaultConfig, isObject, validateConfig, validateDaemonIntent,
  type UnifiedConfig, type DaemonIntent, type DesktopIntent,
} from "@grokbox/runtime-kernel/config";
import {
  publishConfigFile, publishLayoutAliases, readConfigFile, readConfigLayout, readInstallation,
  rootConfigLayout, validateInstallationState, type InstallationState,
} from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { commitConfigChange, openConfigStore } from "./config-store.node.ts";

export type BootstrapInstallation = { configDir: string; root: string; operationId: string };
export type BootstrapIntent = {
  daemon: DaemonIntent;
  desktop?: DesktopIntent;
  security?: Pick<InstallationState, "daemon" | "desktop">;
};
type BootstrapRecord = {
  schemaVersion: 1; operationId: string; configDir: string; root: string;
  phase: "prepared" | "applying" | "applied" | "rolled-back";
  beforeRevision: string; beforeSecurityDigest: string;
  afterRevision?: string; afterSecurityDigest?: string; fingerprint?: string;
};
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (error) => error });
const digest = (value: unknown) => sha256Text(canonicalJson(value ?? null));
function scope(input: BootstrapInstallation): BootstrapInstallation {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(input.operationId)) throw new ConfigError("config_invalid", "Invalid bootstrap operation identity.");
  return { ...input, root: resolve(input.root), configDir: resolve(input.configDir) };
}
function directory(input: BootstrapInstallation) { return join(input.root, "state", "bootstrap-operations", input.operationId); }
async function record(input: BootstrapInstallation): Promise<BootstrapRecord | undefined> {
  const raw = await readConfigFile(join(directory(input), "receipt.json"), true);
  if (raw === undefined) return undefined;
  if (!isObject(raw) || raw.schemaVersion !== 1 || raw.operationId !== input.operationId || raw.root !== input.root || raw.configDir !== input.configDir ||
    !["prepared", "applying", "applied", "rolled-back"].includes(String(raw.phase)) ||
    typeof raw.beforeRevision !== "string" || typeof raw.beforeSecurityDigest !== "string") {
    throw new ConfigError("config_commit_unknown", "Bootstrap receipt does not belong to this installation.");
  }
  return raw as BootstrapRecord;
}
async function saveRecord(input: BootstrapInstallation, value: BootstrapRecord) {
  await publishConfigFile(join(directory(input), "receipt.json"), value);
}
async function checkLayout(input: BootstrapInstallation) {
  const home = await readConfigLayout(input.configDir);
  if (home.role === "box") {
    if (home.root !== input.root) throw new ConfigError("config_layout_conflict", "Bootstrap cannot retarget an existing Box installation.");
  } else if (home.root !== input.root) {
    const existing = await openConfigStore(home).read();
    if (existing.exists) throw new ConfigError("config_migration_required", "Migrate the existing client configuration to the Box before bootstrap.");
  }
}
async function prepare(input: BootstrapInstallation) {
  const old = await record(input);
  if (old) return old;
  await checkLayout(input);
  const snapshot = await openConfigStore(rootConfigLayout(input.root)).read();
  const security = await readInstallation(input.root);
  const before: BootstrapRecord = { schemaVersion: 1, ...input, phase: "prepared", beforeRevision: snapshot.revision, beforeSecurityDigest: digest(security) };
  // Each artifact is bounded separately; no config/secret contents enter CLI output.
  await publishConfigFile(join(directory(input), "before-config.json"), snapshot.document);
  await publishConfigFile(join(directory(input), "before-security.json"), security ?? null);
  await saveRecord(input, before);
  return before;
}
function mergeIntent(current: UnifiedConfig, input: BootstrapIntent): UnifiedConfig {
  const incoming = validateDaemonIntent(input.daemon);
  const prior = current.daemon ?? {};
  const daemon: DaemonIntent = { ...prior, ...incoming };
  if (incoming.filesystem) {
    const additions = new Map(incoming.filesystem.roots.map((root) => [root.name, root]));
    const roots = (prior.filesystem?.roots ?? []).map((root) => {
      const addition = additions.get(root.name);
      if (!addition) return root;
      additions.delete(root.name);
      return { ...addition, operations: [...new Set([...root.operations, ...addition.operations])] };
    });
    daemon.filesystem = { roots: [...roots, ...additions.values()] };
  }
  return validateConfig({ ...current, daemon,
    ...(input.desktop ? { desktop: {
      ...current.desktop, ...input.desktop,
      idleReclaim: { ...current.desktop?.idleReclaim, ...input.desktop.idleReclaim },
    } } : {}),
  });
}

/** Bootstrap owns an independent, ordered installation lease; all human intent
 * commits still go through ConfigChange and its CAS. This is a recoverable saga,
 * not an assertion that security state, config and aliases commit atomically. */
async function withOwner<A>(input: BootstrapInstallation, run: () => Promise<A>, recover = false): Promise<A> {
  return await Effect.runPromise(Effect.acquireUseRelease(
    attempt(() => acquireConfigurationLease(input.root, recover, "config-bootstrap")),
    () => attempt(run),
    (lease) => attempt(lease.release).pipe(Effect.orDie),
  ));
}
export async function prepareConfigurationBootstrap(raw: BootstrapInstallation) {
  const input = scope(raw);
  return await withOwner(input, async () => {
    const saved = await prepare(input);
    return { operationId: input.operationId, phase: saved.phase, prepared: true, servicesStarted: false };
  });
}
export async function installConfigurationResources(raw: BootstrapInstallation, resources: BootstrapIntent) {
  const input = scope(raw);
  return await withOwner(input, async () => {
    let saved = await prepare(input);
    const fingerprint = digest(resources);
    if (saved.fingerprint && saved.fingerprint !== fingerprint) throw new ConfigError("config_conflict", "Bootstrap operation was used for different resources.");
    if (saved.phase === "rolled-back") throw new ConfigError("config_conflict", "A rolled-back bootstrap must not be replayed.");
    const store = openConfigStore(rootConfigLayout(input.root));
    const before = validateConfig(await readConfigFile(join(directory(input), "before-config.json")));
    const securityRaw = await readConfigFile(join(directory(input), "before-security.json"));
    const beforeSecurity = securityRaw === null ? undefined : validateInstallationState(securityRaw, input.root);
    if (configRevision(before) !== saved.beforeRevision || digest(beforeSecurity) !== saved.beforeSecurityDigest) throw new ConfigError("config_commit_unknown", "Bootstrap backup integrity mismatch.");
    let candidate: UnifiedConfig;
    let security: InstallationState;
    if (saved.phase === "prepared") {
      const observed = await store.read();
      if (observed.revision !== saved.beforeRevision || digest(await readInstallation(input.root)) !== saved.beforeSecurityDigest) throw new ConfigError("config_conflict", "Installation changed after bootstrap preparation.");
      candidate = mergeIntent(before, resources);
      security = validateInstallationState({ ...beforeSecurity, schemaVersion: 1, role: "box", root: input.root,
        installationId: beforeSecurity?.installationId ?? randomUUID(),
        ...(resources.security?.daemon ? { daemon: { ...beforeSecurity?.daemon, ...resources.security.daemon } } : {}),
        ...(resources.security?.desktop ? { desktop: { ...beforeSecurity?.desktop, ...resources.security.desktop } } : {}),
      }, input.root);
      await publishConfigFile(join(directory(input), "after-config.json"), candidate);
      await publishConfigFile(join(directory(input), "after-security.json"), security);
      saved = { ...saved, phase: "applying", fingerprint, afterRevision: configRevision(candidate), afterSecurityDigest: digest(security) };
      await saveRecord(input, saved);
    } else {
      candidate = validateConfig(await readConfigFile(join(directory(input), "after-config.json")));
      security = validateInstallationState(await readConfigFile(join(directory(input), "after-security.json")), input.root);
      if (configRevision(candidate) !== saved.afterRevision || digest(security) !== saved.afterSecurityDigest) throw new ConfigError("config_commit_unknown", "Bootstrap candidate integrity mismatch.");
    }
    const current = await store.read();
    if (saved.phase === "applied") {
      if (current.revision !== saved.afterRevision || digest(await readInstallation(input.root)) !== saved.afterSecurityDigest) throw new ConfigError("config_conflict", "Completed bootstrap is no longer the current installation.");
      return { operationId: input.operationId, phase: "applied", repeated: true, servicesStarted: false, application: "restart-required" };
    }
    if (![saved.beforeRevision, saved.afterRevision].includes(current.revision)) throw new ConfigError("config_conflict", "Another writer changed configuration during bootstrap.");
    const actualSecurity = digest(await readInstallation(input.root));
    if (![saved.beforeSecurityDigest, saved.afterSecurityDigest].includes(actualSecurity)) throw new ConfigError("config_conflict", "Another installer changed security state during bootstrap.");
    await commitConfigChange(store, { operationId: `${input.operationId}:bootstrap`, scope: "box", kind: "replace", value: candidate,
      expectedRevision: saved.beforeRevision, confirm: true, replaceArrays: true });
    await publishConfigFile(join(input.root, "state", "installation.json"), security);
    // Existing models are never normalized or rewritten by bootstrap.
    if (await readConfigFile(join(input.root, "models.json"), true) === undefined) {
      try { await publishConfigFile(join(input.root, "models.json"), { version: 3, models: {}, assignments: { main: null, agents: {} } }, undefined, true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await publishLayoutAliases(input.configDir, input.root, security.installationId);
    await saveRecord(input, { ...saved, phase: "applied" });
    return { operationId: input.operationId, phase: "applied", repeated: false, configRevision: saved.afterRevision, servicesStarted: false, application: "restart-required" };
  });
}

/** Restores only this attempt's exact configuration/security versions. A later
 * user edit is a conflict, never an excuse to overwrite it with a backup. */
export async function rollbackConfigurationBootstrap(raw: BootstrapInstallation) {
  const input = scope(raw);
  return await withOwner(input, async () => {
    const saved = await record(input);
    if (!saved) return { operationId: input.operationId, phase: "not-started", restartPrevious: false, servicesStarted: false };
    const before = validateConfig(await readConfigFile(join(directory(input), "before-config.json")));
    const rawSecurity = await readConfigFile(join(directory(input), "before-security.json"));
    const beforeSecurity = rawSecurity === null ? undefined : validateInstallationState(rawSecurity, input.root);
    if (configRevision(before) !== saved.beforeRevision || digest(beforeSecurity) !== saved.beforeSecurityDigest) throw new ConfigError("config_commit_unknown", "Bootstrap backup integrity mismatch.");
    const current = await openConfigStore(rootConfigLayout(input.root)).read();
    if (![saved.beforeRevision, saved.afterRevision].includes(current.revision)) throw new ConfigError("config_conflict", "A later config edit prevents bootstrap rollback.");
    const currentSecurity = await readInstallation(input.root);
    if (![saved.beforeSecurityDigest, saved.afterSecurityDigest].includes(digest(currentSecurity)) && saved.phase !== "rolled-back") throw new ConfigError("config_conflict", "A later installation prevents bootstrap rollback.");
    if (current.revision !== saved.beforeRevision) {
      await commitConfigChange(openConfigStore(rootConfigLayout(input.root)), { operationId: `${input.operationId}:rollback`, scope: "box", kind: "replace",
        value: before, expectedRevision: saved.afterRevision, confirm: true, replaceArrays: true });
    }
    if (saved.phase !== "prepared" && saved.phase !== "rolled-back") {
      // A new installation keeps its identity/aliases but loses all newly granted
      // daemon credentials and floor policy. It does not destroy the new root.
      const restored = beforeSecurity ?? validateInstallationState({ schemaVersion: 1, role: "box", root: input.root,
        installationId: currentSecurity?.installationId ?? randomUUID() }, input.root);
      await publishConfigFile(join(input.root, "state", "installation.json"), restored);
    }
    await saveRecord(input, { ...saved, phase: "rolled-back" });
    return { operationId: input.operationId, phase: "rolled-back", restartPrevious: Boolean(before.daemon), servicesStarted: false };
  }, true);
}
