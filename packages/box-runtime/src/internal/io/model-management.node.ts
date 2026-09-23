import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { persistModelsDocument } from "@grokbox/runtime-kernel/selection";
import {
  ModelManagementError, ModelPublicationRefused, modelChangeTarget, modelConfigurationRevision, persistedModelsRevision,
  type ModelOperation, type ModelOperationLocator, type ModelSnapshot,
} from "@grokbox/runtime-kernel/model-management";
import { ModelConfiguration } from "@grokbox/runtime-kernel/ports";
import type { RuntimeStore } from "./configuration.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { assertSafeDirectory, publishConfigFile, readConfigFile } from "./config-layout.node.ts";

type RecordFile = { version: 1; fingerprint: string; phase: "prepared" | "committed"; operation: ModelOperation };
const OP_REF = /^model-operation:[0-9a-f-]{36}:([a-f0-9]{64})$/;
const HASH = /^[a-f0-9]{64}$/;
function pathFor(root: string, ref: string): string {
  const match = OP_REF.exec(ref);
  if (!match) throw new ModelManagementError("invalid_input", "Invalid model operation reference.");
  return join(root, "state", "model-operations", `${match[1]}.json`);
}
function failure(): ModelManagementError {
  return new ModelManagementError("unavailable", "Model configuration or operation storage is unavailable.");
}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error instanceof ModelManagementError ? error : failure() });
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

async function readRecord(root: string, key: ModelOperationLocator & { fingerprint?: string }): Promise<RecordFile | undefined> {
  const directory = join(root, "state", "model-operations");
  try { await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  await assertSafeDirectory(directory);
  const raw = await readConfigFile(pathFor(root, key.operationRef), true);
  if (raw === undefined) return undefined;
  if (!isObject(raw) || raw.version !== 1 || typeof raw.fingerprint !== "string" || !HASH.test(raw.fingerprint)
    || (raw.phase !== "prepared" && raw.phase !== "committed") || !isObject(raw.operation)) throw failure();
  const operation = raw.operation;
  if (Object.keys(raw).some(key => !["version", "fingerprint", "phase", "operation"].includes(key))
    || Object.keys(operation).some(key => !["version", "operationRef", "requestId", "command", "target", "state", "beforeRevision", "configRevision", "acceptedAt", "effectiveWhen", "currentTurn", "concurrency"].includes(key))) throw failure();
  if (operation.version !== 1 || operation.operationRef !== key.operationRef || operation.requestId !== key.requestId
    || (raw.phase === "committed" ? operation.state !== "succeeded" : operation.state !== "unknown")
    || operation.effectiveWhen !== "next-turn" || operation.currentTurn !== "unchanged"
    || operation.concurrency !== "local_serialized" || typeof operation.beforeRevision !== "string" || !HASH.test(operation.beforeRevision)
    || typeof operation.configRevision !== "string" || !HASH.test(operation.configRevision)
    || typeof operation.target !== "string" || operation.target.length > 256 || typeof operation.acceptedAt !== "string"
    || !Number.isFinite(Date.parse(operation.acceptedAt))
    || !["bot-selection", "default-selection", "model-put", "model-patch", "model-delete"].includes(String(operation.command))) throw failure();
  if (key.fingerprint !== undefined && raw.fingerprint !== key.fingerprint) throw new ModelManagementError("idempotency_conflict", "The request ID was already used for different input.");
  return raw as RecordFile;
}
function projected(record: RecordFile): ModelOperation {
  return { ...record.operation, state: record.phase === "committed" ? "succeeded" : "unknown" };
}
async function assertCapacity(root: string, maxRecords: number): Promise<void> {
  let count = 0;
  const directory = await opendir(join(root, "state", "model-operations"));
  for await (const entry of directory) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) throw failure();
    if (++count >= maxRecords) throw new ModelManagementError("store_full", "Model operation history is full; existing receipts remain readable.");
  }
}

/** Domain receipts share the existing physical models writer. A prepared record
 * is an uncertainty fence, not permission to replay a write after a crash. */
export function modelConfigurationLayer(store: RuntimeStore, options: { maxRecords?: number; now?: () => Date } = {}): Layer.Layer<ModelConfiguration> {
  const maxRecords = options.maxRecords ?? 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096) throw new ModelManagementError("invalid_input", "Invalid model history bound.");
  const read = (): Effect.Effect<ModelSnapshot, ModelManagementError> => io(async () => {
    const models = await store.loadModels();
    return { models, revision: modelConfigurationRevision(models) };
  });
  return Layer.succeed(ModelConfiguration, {
    read,
    lookup: key => io(async () => {
      const record = await readRecord(store.root, key);
      return record ? projected(record) : undefined;
    }),
    commit: (key, observed, next, change, beforePublish) => Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => acquireConfigurationLease(store.root, false, "model-operations"),
        catch: error => isObject(error) && error.code === "config_conflict"
          ? new ModelManagementError("revision_conflict", "Model writer is busy or requires verified recovery; no new operation was accepted.") : failure(),
      }),
      () => Effect.gen(function* () {
        const previous = yield* io(() => readRecord(store.root, key));
        if (previous) return projected(previous);
        const current = yield* read();
        if (current.revision !== observed.revision) return yield* Effect.fail(new ModelManagementError("revision_conflict", "Model configuration changed during admission."));
        yield* io(() => assertSafeDirectory(join(store.root, "state", "model-operations"), true));
        yield* io(() => assertCapacity(store.root, maxRecords));
        if (beforePublish) yield* Effect.tryPromise({ try: beforePublish, catch: error => error });
        const operation: ModelOperation = {
          version: 1, operationRef: key.operationRef, requestId: key.requestId, command: change.kind, target: modelChangeTarget(change),
          state: "unknown", beforeRevision: current.revision, configRevision: modelConfigurationRevision(next),
          acceptedAt: (options.now?.() ?? new Date()).toISOString(), effectiveWhen: "next-turn", currentTurn: "unchanged", concurrency: "local_serialized",
        };
        const record: RecordFile = { version: 1, fingerprint: key.fingerprint, phase: "prepared", operation };
        return yield* Effect.uninterruptible(Effect.gen(function* () {
          yield* io(() => publishConfigFile(pathFor(store.root, key.operationRef), record, undefined, true));
          // Nothing after declaration is retried automatically, including local
          // publication. A readback hash alone cannot rule out an ABA change.
          return yield* Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () => store.saveModels(next, persistedModelsRevision(current.models), beforePublish ? async () => {
                try { await beforePublish(); } catch (error) { throw new ModelPublicationRefused(error); }
              } : undefined),
              catch: error => error instanceof ModelPublicationRefused ? error : failure(),
            });
            const after = yield* read();
            if (canonicalJson(persistModelsDocument(after.models)) !== canonicalJson(persistModelsDocument(next))) {
              return yield* Effect.fail(new ModelManagementError("operation_unknown", "Local model publication could not be verified."));
            }
            const committed: ModelOperation = { ...operation, configRevision: after.revision, state: "succeeded" };
            yield* io(() => publishConfigFile(pathFor(store.root, key.operationRef), { ...record, phase: "committed", operation: committed }));
            return committed;
          }).pipe(Effect.catch(error => error instanceof ModelPublicationRefused
            ? Effect.fail(error.reason) // Keep prepared history; never replay it as a new write.
            : Effect.succeed({ ...operation, state: "unknown" as const })));
        }));
      }),
      lease => io(lease.release).pipe(Effect.orDie),
    ),
  });
}
