import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { CONFIG_READ_MAX_BYTES } from "@grokbox/runtime-kernel/contract";

export { readBoundedJsonSync } from "../host/bounded-json.node.ts";

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
