import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalJson, sha256Text } from "@grokbox/runtime-kernel/hash";
import { CONFIG_SCHEMA_VERSION, effectiveStorage } from "@grokbox/runtime-kernel/observation";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";

export type JournalPolicyReceipt = {
  source: "canonical-config" | "default-no-config";
  sourceRootId: string;
  storageRevision: string;
  policy: { segmentBytes: number; maxBytes: number; maxAgeMs: number };
};
const invalid = (): never => { throw new Error("journal_storage_config_unavailable"); };
const missing = (e: unknown) => e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
const field = (v: unknown, key: string): unknown => v && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, key)?.value : undefined;

/** Small asynchronous descriptor-pinned read. Missing is not malformed, unsafe,
 * oversized, replaced or an in-progress migration. No raw error is returned. */
async function document(path: string, maxBytes = CONFIG_READ_MAX_BYTES): Promise<unknown | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o077) !== 0
      || process.getuid && before.uid !== process.getuid()) return invalid();
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return invalid();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))) as unknown;
  } catch (error) { if (handle === undefined && missing(error)) return undefined; return invalid(); }
  finally { await handle?.close().catch(() => undefined); }
}

/** The composition root supplies the canonical root explicitly; no HOME,
 * arbitrary event field, executable argv or run-root parent guessing. The Host
 * reads only the storage dependency slice, not ops/credentials/model choices. */
export async function readJournalPolicy(configurationRoot: string): Promise<JournalPolicyReceipt> {
  if (!isAbsolute(configurationRoot)) return invalid();
  const root = resolve(configurationRoot);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) return invalid();
  } catch (error) { if (!missing(error)) return invalid(); }
  const migration = await document(join(root, "state", "config-migration.json"));
  if (migration !== undefined && !["activated", "retired"].includes(String(field(migration, "phase")))) return invalid();
  const value = await document(join(root, "config.json"));
  if (value !== undefined && field(value, "schemaVersion") !== CONFIG_SCHEMA_VERSION) return invalid();
  if (value === undefined) {
    const legacy = await lstat(join(root, "state", "desired.json")).then(() => true, error => { if (missing(error)) return false; return invalid(); });
    if (legacy) return invalid();
  }
  let storage: ReturnType<typeof effectiveStorage>;
  try { storage = effectiveStorage(field(value, "storage") as Parameters<typeof effectiveStorage>[0]); }
  catch { return invalid(); }
  return { source: value === undefined ? "default-no-config" : "canonical-config", sourceRootId: sha256Text(root),
    storageRevision: sha256Text(canonicalJson(storage)), policy: storage.retention.journal };
}
