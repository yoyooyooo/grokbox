import { constants } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LockHandle = { path: string; release: () => Promise<void> };

export type LeaseOwner = { pid: number; start: number; uid: number };

function lockHandle(path: string): LockHandle {
  return {
    path,
    release: async () => {
      try {
        await unlink(path);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function acquireExclusiveLock(lockPath: string): Promise<{ ok: true; lock: LockHandle } | { ok: false; code: "lock-conflict" }> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return { ok: true, lock: lockHandle(lockPath) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return { ok: false, code: "lock-conflict" };
    }
    throw error;
  }
}

export async function acquireCoordinatorLease(input: {
  path: string;
  self: LeaseOwner;
  inspect: (pid: number) => LeaseOwner | null;
}): Promise<{ ok: true; lock: LockHandle } | { ok: false; code: "lock-conflict" }> {
  await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
  const create = async (): Promise<boolean> => {
    try {
      const handle = await open(input.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify(input.self)}\n`);
      await handle.close();
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      throw error;
    }
  };
  if (await create()) return { ok: true, lock: lockHandle(input.path) };
  let recorded: LeaseOwner | null = null;
  try {
    const parsed = JSON.parse(await readFile(input.path, "utf8")) as Partial<LeaseOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.start === "number" &&
      typeof parsed.uid === "number"
    ) {
      recorded = { pid: parsed.pid, start: parsed.start, uid: parsed.uid };
    }
  } catch {
    return { ok: false, code: "lock-conflict" };
  }
  if (!recorded) return { ok: false, code: "lock-conflict" };
  const live = input.inspect(recorded.pid);
  const stale = live == null || live.start !== recorded.start || live.uid !== recorded.uid;
  if (!stale) return { ok: false, code: "lock-conflict" };
  try {
    await unlink(input.path);
  } catch {
    return { ok: false, code: "lock-conflict" };
  }
  if (await create()) return { ok: true, lock: lockHandle(input.path) };
  return { ok: false, code: "lock-conflict" };
}

export function operationLockPath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "ops", "identity.lock");
}

export function coordinatorLeasePath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "ops", "coordinator.lock");
}
