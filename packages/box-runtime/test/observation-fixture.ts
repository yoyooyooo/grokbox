import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

/** No writes; access times are OS read effects, not mutation by the observed command. */
export async function snapshotTree(root: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  async function visit(path: string, key: string): Promise<void> {
    let info;
    try { info = await lstat(path); }
    catch { result[key] = "missing"; return; }
    result[key] = { mode: info.mode, mtime: info.mtimeMs, ...(info.isSymbolicLink() ? { link: await readlink(path) } : {}) };
    if (info.isFile()) result[key] = { ...result[key] as object, hash: sha256Text(await readFile(path, "utf8")) };
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${key}/${name}`);
  }
  await visit(root, ".");
  return result;
}
