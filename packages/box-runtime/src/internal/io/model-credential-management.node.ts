import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { Effect } from "effect";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { isObject } from "@grokbox/runtime-kernel/config";
import { ModelManagementError, modelConfigurationRevision } from "@grokbox/runtime-kernel/model-management";
import type { ModelCredentialRequest, ModelCredentialReceipt } from "@grokbox/runtime-kernel/model-credential";
import type { RuntimeStore } from "./configuration.node.ts";
import { assertSafeDirectory, publishConfigFile, readConfigFile } from "./config-layout.node.ts";
import { acquireConfigurationLease } from "./config-lock.node.ts";
import { persistModelCredential, type PersistModelCredentialInput } from "./persist-model-credential.node.ts";
type Record = { key: string; fingerprint: string; receipt: ModelCredentialReceipt };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function openModelCredentialManagement(store: RuntimeStore, installationId: string, principalId: string) {
  const directory = join(store.root, "state", "model-credential-operations");
  const key = (id: string) => sha256Text(canonicalJson([installationId, principalId, id]));
  const path = (hash: string) => join(directory, `${hash}.json`);
  const read = async (hash: string): Promise<Record | undefined> => {
    const value = await readConfigFile(path(hash), true);
    if (value === undefined) return undefined;
    if (!isObject(value) || Object.keys(value).length !== 3 || value.key !== hash || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint) || !isObject(value.receipt)) throw new ModelManagementError("unavailable", "Credential receipt is invalid.");
    const r = value.receipt;
    if (Object.keys(r).length !== 6 || typeof r.requestId !== "string" || !uuid.test(r.requestId) || typeof r.modelId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(r.modelId) || (r.state !== "unknown" && r.state !== "failed" && r.state !== "succeeded")
      || !(r.state === "unknown" || r.state === "failed" ? r.revision === null : typeof r.revision === "string" && /^[a-f0-9]{64}$/.test(r.revision))
      || r.effectiveWhen !== "next-unbound-turn" || r.secretReturned !== false) throw new ModelManagementError("unavailable", "Credential receipt is invalid.");
    return { key: hash, fingerprint: value.fingerprint, receipt: { requestId: r.requestId, modelId: r.modelId, state: r.state,
      revision: typeof r.revision === "string" ? r.revision : null, effectiveWhen: "next-unbound-turn", secretReturned: false } };
  };
  const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({ try: run, catch: error => error });
  return {
    receipt: async (requestId: string) => (await read(key(requestId)))?.receipt,
    change: (request: ModelCredentialRequest, authorize: () => Promise<void>, readCredential?: PersistModelCredentialInput["readCredential"]) => Effect.gen(function* () {
      const hash = key(request.requestId), fingerprint = sha256Text(canonicalJson(request));
      const replay = (record: Record | undefined) => {
        if (record && record.fingerprint !== fingerprint) throw new ModelManagementError("idempotency_conflict", "Credential request UUID already names another input.");
        return record?.receipt;
      };
      const previous = yield* attempt(() => read(hash));
      if (previous) return yield* Effect.try({ try: () => replay(previous)!, catch: error => error });
      const prepared = yield* Effect.acquireUseRelease(attempt(() => acquireConfigurationLease(store.root)), () => Effect.gen(function* () {
        const original = yield* attempt(() => read(hash));
        if (original) return { kind: "prior" as const, receipt: yield* Effect.try({ try: () => replay(original)!, catch: error => error }) };
        const models = yield* attempt(store.loadModels);
        if (modelConfigurationRevision(models) !== request.expectedRevision) return yield* Effect.fail(new ModelManagementError("revision_conflict", "Model configuration changed before credential admission."));
        if (!Object.hasOwn(models.models, request.modelId)) return yield* Effect.fail(new ModelManagementError("not_found", "The credential target model does not exist."));
        yield* attempt(() => assertSafeDirectory(directory, true));
        const entries = yield* attempt(() => readdir(directory));
        if (entries.length >= 1024) return yield* Effect.fail(new ModelManagementError("store_full", "Credential receipt history is full."));
        for (const entry of entries) {
          if (!/^[a-f0-9]{64}\.json$/.test(entry)) return yield* Effect.fail(new ModelManagementError("unavailable", "Credential history requires inspection."));
          const record = yield* attempt(() => read(entry.slice(0, -5)));
          if (record?.receipt.modelId === request.modelId && record.receipt.state === "unknown") return yield* Effect.fail(new ModelManagementError("operation_unknown", "An earlier credential import for this model remains uncertain."));
        }
        yield* attempt(authorize);
        const receipt: ModelCredentialReceipt = { requestId: request.requestId, modelId: request.modelId, state: "unknown", revision: null,
          effectiveWhen: "next-unbound-turn", secretReturned: false };
        yield* Effect.uninterruptible(attempt(() => publishConfigFile(path(hash), { key: hash, fingerprint, receipt }, undefined, true)));
        return { kind: "prepared" as const, receipt };
      }), lease => attempt(lease.release).pipe(Effect.orDie));
      if (prepared.kind === "prior") return prepared.receipt;
      // The fixed Pi credential adapter and original models publisher own the
      // effect. A prepared request is never retried, including after restart.
      let pending: Promise<ModelCredentialReceipt> | undefined;
      return yield* Effect.acquireUseRelease(Effect.sync(() => new AbortController()), controller => attempt(() => {
        pending = (async () => {
          let publicationAttempted = false;
          let receipt: ModelCredentialReceipt;
          try {
            const imported = await persistModelCredential({ store, modelId: request.modelId, piProvider: request.piProvider,
              confirmed: true, expectedRevision: request.expectedRevision, authorize, readCredential, signal: controller.signal,
              beforePublication: () => { publicationAttempted = true; } });
            receipt = { ...prepared.receipt, state: "succeeded", revision: imported.modelRevision };
          } catch {
            if (publicationAttempted) return prepared.receipt;
            receipt = { ...prepared.receipt, state: "failed" };
          }
          try { await publishConfigFile(path(hash), { key: hash, fingerprint, receipt }); return receipt; }
          catch { return prepared.receipt; }
        })();
        return pending;
      }), controller => Effect.promise(async () => {
        // Cancellation stops admission/source work. Once publication has begun,
        // the Scope joins the original publisher and receipt before closing.
        controller.abort();
        await pending;
      }));
    }),
  };
}
