import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { ConfigurationWrite } from "@grokbox/runtime-kernel/ports";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  ConfigError, applyConfigChange, configApplication, configChangeFingerprint,
  configRevision, defaultConfig, isObject, validateConfig, runConfigChange,
  type ConfigChange, type ConfigCommitReceipt, type UnifiedConfig,
} from "@grokbox/runtime-kernel/config";
import { publishConfigFile, readConfigFile, readInstallation, type ConfigLayout } from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { configApplicationRevisions } from "./config-application.node.ts";

export type ConfigSnapshot = { document: UnifiedConfig; revision: string; exists: boolean };
export type ConfigStore = {
  layout: ConfigLayout;
  read: () => Promise<ConfigSnapshot>;
  change: (command: ConfigChange, admit?: () => Promise<void>) => Effect.Effect<ConfigCommitReceipt, unknown>;
  receipt: (operationId: string) => Promise<ConfigCommitReceipt | undefined>;
  operation: (operationId: string) => Promise<OperationRecord | undefined>;
};
export type OperationRecord = {
  schemaVersion: 1; operationId: string; fingerprint: string;
  beforeRevision: string; afterRevision: string;
  phase: "prepared" | "committed";
  result: ConfigCommitReceipt;
};
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });

async function legacyPresent(layout: ConfigLayout): Promise<boolean> {
  for (const path of [join(layout.configDir, "daemon", "config.json"), join(layout.root, "state", "desired.json")]) {
    try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  try {
    const profiles = await readdir(join(layout.configDir, "profiles"), { withFileTypes: true });
    for (const entry of profiles) if (entry.isDirectory()) {
      try { await lstat(join(layout.configDir, "profiles", entry.name, "config.json")); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return false;
}
async function readSnapshot(layout: ConfigLayout): Promise<ConfigSnapshot> {
  const migration = await readConfigFile(join(layout.root, "state", "config-migration.json"), true);
  if (migration !== undefined && (!isObject(migration) || !["activated", "retired"].includes(String(migration.phase)))) {
    throw new ConfigError("config_migration_required", "Configuration migration requires recovery before normal use.");
  }
  const value = await readConfigFile(layout.configPath, true);
  if (value === undefined && await legacyPresent(layout)) {
    throw new ConfigError("config_migration_required", "Legacy configuration exists; run grokbox config migrate --preview.");
  }
  const document = value === undefined ? defaultConfig() : validateConfig(value);
  return { document, revision: configRevision(document), exists: value !== undefined };
}

function operationPath(root: string, id: string): string { return join(root, "state", "config-operations", `${sha256Text(id)}.json`); }
async function readOperation(root: string, id: string): Promise<OperationRecord | undefined> {
  const value = await readConfigFile(operationPath(root, id), true);
  if (value === undefined) return undefined;
  if (!isObject(value) || value.schemaVersion !== 1 || value.operationId !== id || typeof value.fingerprint !== "string" ||
    typeof value.beforeRevision !== "string" || typeof value.afterRevision !== "string" || !isObject(value.result) ||
    !["prepared", "committed"].includes(String(value.phase))) throw new ConfigError("config_commit_unknown", "Configuration operation receipt is invalid.");
  return value as OperationRecord;
}

export function openConfigStore(layout: ConfigLayout): ConfigStore {
  const read = () => readSnapshot(layout);
  const change = (command: ConfigChange, admit?: () => Promise<void>): Effect.Effect<ConfigCommitReceipt, unknown> => Effect.gen(function* () {
    // Domain add/remove rebase safely on the locked latest value. A generic set
    // instead compares its pre-lock snapshot even without an explicit CLI revision.
    const fingerprint = sha256Text(configChangeFingerprint(command));
    const replay = (previous: OperationRecord | undefined) => {
      if (!previous) return undefined;
      if (previous.fingerprint !== fingerprint) throw new ConfigError("config_idempotency_conflict", "Operation ID was already used for another configuration change.");
      if (previous.phase !== "committed") throw new ConfigError("config_commit_unknown", "The original configuration commit is unverified; a matching current value cannot establish historical publication.", { operationId: command.operationId });
      return previous.result;
    };
    // Completed replays are reads, independent of the current config or locks.
    const prior = yield* attempt(() => readOperation(layout.root, command.operationId));
    if (prior) return yield* Effect.try({ try: () => replay(prior)!, catch: error => error });
    const observed = yield* attempt(read);
    const expected = command.expectedRevision ?? (command.kind === "keep" ? undefined : observed.revision);
    return yield* Effect.acquireUseRelease(
      attempt(() => acquireConfigurationLease(layout.root)),
      () => Effect.gen(function* () {
        const previous = yield* attempt(() => readOperation(layout.root, command.operationId));
        if (previous) return yield* Effect.try({ try: () => replay(previous)!, catch: error => error });
        const current = yield* attempt(read);
        if (expected !== undefined && current.revision !== expected) return yield* Effect.fail(new ConfigError("config_conflict", "Configuration changed; reread and preview before retrying."));
        if (layout.role === "client" && command.scope !== "client") return yield* Effect.fail(new ConfigError("config_scope_unavailable", "No Box installation is bound to this configuration."));
        if (command.kind === "keep" && command.action === "remove") {
          const installation = yield* attempt(() => readInstallation(layout.root));
          if (installation?.desktop?.floorAgentIds?.includes(command.agentId)) return yield* Effect.fail(new ConfigError("config_path_invalid", "Installation floor protection cannot be removed by a preference command."));
        }
        const next = yield* Effect.try({ try: () => applyConfigChange(current.document, command), catch: (error) => error });
        // Optional local access-policy read at the final new-effect boundary.
        // Completed receipt reads skip this; callers must not perform network
        // work in admission while this cooperative configuration lease is held.
        if (admit) yield* attempt(admit);
        const afterRevision = configRevision(next.document);
        const result: ConfigCommitReceipt = {
          operationId: command.operationId, scope: command.scope, document: "config",
          commit: afterRevision === current.revision ? "unchanged" : "committed", configRevision: afterRevision,
          changedPaths: next.changedPaths, application: configApplication(next.changedPaths),
          applicationRevisions: configApplicationRevisions(next.document, next.changedPaths),
        };
        const record: OperationRecord = { schemaVersion: 1, operationId: command.operationId, fingerprint,
          beforeRevision: current.revision, afterRevision, phase: "prepared", result };
        // The short publication checkpoint is uninterruptible; network work and
        // consumer application are deliberately outside this resource boundary.
        return yield* Effect.uninterruptible(Effect.gen(function* () {
          yield* attempt(() => publishConfigFile(operationPath(layout.root, command.operationId), record));
          const again = yield* attempt(read);
          if (again.revision !== current.revision) return yield* Effect.fail(new ConfigError("config_conflict", "Configuration changed before publication."));
          if (afterRevision !== current.revision || !current.exists) yield* attempt(() => publishConfigFile(layout.configPath, next.document, undefined, false, admit));
          else if (admit) yield* attempt(admit);
          const committed = yield* attempt(read);
          if (committed.revision !== afterRevision) return yield* Effect.fail(new ConfigError("config_commit_unknown", "Configuration publication did not read back the expected revision.", { operationId: command.operationId }));
          yield* attempt(() => publishConfigFile(operationPath(layout.root, command.operationId), { ...record, phase: "committed" }));
          return result;
        })).pipe(Effect.catch((error) => Effect.fail(error instanceof ConfigError ? error : new ConfigError("config_commit_unknown", "Configuration commit requires receipt reconciliation.", { operationId: command.operationId }))));
      }),
      (lease) => attempt(lease.release).pipe(Effect.orDie),
    );
  });
  return { layout, read, change, operation: id => readOperation(layout.root, id), receipt: async (id) => {
    const record = await readOperation(layout.root, id);
    if (!record) return undefined;
    if (record.phase === "committed") return record.result;
    throw new ConfigError("config_commit_unknown", "Configuration operation has no verified commit. Current content equality is not historical commit evidence.");
  } };
}

export async function recoverConfigCommit(store: ConfigStore, operationId?: string) {
  const lease = await acquireConfigurationLease(store.layout.root, true);
  try {
    const snapshot = await store.read();
    const operation = operationId ? await store.receipt(operationId) : undefined;
    return { recovered: true, configRevision: snapshot.revision, operation: operation ?? null, replayed: false };
  } finally { await lease.release(); }
}

/** Promise facade exists only at the CLI/embedding boundary. */
export async function commitConfigChange(store: ConfigStore, command: ConfigChange): Promise<ConfigCommitReceipt> {
  return await Effect.runPromise(runConfigChange(command).pipe(Effect.provide(unifiedConfigurationLayer(store))));
}

/** Same ConfigurationWrite service consumed by domain and generic commands. */
export function unifiedConfigurationLayer(store: ConfigStore): Layer.Layer<ConfigurationWrite> {
  return Layer.succeed(ConfigurationWrite, {
    changeConfig: store.change,
    saveModels: () => Effect.fail(new ConfigError("config_path_invalid", "Use models commands for the model document.")),
    saveDesired: (file) => store.change({ operationId: randomUUID(), scope: "box", kind: "set", path: "runtime.desiredMode", value: file.mode, confirm: true })
      .pipe(Effect.map((receipt) => ({ configRevision: receipt.configRevision }))),
  });
}
