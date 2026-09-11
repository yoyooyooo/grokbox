import { resolve } from "node:path";
import { Effect, Layer } from "effect";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { runConfigurationSave } from "@grokbox/runtime-kernel/commands";
import { ConfigurationWrite } from "@grokbox/runtime-kernel/ports";
import type { DesiredFile, ModelsFile } from "@grokbox/runtime-kernel/selection";
import type { RuntimeStore } from "./configuration.node.ts";

/** Live ConfigurationWrite: atomic store save, then payload digest. No expected-revision CAS. */
export function configurationWriteLayer(store: RuntimeStore): Layer.Layer<ConfigurationWrite> {
  const revision = (file: unknown) => ({ configRevision: sha256Text(canonicalJson(file)) });
  return Layer.succeed(ConfigurationWrite, {
    saveModels: (file) => Effect.tryPromise({
      try: async () => {
        await store.saveModels(file);
        return revision(file);
      },
      catch: (error) => error,
    }),
    saveDesired: (file) => Effect.tryPromise({
      try: async () => {
        await store.saveDesired(file);
        return revision(file);
      },
      catch: (error) => error,
    }),
  });
}

async function saveViaCommand(
  store: RuntimeStore,
  kind: "models" | "desired",
  file: ModelsFile | DesiredFile,
  boxRoot = store.root,
): Promise<{ configRevision: string }> {
  if (resolve(boxRoot) !== resolve(store.root)) {
    throw new BoxRuntimeError("runtime_local_only", "Configuration save is bound to this box runtime root.");
  }
  const receipt = await Effect.runPromise(
    runConfigurationSave({ boxRoot, kind, file }).pipe(Effect.provide(configurationWriteLayer(store))),
  );
  if (!receipt.ok) {
    throw new BoxRuntimeError(
      receipt.reason === "remote-box-root" ? "runtime_local_only" : "invalid_usage",
      receipt.reason,
    );
  }
  return { configRevision: receipt.configRevision };
}

export async function saveRuntimeModels(store: RuntimeStore, file: ModelsFile, boxRoot = store.root): Promise<{ configRevision: string }> {
  return await saveViaCommand(store, "models", file, boxRoot);
}

export async function saveRuntimeDesired(store: RuntimeStore, file: DesiredFile, boxRoot = store.root): Promise<{ configRevision: string }> {
  return await saveViaCommand(store, "desired", file, boxRoot);
}
