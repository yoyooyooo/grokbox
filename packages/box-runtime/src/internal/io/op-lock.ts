import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LockHandle = { path: string; release: () => Promise<void> };

export type LeaseOwner = { pid: number; start: number; uid: number };

function lockHandle(path: string, dev: number, ino: number): LockHandle {
  return {
    path,
    release: async () => {
      try {
        const st = await lstat(path);
        if (st.dev !== dev || st.ino !== ino) return;
        await unlink(path);
      } catch {
        /* ignore missing or foreign path */
      }
    },
  };
}

async function ownCreated(path: string, handle: FileHandle): Promise<LockHandle> {
  try {
    const st = await handle.stat();
    return lockHandle(path, st.dev, st.ino);
  } finally {
    await handle.close();
  }
}

export async function acquireExclusiveLock(lockPath: string): Promise<{ ok: true; lock: LockHandle } | { ok: false; code: "lock-conflict" }> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`);
    return { ok: true, lock: await ownCreated(lockPath, handle) };
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
  const create = async (): Promise<LockHandle | null> => {
    try {
      const handle = await open(input.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify(input.self)}\n`);
      return await ownCreated(input.path, handle);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return null;
      throw error;
    }
  };
  const first = await create();
  if (first) return { ok: true, lock: first };
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
  const retry = await create();
  if (retry) return { ok: true, lock: retry };
  return { ok: false, code: "lock-conflict" };
}

export function operationLockPath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "ops", "identity.lock");
}

export function coordinatorLeasePath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "ops", "coordinator.lock");
}
