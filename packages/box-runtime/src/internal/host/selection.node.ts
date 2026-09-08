import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { parseModelsFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { OBSERVATION_MAX_BYTES } from "../io/observation.node.ts";
import { modelsPath } from "../io/paths.ts";

/** Bounded no-follow nonblocking regular-file read for preload/hook. Never mkdir or repair. */
export function loadModelsFileSync(root: string): ModelsFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(modelsPath(root), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > OBSERVATION_MAX_BYTES) return null;
    const bytes = Buffer.alloc(OBSERVATION_MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > OBSERVATION_MAX_BYTES) return null;
    return parseModelsFile(JSON.parse(bytes.subarray(0, n).toString("utf8")));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}
