import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";
import { parseModelsFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";

/** Bounded no-follow nonblocking regular-file read for preload/hook. Never mkdir or repair. */
export function loadModelsFileSync(root: string): ModelsFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, "models.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return null;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > CONFIG_READ_MAX_BYTES) return null;
    return parseModelsFile(JSON.parse(bytes.subarray(0, n).toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}
