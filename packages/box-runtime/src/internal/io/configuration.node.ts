import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireExclusiveLock } from "./op-lock.ts";
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { BoxRuntimeError, CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { ConfigurationRead } from "@grokbox/runtime-kernel/ports";
import {
  catalogWantsPi,
  parseDesiredFile,
  parseModelsFile,
  persistModelsDocument,
  piModelsPathCandidates,
  resolveModelsWithPi,
  type DesiredFile,
  type ModelsFile,
} from "@grokbox/runtime-kernel/selection";
import { readBoundedJson as readExternalCatalogJson } from "./bounded-json.node.ts";
import { modelsPath, resolveDurableRoot } from "./paths.ts";
import { runtimeDesiredFromConfig, ConfigError } from "@grokbox/runtime-kernel/config";
import { rootConfigLayout, readConfigFile } from "./config-layout.node.ts";
import { openConfigStore, commitConfigChange } from "./config-store.node.ts";

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type RuntimeStore = {
  root: string;
  loadModels: () => Promise<ModelsFile>;
  loadDesired: () => Promise<DesiredFile>;
  saveModels: (file: ModelsFile, expectedRevision?: string) => Promise<void>;
  saveDesired: (file: DesiredFile) => Promise<void>;
};

async function resolveStoreModels(native: ModelsFile, env?: NodeJS.Dict<string>): Promise<ModelsFile> {
  if (!native.externalCatalog || !catalogWantsPi(native.externalCatalog)) return native;
  const envMap = (env ?? process.env) as Record<string, string | undefined>;
  const home = homedir();
  const cache = new Map<string, unknown | undefined>();
  for (const path of piModelsPathCandidates({ catalog: native.externalCatalog, homedir: home, env: envMap })) {
    cache.set(path, await readExternalCatalogJson(path));
  }
  return resolveModelsWithPi(native, {
    homedir: home,
    env: envMap,
    read: (path) => cache.get(path),
  });
}

export function openRuntimeStore(rootOverride?: string, env?: NodeJS.Dict<string>): RuntimeStore {
  const root = resolveDurableRoot(rootOverride, env);
  return {
    root,
    loadModels: async () => resolveStoreModels(parseModelsFile(await readJson(modelsPath(root))), env),
    loadDesired: async () => loadRuntimeDesired(root),
    saveModels: async (file, expectedRevision) => {
      // One short cooperative commit boundary; no Server request while locked.
      // A stale writer is refused, never silently merged or retried.
      const held = await acquireExclusiveLock(join(root, "state", "models-write.lock"));
      if (!held.ok) throw new BoxRuntimeError("invalid_usage", "model_configuration_busy");
      try {
        const persisted = persistModelsDocument(file);
        if (expectedRevision !== undefined) {
          const current = persistModelsDocument(parseModelsFile(await readJson(modelsPath(root))));
          if (sha256Text(canonicalJson(current)) !== expectedRevision) {
            throw new BoxRuntimeError("invalid_usage", "selection_configuration_changed");
          }
        }
        await writeJsonAtomic(modelsPath(root), persisted);
        const current = parseModelsFile(await readJson(modelsPath(root)));
        if (canonicalJson(current) !== canonicalJson(parseModelsFile(persisted))) {
          throw new BoxRuntimeError("invalid_usage", "model_configuration_readback_mismatch");
        }
      } finally { await held.lock.release(); }
    },
    saveDesired: async (file) => {
      const desired = parseDesiredFile(file);
      await commitConfigChange(openConfigStore(rootConfigLayout(root)), {
        operationId: randomUUID(), scope: "box", kind: "set", path: "runtime.desiredMode", value: desired.mode, confirm: true,
      });
    },
  };
}

export async function loadRuntimeDesired(root: string): Promise<DesiredFile> {
  const migration = await readConfigFile(join(root, "state", "config-migration.json"), true);
  if (migration && (!(typeof migration === "object") || !["activated", "retired"].includes(String((migration as { phase?: unknown }).phase)))) {
    throw new ConfigError("config_migration_required", "Runtime configuration migration is not activated.");
  }
  const raw = await readConfigFile(join(root, "config.json"), true);
  if (raw === undefined && await readConfigFile(join(root, "state", "desired.json"), true) !== undefined) {
    throw new ConfigError("config_migration_required", "Legacy runtime desired state requires explicit migration.");
  }
  return runtimeDesiredFromConfig(raw);
}

export function secretsDir(root: string): string {
  return join(root, "secrets");
}

function configUnreadable(): BoxRuntimeError {
  return new BoxRuntimeError("invalid_usage", "canonical configuration is unreadable or exceeds the 128 KiB no-follow bound.");
}

function readBoundedJson(path: string, optional = false): Effect.Effect<unknown, BoxRuntimeError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      catch: (error) => {
        if (optional && error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return new BoxRuntimeError("invalid_usage", "optional-missing");
        }
        return configUnreadable();
      },
    }),
    (file: FileHandle) => Effect.gen(function* () {
      const info = yield* Effect.tryPromise({
        try: () => file.stat(),
        catch: () => configUnreadable(),
      });
      if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return yield* Effect.fail(configUnreadable());
      const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
      const read = yield* Effect.tryPromise({
        try: () => file.read(bytes, 0, bytes.length, 0),
        catch: () => configUnreadable(),
      });
      if (read.bytesRead > CONFIG_READ_MAX_BYTES) return yield* Effect.fail(configUnreadable());
      try {
        return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown;
      } catch {
        return yield* Effect.fail(configUnreadable());
      }
    }),
    (file) => Effect.promise(() => file.close()).pipe(Effect.ignore),
  ).pipe(Effect.catchIf(
    (error) => error instanceof BoxRuntimeError && error.message === "optional-missing",
    () => Effect.succeed(undefined),
  ));
}

/** Same 128 KiB / no-follow / regular-file bound as Host capture. Same parsers. */
export function configurationReadLayer(store: RuntimeStore): Layer.Layer<ConfigurationRead> {
  return Layer.succeed(ConfigurationRead, {
    snapshot: () => Effect.gen(function* () {
      const modelsRaw = yield* readBoundedJson(modelsPath(store.root));
      const desired = yield* Effect.tryPromise({ try: () => loadRuntimeDesired(store.root), catch: (error) => error });
      const models = yield* Effect.tryPromise({
        try: () => resolveStoreModels(parseModelsFile(modelsRaw)),
        catch: (error) => error instanceof BoxRuntimeError ? error : new BoxRuntimeError("invalid_usage", "Model configuration is unavailable."),
      });
      return {
        models,
        desired,
      };
    }),
  });
}
