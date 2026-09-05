import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type LockHandle = { path: string; release: () => Promise<void> };

export async function acquireExclusiveLock(lockPath: string): Promise<{ ok: true; lock: LockHandle } | { ok: false; code: "lock-conflict" }> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}\n`);
    await handle.close();
    return {
      ok: true,
      lock: {
        path: lockPath,
        release: async () => {
          try {
            await unlink(lockPath);
          } catch {
            /* ignore */
          }
        },
      },
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return { ok: false, code: "lock-conflict" };
    }
    throw error;
  }
}

export function operationLockPath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "ops", "identity.lock");
}
