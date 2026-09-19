import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { acquireAdvisoryGate, type AdvisoryGate } from "./advisory-gate.node.ts";
import { monitorProcessIdentity } from "./monitor-owner.node.ts";
import { readConfigFile } from "./config-layout.node.ts";
import { sha256Text } from "@grokbox/runtime-kernel/hash";

type SocketIdentity = { dev: number; ino: number };
type Owner = { schemaVersion: 1; socketId: string; generation: string; pid: number; start: string;
  socket: SocketIdentity; state: "listening" | "stopped" };
const absent = (e: unknown) => e && typeof e === "object" && "code" in e && e.code === "ENOENT";
const fail = (reason: string): never => {
  throw Object.assign(new Error(`daemon_socket_${reason}`), reason === "busy" ? { code: "EADDRINUSE" } : {});
};
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const same = (a: SocketIdentity, b: SocketIdentity) => a.dev === b.dev && a.ino === b.ino;
function owner(value: unknown, socketId: string): Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("owner_unqualified");
  const v = value as Owner;
  if (v.schemaVersion !== 1 || v.socketId !== socketId || !digest(v.start) || typeof v.generation !== "string"
    || !/^[a-f0-9-]{36}$/.test(v.generation) || !Number.isSafeInteger(v.pid) || v.pid < 1
    || !["listening", "stopped"].includes(v.state) || !v.socket || !Number.isSafeInteger(v.socket.dev) || !Number.isSafeInteger(v.socket.ino)
    || Object.keys(v).some(k => !["schemaVersion", "socketId", "generation", "pid", "start", "socket", "state"].includes(k))) return fail("owner_unqualified");
  return v;
}
async function inspectSocket(path: string): Promise<SocketIdentity | null> {
  const st = await lstat(path).catch(e => { if (absent(e)) return null; throw e; });
  if (!st) return null;
  if (!st.isSocket() || st.isSymbolicLink() || st.uid !== process.getuid?.() || st.nlink !== 1) return fail("path_unqualified");
  return { dev: st.dev, ino: st.ino };
}
async function publishOwner(path: string, value: Owner) {
  const temporary = `${path}.next`;
  const previous = await lstat(temporary).catch(e => { if (absent(e)) return null; throw e; });
  if (previous) {
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1 || previous.size > 4096
      || previous.uid !== process.getuid?.() || (previous.mode & 0o077) !== 0) return fail("staging_unqualified");
    owner(await readConfigFile(temporary), value.socketId);
    const current = await lstat(temporary);
    if (!same(previous, current)) return fail("staging_changed");
    await unlink(temporary);
  }
  const bytes = Buffer.from(JSON.stringify(value) + "\n"); if (bytes.length > 4096) return fail("owner_capacity");
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function refusesConnections(path: string): Promise<boolean> {
  return new Promise(resolveResult => {
    let refused = false;
    const socket = createConnection({ path });
    const timer = setTimeout(() => socket.destroy(), 500);
    socket.once("connect", () => socket.destroy());
    socket.once("error", (e: NodeJS.ErrnoException) => { refused = e.code === "ECONNREFUSED"; socket.destroy(); });
    socket.once("close", () => { clearTimeout(timer); resolveResult(refused); });
  });
}

export type DaemonSocketLease = { recordBound: () => Promise<void>; release: () => Promise<void> };
/** Existing Linux advisory descriptor gate owns socket recovery and listener
 * lifetime. Only a registered exact inode with a proven-dead owner and refused
 * connection is reclaimable. A legacy socket, timeout, or PID alone is not that
 * proof. No process is signalled, and the permanent gate inode is never deleted.
 * Other platforms preserve exclusive bind behavior without claiming recovery. */
export async function acquireServiceSocket(path: string, generation: string): Promise<DaemonSocketLease> {
  if (!isAbsolute(path) || path.includes("\0") || !/^[a-f0-9-]{36}$/.test(generation)) return fail("invalid_input");
  const parent = dirname(path), socketId = sha256Text(resolve(path)), ownerPath = `${path}.owner.json`;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await lstat(parent);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) return fail("directory_unqualified");
  let gate: AdvisoryGate | null | undefined;
  let bound: SocketIdentity | null = null, self: Owner | undefined, released = false;
  try {
    if (process.platform === "linux") {
      gate = await acquireAdvisoryGate(`${path}.gate`);
      if (!gate) return fail("busy");
    }
    const existing = await inspectSocket(path);
    let prior: Owner | undefined;
    if (gate) {
      const info = await lstat(ownerPath).catch(e => { if (absent(e)) return null; throw e; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) return fail("owner_unqualified");
      const value = await readConfigFile(ownerPath, true);
      if (value !== undefined) prior = owner(value, socketId);
    }
    if (existing) {
      if (!gate || !prior || !same(existing, prior.socket)) return fail("orphan_unqualified");
      const current = await monitorProcessIdentity(prior.pid);
      const dead = current.state === "missing" || current.state === "present" && current.start !== prior.start;
      if (!dead || !await refusesConnections(path)) return fail("owner_not_dead");
      const again = await inspectSocket(path);
      if (!again || !same(again, existing)) return fail("identity_changed");
      await unlink(path);
    }
    return {
      recordBound: async () => {
        if (released) return fail("lease_released");
        bound = await inspectSocket(path); if (!bound) return fail("binding_missing");
        if (gate) {
          const identity = await monitorProcessIdentity(process.pid);
          if (identity.state !== "present") return fail("self_unavailable");
          self = { schemaVersion: 1, socketId, generation, pid: process.pid, start: identity.start, socket: bound, state: "listening" };
          await publishOwner(ownerPath, self);
        }
      },
      release: async () => {
        if (released) return; released = true;
        try {
          if (bound) {
            const current = await inspectSocket(path);
            if (current && !same(current, bound)) return fail("identity_changed");
            if (current) await unlink(path);
          }
          if (self) await publishOwner(ownerPath, { ...self, state: "stopped" });
        } finally { await gate?.release(); }
      },
    };
  } catch (e) { await gate?.release(); throw e; }
}
/** Backwards-compatible daemon entry; modeld uses the same exact-inode owner. */
export const acquireDaemonSocket = acquireServiceSocket;
