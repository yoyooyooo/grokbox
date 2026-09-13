import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { materializeApiKeyRef, CREDENTIAL_SECRET_MAX_BYTES } from "./credentials.node.ts";
import type { RuntimeStore } from "./configuration.node.ts";
import { saveRuntimeModels } from "./configuration-write.node.ts";

function refused(message: string): never { throw new BoxRuntimeError("credential_invalid", message); }

/** Fixed Pi auth operation, bounded output and no shell. Never expose child stderr. */
export function readPiModelCredential(provider: string, model: string, signal?: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(provider) || !model || model.length > 256 || /[\x00-\x1f]/.test(model)) {
    refused("Invalid Pi credential source.");
  }
  return new Promise((resolveKey, reject) => {
    execFile("pi", ["auth", "print-api-key", "--provider", provider, "--model", model], {
      encoding: "utf8", timeout: 10_000, maxBuffer: CREDENTIAL_SECRET_MAX_BYTES, signal,
    }, (error, stdout) => {
      if (error) { reject(new BoxRuntimeError("credential_invalid", "Pi credential source failed; no configuration was changed.")); return; }
      resolveKey(stdout);
    });
  });
}

export type PersistModelCredentialInput = {
  store: RuntimeStore;
  modelId: string;
  piProvider: string;
  confirmed: boolean;
  signal?: AbortSignal;
  /** Owned test seam; production always uses the fixed Pi auth adapter above. */
  readCredential?: typeof readPiModelCredential;
};

/**
 * Persist only one explicitly selected model's credential through existing C1
 * file references and ConfigurationWrite. No assignments, Host, daemon, or model
 * selection changes. Existing files/active auth leases are never overwritten.
 */
export async function persistModelCredential(input: PersistModelCredentialInput): Promise<{
  modelId: string; apiKeyRef: string; persisted: true; reused: boolean;
  takesEffect: "next_unbound_turn"; configRevision?: string;
}> {
  if (!input.confirmed) throw new BoxRuntimeError("invalid_usage", "models persist-key requires --confirm.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.piProvider)) refused("Invalid Pi credential source.");
  if (input.signal?.aborted) refused("Credential import cancelled.");
  const original = await input.store.loadModels();
  const model = Object.hasOwn(original.models, input.modelId) ? original.models[input.modelId] : undefined;
  if (!model) throw new BoxRuntimeError("invalid_usage", "Target model must already exist in the catalog.");
  const root = resolve(input.store.root);
  if (await realpath(root) !== root) refused("Credential root must not traverse a symlink.");
  let secret: string;
  try { secret = await (input.readCredential ?? readPiModelCredential)(input.piProvider, model.model, input.signal); }
  catch { refused("Credential source failed; no configuration was changed."); }
  secret = secret.trim();
  if (!secret || Buffer.byteLength(secret) > CREDENTIAL_SECRET_MAX_BYTES || /[\x00-\x1f\x7f]/.test(secret) || secret.startsWith("!/")) {
    refused("Credential source did not return a bounded API key.");
  }
  const secretDir = join(root, "secrets");
  let created: { path: string; ino: number; dev: number } | undefined;
  const referenced = async (path: string) => Object.values((await input.store.loadModels()).models).some((m) => m.apiKeyRef === `file:${path}`);
  try {
    if (model.apiKeyRef.startsWith(`file:${secretDir}/`)) {
      try {
        const path = model.apiKeyRef.slice(5);
        const stat = await lstat(path);
        if (resolve(path) === path && await realpath(path) === path && stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
          && stat.uid === process.getuid?.() && await materializeApiKeyRef(model.apiKeyRef, {}, input.signal) === secret) {
          return { modelId: input.modelId, apiKeyRef: model.apiKeyRef, persisted: true, reused: true, takesEffect: "next_unbound_turn" };
        }
      } catch { /* An invalid old reference is not overwritten or trusted. */ }
    }
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(secretDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
      || directory.uid !== process.getuid?.() || await realpath(secretDir) !== secretDir) {
      refused("Credential directory must be a private, owned directory without symlinks.");
    }
    if (input.signal?.aborted) refused("Credential import cancelled.");
    const path = join(secretDir, `model-${randomUUID()}.key`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      created = { path, ino: stat.ino, dev: stat.dev };
      await handle.writeFile(secret, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    // Re-read before writing. This detects observed drift, not transactional CAS.
    const fresh = await input.store.loadModels();
    if (canonicalJson(fresh) !== canonicalJson(original)) throw new BoxRuntimeError("invalid_usage", "Model configuration changed during credential import.");
    if (input.signal?.aborted) refused("Credential import cancelled.");
    const apiKeyRef = `file:${path}`;
    const next = parseModelsFile({ ...fresh, models: { ...fresh.models, [input.modelId]: { ...model, apiKeyRef } } });
    const receipt = await saveRuntimeModels(input.store, next, input.store.root, sha256Text(canonicalJson(original)));
    if (!await referenced(path)) throw new BoxRuntimeError("invalid_usage", "Credential configuration could not be read back.");
    return { modelId: input.modelId, apiKeyRef, persisted: true, reused: false, takesEffect: "next_unbound_turn", ...receipt };
  } catch (error) {
    if (created) {
      // A save might have committed before its caller failed. Never delete a
      // credential referenced by any current model, or an unconfirmed replacement.
      try {
        if (!await referenced(created.path)) {
          const now = await lstat(created.path);
          if (now.isFile() && now.nlink === 1 && now.ino === created.ino && now.dev === created.dev) await unlink(created.path);
        }
      } catch { /* Unknown reference/cleanup outcome: retain, never guess. */ }
    }
    if (error instanceof BoxRuntimeError) throw error;
    refused("Credential import failed; inspect configuration before retrying.");
  } finally { secret = ""; }
}
