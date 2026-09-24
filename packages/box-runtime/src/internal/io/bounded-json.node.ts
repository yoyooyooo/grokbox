import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";

export { readBoundedJsonSync } from "../host/bounded-json.node.ts";

export async function readBoundedJson(path: string): Promise<unknown | undefined> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > CONFIG_READ_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(CONFIG_READ_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > CONFIG_READ_MAX_BYTES || length !== info.size) return undefined;
    // Return one observed file, not a valid JSON prefix or bytes from an input
    // that changed during reading. This is not a lock against future writes.
    for (const current of [await file.stat(), await lstat(path)]) {
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino
        || current.size !== info.size || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs) return undefined;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } catch {
    return undefined;
  } finally {
    if (file) await file.close().catch(() => undefined);
  }
}
