import { constants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { acquireExclusiveLock, type LockHandle } from "./op-lock.ts";

export async function monitorProcessIdentity(pid: number): Promise<{ state: "present"; start: string } | { state: "missing" | "unavailable" }> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return { state: "unavailable" };
  let text: string;
  try { text = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (e) { return e && typeof e === "object" && "code" in e && e.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" }; }
  try {
    const boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (!/^\d+$/.test(fields[19] ?? "") || !boot.trim()) return { state: "unavailable" };
    return { state: "present", start: sha256Text(`${boot.trim()}:${fields[19]}`) };
  } catch { return { state: "unavailable" }; }
}

/** Only call while holding the canonical SQLite BEGIN IMMEDIATE transaction.
 * That serializes new recoverers; the legacy file lock fences old image writers.
 * A PID-only legacy lock is recoverable only if that PID is demonstrably absent,
 * never merely old, inaccessible, unresponsive or reused by a live process. */
export async function acquireMonitorMigrationLock(path: string): Promise<LockHandle | null> {
  const first = await acquireExclusiveLock(path);
  if (first.ok) return first.lock;
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) return null;
    const body = await handle.readFile("utf8");
    if (!/^[1-9][0-9]{0,9}\n?$/.test(body)) return null;
    if ((await monitorProcessIdentity(Number(body.trim()))).state !== "missing") return null;
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) return null;
    await unlink(path);
  } catch { return null; }
  finally { await handle?.close(); }
  const next = await acquireExclusiveLock(path);
  return next.ok ? next.lock : null;
}
