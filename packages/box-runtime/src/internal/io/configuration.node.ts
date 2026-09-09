import { constants } from "node:fs";
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { BoxRuntimeError, CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { ConfigurationRead } from "@grokbox/runtime-kernel/ports";
import { parseDesiredFile, parseModelsFile, type DesiredFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { desiredPath, modelsPath, resolveDurableRoot } from "./paths.ts";

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
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type RuntimeStore = {
  root: string;
  loadModels: () => Promise<ModelsFile>;
  loadDesired: () => Promise<DesiredFile>;
  saveModels: (file: ModelsFile) => Promise<void>;
  saveDesired: (file: DesiredFile) => Promise<void>;
};

export function openRuntimeStore(rootOverride?: string, env?: NodeJS.Dict<string>): RuntimeStore {
  const root = resolveDurableRoot(rootOverride, env);
  return {
    root,
    loadModels: async () => parseModelsFile(await readJson(modelsPath(root))),
    loadDesired: async () => parseDesiredFile(await readJson(desiredPath(root))),
    saveModels: async (file) => await writeJsonAtomic(modelsPath(root), file),
    saveDesired: async (file) => await writeJsonAtomic(desiredPath(root), file),
  };
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
      const desiredRaw = yield* readBoundedJson(desiredPath(store.root), true);
      return {
        models: parseModelsFile(modelsRaw),
        desired: parseDesiredFile(desiredRaw),
      };
    }),
  });
}
