import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { acquireAdvisoryGate, type AdvisoryGate } from "./advisory-gate.node.ts";

export type OperationLeaseOwner = { version: 1; pid: number; start: string; uid: number; bootId: string; nonce: string; operationId?: string };
export type OperationLeaseObservation = {
  state: "missing" | "stale" | "live" | "unproven" | "invalid" | "unavailable";
  recoverable: boolean;
  pid?: number;
  format?: "identity-v1";
};
export type OperationLeaseSnapshot = { path: string; observation: OperationLeaseObservation; owner?: OperationLeaseOwner; info?: Stats; sha?: string };
export type OperationLock = { path: string; owner: OperationLeaseOwner; release: () => Promise<void> };
export const operationLockPath = (ephemeralRoot: string): string => join(ephemeralRoot, "ops", "identity.lock");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function parseOperationLeaseOwner(value: unknown): OperationLeaseOwner | null {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = ["version", "pid", "start", "uid", "bootId", "nonce"], ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string" || ![...keys, "operationId"].includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) return null;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1
    || !natural(row.pid) || row.pid === 0 || !natural(row.uid) || typeof row.start !== "string" || !/^\d{1,24}$/.test(row.start)
    || !uuid(row.bootId) || !uuid(row.nonce) || row.operationId !== undefined && !safeId(row.operationId)) return null;
  return structuredClone(row) as OperationLeaseOwner;
}

async function bootId(): Promise<string | null> {
  try { const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); return uuid(value) ? value : null; }
  catch { return null; }
}
async function processIdentity(pid: number): Promise<{ state: "present"; uid: number; start: string } | { state: "absent" | "unknown" }> {
  if (process.platform !== "linux" || !natural(pid) || pid === 0) return { state: "unknown" };
  try {
    process.kill(pid, 0);
    const info = await lstat(`/proc/${pid}`);
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = text.lastIndexOf(")"), fields = text.slice(end + 2).trim().split(/\s+/);
    const start = fields[19];
    if (end < 0 || !start || !/^\d{1,24}$/.test(start)) return { state: "unknown" };
    // Exited/zombie tasks cannot retain userspace file descriptors or execute work.
    if (fields[0] === "Z" || fields[0] === "X") return { state: "absent" };
    return { state: "present", uid: info.uid, start };
  } catch (error) { return { state: ["ESRCH", "ENOENT"].includes(code(error)) ? "absent" : "unknown" }; }
}

export async function operationOwnerState(value: OperationLeaseOwner): Promise<"stale" | "live" | "unproven"> {
  const owner = parseOperationLeaseOwner(value);
  if (!owner || owner.uid !== process.getuid?.()) return "unproven";
  const boot = await bootId();
  if (!boot) return "unproven";
  if (boot !== owner.bootId) return "stale";
  const observed = await processIdentity(owner.pid);
  if (observed.state === "absent") return "stale";
  if (observed.state !== "present") return "unproven";
  return observed.uid !== owner.uid || observed.start !== owner.start ? "stale" : "live";
}

async function ownerBytes(path: string): Promise<{ info: Stats; bytes: Buffer } | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (code(error) === "ENOENT") return null; throw error; }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 4096) throw new Error("operation_record_invalid");
    const buffer = Buffer.alloc(4097);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), pathInfo = await lstat(path);
    if (read.bytesRead !== info.size || !same(info, after) || !same(info, pathInfo) || pathInfo.isSymbolicLink()) throw new Error("operation_record_changed");
    return { info, bytes: buffer.subarray(0, read.bytesRead) };
  } finally { await handle.close(); }
}

/** Observation never mkdirs, opens an advisory gate, deletes or repairs. */
export async function inspectOperationLease(path: string): Promise<OperationLeaseSnapshot> {
  try {
    const source = await ownerBytes(path);
    if (!source) return { path, observation: { state: "missing", recoverable: false } };
    const text = source.bytes.toString("utf8").trim();
    let owner: OperationLeaseOwner | null = null;
    try { owner = parseOperationLeaseOwner(JSON.parse(text)); } catch { /* Unknown formats remain untouched. */ }
    if (!owner) return { path, observation: { state: "invalid", recoverable: false } };
    const state = await operationOwnerState(owner);
    return { path, owner, info: source.info, sha: sha256Bytes(source.bytes),
      observation: { state, recoverable: state === "stale", pid: owner.pid, format: "identity-v1" } };
  } catch (error) {
    return { path, observation: { state: ["EACCES", "EPERM"].includes(code(error)) ? "unavailable" : "invalid", recoverable: false } };
  }
}

/** Metadata is published fully before linking into the exclusive owner pathname;
 * the advisory descriptor remains held for the entire operation lifetime. */
export async function acquireOperationLease(path: string, operationId?: string): Promise<{ ok: true; lock: OperationLock } | { ok: false; code: "lock-conflict" }> {
  if (operationId !== undefined && !safeId(operationId)) throw new Error("operation_id_invalid");
  const gate = await acquireAdvisoryGate(`${path}.gate`);
  if (!gate) return { ok: false, code: "lock-conflict" };
  let owned = false, handedOff = false;
  let identity: Stats | undefined;
  try {
    const observed = await inspectOperationLease(path);
    if (observed.observation.state !== "missing") return { ok: false, code: "lock-conflict" };
    const self = await processIdentity(process.pid), boot = await bootId();
    if (self.state !== "present" || !boot || self.uid !== process.getuid?.()) throw new Error("operation_identity_unavailable");
    const owner: OperationLeaseOwner = { version: 1, pid: process.pid, start: self.start, uid: self.uid, bootId: boot, nonce: randomUUID(), ...(operationId ? { operationId } : {}) };
    const temporary = join(dirname(path), `.operation-claim-${owner.nonce}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let info: Stats;
    try {
      await file.writeFile(`${JSON.stringify(owner)}\n`); await file.sync(); info = await file.stat(); identity = info;
      try { await link(temporary, path); owned = true; }
      catch (error) { if (code(error) !== "EEXIST") throw error; }
    } finally { await file.close(); await unlink(temporary); }
    if (!owned) return { ok: false, code: "lock-conflict" };
    let released = false;
    handedOff = true;
    return { ok: true, lock: { path, owner, release: async () => {
      if (released) return; released = true;
      try {
        const current = await lstat(path).catch(error => { if (code(error) === "ENOENT") return null; throw error; });
        if (current && current.dev === info.dev && current.ino === info.ino && !current.isSymbolicLink()) await unlink(path);
      } finally { await gate.release(); }
    } } };
  } finally {
    if (!handedOff) {
      try {
        if (owned && identity) {
          const current = await lstat(path).catch(() => null);
          if (current && current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink()) await unlink(path);
        }
      } finally { await gate.release(); }
    }
  }
}

/** Verify every selected record before the root changes its operation store. */
export async function recheckOperationLease(snapshot: OperationLeaseSnapshot): Promise<void> {
  const current = await inspectOperationLease(snapshot.path);
  if (snapshot.observation.state === "missing") {
    if (current.observation.state !== "missing") throw new Error("operation_recovery_conflict");
    return;
  }
  if (snapshot.observation.state !== "stale" || current.observation.state !== "stale" || !snapshot.info || !current.info
    || !same(snapshot.info, current.info) || snapshot.sha !== current.sha) throw new Error("operation_recovery_conflict");
}
export async function removeRecoveredOperationLease(snapshot: OperationLeaseSnapshot): Promise<void> {
  await recheckOperationLease(snapshot);
  if (snapshot.observation.state === "stale") await unlink(snapshot.path);
}

/** Acquire in caller-defined canonical order; release in reverse order. */
export async function acquireOperationRecoveryGates(paths: readonly string[]): Promise<AdvisoryGate | null> {
  const held: AdvisoryGate[] = [];
  const release = async () => {
    const results = await Promise.allSettled([...held].reverse().map(gate => gate.release()));
    if (results.some(result => result.status === "rejected")) throw new Error("operation_gate_release_failed");
  };
  try {
    for (const path of paths) {
      const gate = await acquireAdvisoryGate(`${path}.gate`);
      if (!gate) { await release(); return null; }
      held.push(gate);
    }
    return { release };
  } catch (error) { await release(); throw error; }
}
