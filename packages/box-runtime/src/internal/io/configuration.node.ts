import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
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

/** Effect read of the same parseModelsFile / parseDesiredFile Host sync uses. */
export function configurationReadLayer(store: RuntimeStore): Layer.Layer<ConfigurationRead> {
  return Layer.succeed(ConfigurationRead, {
    snapshot: () => Effect.tryPromise({
      try: async () => ({
        models: await store.loadModels(),
        desired: await store.loadDesired(),
      }),
      catch: (error) => error,
    }),
  });
}
