import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

/** Cooperative journal lock v2: atomically publish a nonempty directory whose
 * unique owner name cannot recur in a replacement acquisition. Recovery unlinks
 * that exact name, then rmdir (never recursive deletion). A concurrent new owner
 * makes rmdir fail with ENOTEMPTY instead of deleting its lock. Legacy PID-only
 * files remain a conservative blocker; elapsed time is never ownership proof. */
const MAX_PREPARED = 64, MAX_OWNER_BYTES = 512;
type Owner = { schemaVersion: 2; pid: number; uid: number; start: string | null; token: string };
type Identity = { state: "present"; uid: number; start: string } | { state: "missing" | "unavailable" };
const code = (e: unknown) => e && typeof e === "object" && "code" in e ? e.code : undefined;
const disappeared = (e: unknown) => code(e) === "ENOENT";
const busy = () => Object.assign(new Error("box-runtime events journal lock timeout"), { code: "LOCK_TIMEOUT" });
const ownerFile = (owner: Owner) => `owner-${owner.token}.json`;
const sameInode = (a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }) => a.dev === b.dev && a.ino === b.ino;
const privateOwned = (s: { mode: number | bigint; uid: number | bigint }) => (Number(s.mode) & 0o077) === 0 && (!process.getuid || Number(s.uid) === process.getuid());
async function identity(pid: number): Promise<Identity> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return { state: "unavailable" };
  try {
    const info = await lstat(`/proc/${pid}`), text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!/^\d+$/.test(fields[19] ?? "") || !boot) return { state: "unavailable" };
    return { state: "present", uid: info.uid, start: sha256Text(`${boot}:${fields[19]}`) };
  } catch (error) { return { state: disappeared(error) ? "missing" : "unavailable" }; }
}
let selfIdentity: Promise<Identity> | undefined;
function self() { return selfIdentity ??= identity(process.pid); }
function parse(value: unknown): Owner | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 2 || !Number.isSafeInteger(v.pid) || Number(v.pid) < 1 || !Number.isSafeInteger(v.uid)
    || !(v.start === null || typeof v.start === "string" && /^[a-f0-9]{64}$/.test(v.start))
    || typeof v.token !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.token)) return null;
  return v as Owner;
}
async function inspect(directory: string) {
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || !privateOwned(dir)) return null;
  const listing = await opendir(directory);
  let name: string | undefined;
  try {
    name = (await listing.read())?.name;
    if (!name || await listing.read() !== null || !/^owner-[a-f0-9-]{36}\.json$/.test(name)) return null;
  } finally { await listing.close(); }
  const path = join(directory, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.nlink !== 1 || file.size > MAX_OWNER_BYTES || !privateOwned(file)) return null;
    const buffer = Buffer.alloc(MAX_OWNER_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const chunk = await handle.read(buffer, used, buffer.length - used, used);
      if (!chunk.bytesRead) break;
      used += chunk.bytesRead;
    }
    if (used !== file.size || used > MAX_OWNER_BYTES) return null;
    const owner = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used))));
    if (!owner || name !== ownerFile(owner) || process.getuid && owner.uid !== process.getuid()) return null;
    return { owner, dir, file, path };
  } finally { await handle.close(); }
}
async function removeExact(directory: string, token: string, expectedDirectory: { dev: number | bigint; ino: number | bigint }) {
  const current = await inspect(directory).catch(() => null);
  if (!current || current.owner.token !== token || !sameInode(current.dir, expectedDirectory)) return false;
  const dir = await lstat(directory), file = await lstat(current.path);
  if (!sameInode(dir, current.dir) || dir.isSymbolicLink() || !sameInode(file, current.file)
    || file.isSymbolicLink() || file.nlink !== 1 || file.size !== current.file.size) return false;
  // Only the winner can remove this acquisition's unrepeatable file name.
  // A renamed/replaced directory has a different token, so unlink fails safely.
  await unlink(current.path);
  try { await rmdir(directory); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(code(error)))) throw error; }
  return true;
}
async function recoverDead(directory: string) {
  const observed = await inspect(directory).catch(() => null);
  if (!observed) return false;
  const live = await identity(observed.owner.pid);
  const dead = live.state === "missing" || live.state === "present" && observed.owner.start !== null
    && (live.start !== observed.owner.start || live.uid !== observed.owner.uid);
  if (!dead) return false;
  return removeExact(directory, observed.owner.token, observed.dir).catch(() => false);
}
async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Prepared directory slots are finite. A crash before a valid owner record is
 * published leaves a bounded unusable slot, not an ever-growing orphan file
 * namespace or permission to infer a missing process identity. */
export async function withJournalLock<T>(path: string, fn: () => Promise<T>, maxAttempts: number): Promise<T> {
  const parent = dirname(path), ownIdentity = await self();
  const owner: Owner = { schemaVersion: 2, pid: process.pid, uid: process.getuid?.() ?? -1,
    start: ownIdentity.state === "present" ? ownIdentity.start : null, token: randomUUID() };
  let prepared: string | undefined, preparedInode: Awaited<ReturnType<typeof lstat>> | undefined;
  let acquired = false;
  try {
    for (let slot = 0; slot < MAX_PREPARED; slot++) {
      const candidate = join(parent, `events.prepare-${slot}`);
      try { await mkdir(candidate, { mode: 0o700 }); prepared = candidate; break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        if (await recoverDead(candidate)) {
          try { await mkdir(candidate, { mode: 0o700 }); prepared = candidate; break; }
          catch (e) { if (code(e) !== "EEXIST") throw e; }
        }
      }
    }
    if (!prepared) throw busy();
    preparedInode = await lstat(prepared);
    const handle = await open(join(prepared, ownerFile(owner)), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(prepared);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const occupied = await lstat(path).then(() => true, error => { if (disappeared(error)) return false; throw error; });
      // Do not replace an unknown empty directory merely because rename could.
      // A protocol release racing here is observed again on the next attempt.
      if (!occupied || await recoverDead(path)) {
        const stillOccupied = await lstat(path).then(() => true, error => { if (disappeared(error)) return false; throw error; });
        if (!stillOccupied) {
          try { await rename(prepared, path); acquired = true; }
          catch (error) { if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(String(code(error)))) throw error; }
        }
      }
      if (acquired) {
        await syncDirectory(parent);
        // Callback errors, including EEXIST, are never acquisition retries.
        return await fn();
      }
      if (attempt + 1 < maxAttempts) await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
    throw busy();
  } finally {
    if (prepared && preparedInode) {
      const removed = await removeExact(acquired ? path : prepared, owner.token, preparedInode).catch(() => false);
      if (removed) await syncDirectory(parent).catch(() => undefined);
    }
  }
}

/** Finite, read-only metadata inventory. Does not expose PID/start/token or
 * recursively inspect unknown objects. A malformed/legacy object is visible,
 * not a reason to delete it or report zero disk use. */
export async function observeJournalLockStorage(root: string) {
  const directory = join(root, "log");
  let fileBytes = 0, allocatedBytes = 0, preparedSlots = 0, unqualifiedSlots = 0;
  let lockState = "absent", ownerState = "not_checked";
  try {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !privateOwned(parent)) throw new Error("unsafe");
    for (const name of ["events.lock", ...Array.from({ length: MAX_PREPARED }, (_, slot) => `events.prepare-${slot}`)]) {
      const path = join(directory, name);
      const entry = await lstat(path).catch(error => { if (disappeared(error)) return null; throw error; });
      if (!entry) continue;
      if (name !== "events.lock") preparedSlots++;
      allocatedBytes += Math.max(0, Number(entry.blocks ?? 0) * 512);
      const observed = await inspect(path).catch(() => null);
      if (!observed) {
        if (entry.isFile() && !entry.isSymbolicLink()) fileBytes += entry.size;
        unqualifiedSlots++;
        if (name === "events.lock") lockState = entry.isFile() ? "legacy-file-unqualified" : "unqualified";
        continue;
      }
      fileBytes += observed.file.size; allocatedBytes += Math.max(0, Number(observed.file.blocks ?? 0) * 512);
      if (name === "events.lock") {
        lockState = "directory-v2";
        const current = await identity(observed.owner.pid);
        ownerState = current.state === "missing" ? "process-absent" : current.state !== "present" || observed.owner.start === null ? "unavailable"
          : current.start === observed.owner.start && current.uid === observed.owner.uid ? "live" : "identity-changed";
      }
    }
    return { state: unqualifiedSlots ? "partial" : "available", fileBytes, allocatedBytes, preparedSlots, maxPreparedSlots: MAX_PREPARED,
      unqualifiedSlots, lockState, ownerState, accountingComplete: unqualifiedSlots === 0, sampling: "non_atomic_read_only" };
  } catch (error) {
    return { state: disappeared(error) ? "missing" : "unavailable", fileBytes, allocatedBytes, preparedSlots, maxPreparedSlots: MAX_PREPARED,
      unqualifiedSlots, lockState, ownerState, accountingComplete: false, sampling: "non_atomic_read_only" };
  }
}
