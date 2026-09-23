import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";

export class StableSourceFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const sourceDigest = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** One bounded read owner for installed artifacts and private qualification
 * copies. No source execution, realpath fallback, metadata-only certificate or
 * retry-until-green. Descriptors are settled on every failure/cancellation. */
export async function readStableSourceSet(entries, signal, afterRead) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3
    || new Set(entries.map(e => e.path)).size !== entries.length) throw new StableSourceFailure("source-unavailable");
  const opened = [], missing = [];
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!isAbsolute(entry.path) || !Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1 || entry.maxBytes > 64 * 1024 * 1024)
        throw new StableSourceFailure("source-unavailable");
      let file;
      try { file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if (entry.optional && error.code === "ENOENT") { missing.push(entry.path); continue; } throw error; }
      // Register the FD before stat: even a failed fstat must close it.
      const row = { path: entry.path, file, stat: null, bytes: null, digest: null };
      opened.push(row);
      const stat = row.stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size < 1 || stat.size > entry.maxBytes)
        throw new StableSourceFailure("source-unavailable");
      const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const got = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
        if (!got.bytesRead) break;
        offset += got.bytesRead;
      }
      if (offset !== stat.size || !same(stat, await file.stat()) || !same(stat, await lstat(entry.path)))
        throw new StableSourceFailure("source-changed");
      row.bytes = bytes.subarray(0, offset); row.digest = sourceDigest(row.bytes);
      await afterRead?.(opened.length - 1);
    }
    const identities = opened.map(({ path, stat, digest }) => ({ path, stat, digest }));
    const current = async () => {
      try {
        signal?.throwIfAborted();
        for (const path of missing) {
          try { await lstat(path); return false; } catch (error) { if (error.code !== "ENOENT") return false; }
        }
        for (const row of identities) {
          if (!same(row.stat, await lstat(row.path))) return false;
          const file = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if (!same(row.stat, await file.stat())) return false;
            const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
            while (offset <= row.stat.size) {
              signal?.throwIfAborted();
              const got = await file.read(buffer, 0, Math.min(buffer.length, row.stat.size + 1 - offset), offset);
              if (!got.bytesRead) break;
              offset += got.bytesRead; hash.update(buffer.subarray(0, got.bytesRead));
            }
            if (offset !== row.stat.size || hash.digest("hex") !== row.digest || !same(row.stat, await file.stat()) || !same(row.stat, await lstat(row.path))) return false;
          } finally { await file.close(); }
        }
        return true;
      } catch { return false; }
    };
    if (!await current()) throw new StableSourceFailure("source-changed");
    return { files: entries.map(entry => {
      const row = opened.find(row => row.path === entry.path);
      return { path: entry.path, bytes: row?.bytes ?? null, sha256: row?.digest ?? null };
    }), current };
  } catch (error) {
    if (error instanceof StableSourceFailure) throw error;
    throw new StableSourceFailure(signal?.aborted ? "source-cancelled" : "source-unavailable");
  } finally { await Promise.all(opened.map(row => row.file.close())); }
}
