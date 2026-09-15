import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";

/** Missing, oversize, symlink, or invalid JSON → undefined. Never follows links. */
export function readBoundedJsonSync(path: string): unknown | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > CONFIG_READ_MAX_BYTES) return undefined;
    return JSON.parse(bytes.subarray(0, n).toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

export async function readBoundedJson(path: string): Promise<unknown | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > CONFIG_READ_MAX_BYTES) return undefined;
    return JSON.parse(bytes.subarray(0, read.bytesRead).toString("utf8")) as unknown;
  } catch {
    return undefined;
  } finally {
    if (file) await file.close().catch(() => undefined);
  }
}
