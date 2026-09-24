import { constants } from "node:fs";
import { lstat, open, readFile, unlink, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConfigError, isObject } from "@grokbox/runtime-kernel/config";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { assertSafeDirectory, readConfigSource } from "./config-layout.node.ts";

export type ConfigLeaseOwner = { schemaVersion: 1; pid: number; uid: number; start: string | null; nonce: string };
export type ConfigLease = { path: string; owner: ConfigLeaseOwner; release: () => Promise<void> };
type ProcessIdentity = { state: "present"; uid: number; start: string | null } | { state: "absent" | "unknown" };

async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  if (process.platform === "linux") {
    try {
      const info = await lstat(`/proc/${pid}`);
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const start = fields[19];
      if (end < 0 || !start || !/^\d+$/.test(start)) return { state: "unknown" };
      return { state: "present", uid: info.uid, start };
    } catch (error) {
      return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "") ? { state: "absent" } : { state: "unknown" };
    }
  }
  // Other POSIX clients may prove absence, but never infer PID reuse from age.
  try { process.kill(pid, 0); return { state: "present", uid: typeof process.getuid === "function" ? process.getuid() : -1, start: null }; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "absent" } : { state: "unknown" }; }
}
function parseOwner(value: unknown): ConfigLeaseOwner | null {
  if (!isObject(value) || Object.keys(value).some((key) => !["schemaVersion", "pid", "uid", "start", "nonce"].includes(key)) || value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !Number.isSafeInteger(value.uid) || Number(value.uid) < 0 ||
    !(value.start === null || typeof value.start === "string" && /^\d+$/.test(value.start)) || typeof value.nonce !== "string" || !/^[0-9a-f-]{36}$/.test(value.nonce)) return null;
  return value as ConfigLeaseOwner;
}
async function stale(owner: ConfigLeaseOwner): Promise<boolean> {
  if (typeof process.getuid !== "function" || owner.uid !== process.getuid()) return false;
  const live = await processIdentity(owner.pid);
  if (live.state === "absent") return true;
  return live.state === "present" && owner.start !== null && live.start !== null && (live.start !== owner.start || live.uid !== owner.uid);
}
async function createLease(path: string): Promise<ConfigLease | null> {
  const self = await processIdentity(process.pid);
  if (self.state !== "present" || typeof process.getuid !== "function") throw new ConfigError("config_scope_unavailable", "Configuration lock process identity is unavailable.");
  const temporary = join(dirname(path), `.config-claim-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const owner: ConfigLeaseOwner = { schemaVersion: 1, pid: process.pid, uid: process.getuid(), start: self.start, nonce: randomUUID() };
  const identity = await handle.stat();
  let claimed = false;
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`); await handle.sync();
    try { await link(temporary, path); claimed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await handle.close(); await unlink(temporary); }
  if (!claimed) return null;
  return { path, owner, release: async () => {
    let current;
    try { current = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (current.dev !== identity.dev || current.ino !== identity.ino) throw new ConfigError("config_commit_unknown", "Configuration lease identity changed before release.");
    await unlink(path);
  } };
}

/** Stale recovery is explicit. A nonce-scoped recovery lease serializes competing
 * reclaimers. Its own crash uses the same protocol at a bounded extra depth;
 * ordinary writers can win the new lease but are never unlinked by a reclaimer. */
async function acquire(path: string, recover: boolean, depth = 0): Promise<ConfigLease> {
  const created = await createLease(path); if (created) return created;
  if (!recover || depth >= 8) throw new ConfigError("config_conflict", "Configuration writer is busy or needs explicit verified lock recovery.");
  const original = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new ConfigError("config_conflict", "Configuration lock changed before recovery inspection; retry the original operation.");
    throw error;
  });
  const source = await readConfigSource(path).catch(() => undefined);
  const owner = source ? parseOwner(source.value) : null;
  if (!owner || original.isSymbolicLink() || !await stale(owner)) throw new ConfigError("config_conflict", "Configuration lock owner is live or unproven; it was not removed.");
  const guardPath = join(dirname(path), `.config-reclaim-${sha256Text(`${path}:${owner.nonce}`).slice(0, 32)}.lock`);
  const guard = await acquire(guardPath, true, depth + 1);
  try {
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (current) {
      if (current.dev !== original.dev || current.ino !== original.ino) throw new ConfigError("config_conflict", "Another writer replaced the stale lock; no lock was removed.");
      const reread = await readConfigSource(path);
      if (reread?.sha256 !== source?.sha256 || !await stale(owner)) throw new ConfigError("config_conflict", "Lock identity changed during recovery.");
      await unlink(path);
    }
    const next = await createLease(path);
    if (!next) throw new ConfigError("config_conflict", "Another configuration writer acquired the recovered lock.");
    return next;
  } finally { await guard.release(); }
}

export async function acquireConfigurationLease(root: string, recover = false, owner: "config-write" | "config-bootstrap" | "models-write" | "model-operations" = "config-write"): Promise<ConfigLease> {
  await assertSafeDirectory(join(root, "state"), true);
  return await acquire(join(root, "state", `${owner}.lock`), recover);
}

export { processIdentity as configurationProcessIdentity };

export async function inspectConfigurationLease(root: string) {
  const path = join(root, "state", "config-write.lock");
  const source = await readConfigSource(path, true).catch(() => null);
  if (source === undefined) return { state: "absent" as const };
  const owner = source ? parseOwner(source.value) : null;
  if (!owner) return { state: "unproven" as const, recoverable: false };
  const recoverable = await stale(owner);
  return { state: recoverable ? "stale" as const : "live-or-unproven" as const, pid: owner.pid, recoverable };
}
