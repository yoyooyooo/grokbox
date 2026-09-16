import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";

/** Host's existing bounded model-selection read. No IO/Effect root import. */
export function readBoundedJsonSync(path: string): unknown | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > CONFIG_READ_MAX_BYTES) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, n))) as unknown;
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* read-only observation */ } }
}
