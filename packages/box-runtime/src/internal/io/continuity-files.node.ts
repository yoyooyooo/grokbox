import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join, parse, relative, resolve } from "node:path";
import { ContinuityFailure, failContinuity, isContinuityHash, isContinuityUuid } from "@grokbox/runtime-kernel/continuity";

export const blobDigest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const missingFile = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
export function continuityIoFailure(error: unknown): ContinuityFailure {
  if (error instanceof ContinuityFailure) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return new ContinuityFailure(["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code) ? "busy"
    : ["SQLITE_FULL", "ENOSPC", "EDQUOT"].includes(code) ? "capacity"
    : ["ELOOP", "EPERM", "EACCES"].includes(code) ? "unsafe_path" : "unavailable");
}
/** Ancestors may be shared system directories, but none may redirect through a
 * symlink. The actual owned roots must be private and owned by this UID. This
 * is not isolation against an adversarial process running as the same user. */
export async function checkContinuityRoot(root: string): Promise<void> {
  const path = resolve(root); let at = parse(path).root;
  for (const segment of relative(at, path).split(/[\\/]/).filter(Boolean)) {
    at = join(at, segment); const st = await lstat(at);
    if (!st.isDirectory() || st.isSymbolicLink()) return failContinuity("unsafe_path");
  }
  const st = await lstat(path);
  if ((st.mode & 0o077) || process.getuid && st.uid !== process.getuid()) return failContinuity("unsafe_path");
}
export async function continuityPrivateDirectory(path: string, create = false): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST")) throw e; }
  }
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.mode & 0o077 || process.getuid && st.uid !== process.getuid()) return failContinuity("unsafe_path");
}
export async function checkContinuityFile(path: string, optional = false) {
  let st;
  try { st = await lstat(path); } catch (e) { if (optional && missingFile(e)) return null; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.mode & 0o077 || process.getuid && st.uid !== process.getuid()) return failContinuity("unsafe_path");
  return st;
}
export async function syncContinuityDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
export function continuityFiles(directory: string) {
  const objects = join(directory, "objects"), staging = join(directory, "staging");
  const objectPath = (hash: string) => { if (!isContinuityHash(hash)) return failContinuity("invalid_material"); return join(objects, `${hash}.blob`); };
  const stagePath = (requestId: string, hash: string) => {
    if (!isContinuityUuid(requestId) || !isContinuityHash(hash)) return failContinuity("invalid_material");
    return join(staging, `${requestId}-${hash}.part`);
  };
  const check = async () => { await checkContinuityRoot(directory); await continuityPrivateDirectory(objects); await continuityPrivateDirectory(staging); };
  const read = async (hash: string, bytes: number): Promise<Uint8Array> => {
    await check(); const path = objectPath(hash), st = await checkContinuityFile(path);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || st!.size !== bytes) return failContinuity("integrity_failure");
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await fd.stat(); if (before.dev !== st!.dev || before.ino !== st!.ino || before.size !== bytes || before.nlink !== 1) return failContinuity("integrity_failure");
      const data = new Uint8Array(bytes); let offset = 0;
      while (offset < bytes) { const got = await fd.read(data, offset, bytes - offset, offset); if (!got.bytesRead) return failContinuity("integrity_failure"); offset += got.bytesRead; }
      const after = await fd.stat(), current = await lstat(path);
      if (after.size !== bytes || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink() || blobDigest(data) !== hash) return failContinuity("integrity_failure");
      return data;
    } finally { await fd.close(); }
  };
  // Must be serialized with publication/recovery/GC by the CONT SQLite writer.
  const finishStage = async (requestId: string, hash: string) => {
    await check(); const temporary = stagePath(requestId, hash);
    let st; try { st = await lstat(temporary); } catch (e) { if (missingFile(e)) return; throw e; }
    if (!st.isFile() || st.isSymbolicLink() || st.mode & 0o077 || process.getuid && st.uid !== process.getuid()) return failContinuity("unsafe_path");
    if (st.nlink > 1) {
      const final = await lstat(objectPath(hash));
      if (st.nlink !== 2 || final.isSymbolicLink() || final.dev !== st.dev || final.ino !== st.ino) return failContinuity("unsafe_path");
    }
    await unlink(temporary); await syncContinuityDirectory(staging);
  };
  return {
    objects, staging, objectPath, check, read, finishStage,
    put: async (requestId: string, hash: string, data: Uint8Array) => {
      await check(); if (blobDigest(data) !== hash) return failContinuity("integrity_failure");
      const path = objectPath(hash);
      if (await checkContinuityFile(path, true)) { await read(hash, data.byteLength); return; }
      const temporary = stagePath(requestId, hash);
      const fd = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
      await link(temporary, path); await syncContinuityDirectory(objects);
      await finishStage(requestId, hash); await read(hash, data.byteLength);
    },
    remove: async (hash: string) => {
      await check(); const path = objectPath(hash), st = await checkContinuityFile(path, true);
      if (!st) return 0;
      await unlink(path); await syncContinuityDirectory(objects); return st.size;
    },
    allocation: async (path: string) => {
      const st = await checkContinuityFile(path, true);
      return st ? { allocationId: createHash("sha256").update(`${st.dev}:${st.ino}`).digest("hex"), allocatedBytes: st.blocks * 512 } : null;
    },
  };
}
