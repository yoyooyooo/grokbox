import { constants, closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { projectHostCompileReceipt, type HostCompileReceipt } from "@grokbox/runtime-kernel/host-health";

/** Extends the existing controller-selected marker, not a new execution owner.
 * A bounded synchronous publication survives an uncaught module exception.
 * Never throws into the Host. Missing evidence cannot become a success marker. */
export function writeHostCompileMarker(path: string, operationId: string, profileId: string, receipt: HostCompileReceipt): boolean {
  let fd: number | undefined, dir: number | undefined, staging: string | undefined;
  try {
    if (!projectHostCompileReceipt(receipt) || typeof operationId !== "string" || operationId.length > 256 || profileId.length > 128) return false;
    const parent = lstatSync(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022)) return false;
    try { const prior = lstatSync(path); if (!prior.isFile() || prior.isSymbolicLink() || prior.nlink !== 1 || prior.uid !== parent.uid || (prior.mode & 0o077)) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    const compiled = receipt.patch === "applied" && receipt.nativeCompilation === "returned";
    const body = JSON.stringify({ operationId, pid: receipt.pid, start: receipt.start, mode: receipt.mode,
      transformed: receipt.patch === "applied", compiled, modeld: false,
      compile: { profileId, profileSha256: receipt.profileDigest, sourceSha256: receipt.sourceSha,
        ...(receipt.candidateSha ? { transformedSha256: receipt.candidateSha } : {}) },
      preloadSha256: receipt.preloadDigest, compilationObservation: receipt }) + "\n";
    if (Buffer.byteLength(body) > 8192) return false;
    staging = `${path}.${randomUUID()}.tmp`;
    fd = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, body); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(staging, path); staging = undefined;
    dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW); fsyncSync(dir);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    if (dir !== undefined) try { closeSync(dir); } catch {}
    if (staging) try { unlinkSync(staging); } catch {}
  }
}
