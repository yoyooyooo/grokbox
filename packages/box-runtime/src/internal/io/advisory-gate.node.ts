import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type AdvisoryGate = { release: () => Promise<void> };

/** Linux open-file-description lock. The permanent gate inode is never unlinked.
 * flock receives an inherited duplicate of our fd and exits; our fd owns the
 * lock until close, including after the child exits. No keeper process survives.
 * This syscall adapter does not recover owner records or signal application processes.
 */
export async function acquireAdvisoryGate(path: string, waitMs: 0 | 2000 = 0): Promise<AdvisoryGate | null> {
  if (process.platform !== "linux" || !isAbsolute(path)) throw new Error("advisory_gate_unavailable");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("advisory_gate_directory_invalid");
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let released = false;
  const release = async () => { if (!released) { released = true; await file.close(); } };
  try {
    const original = await file.stat();
    if (!original.isFile() || original.nlink !== 1 || original.uid !== process.getuid?.() || (original.mode & 0o077) !== 0) {
      throw new Error("advisory_gate_file_invalid");
    }
    const args = waitMs === 0 ? ["-n", "-E", "75", "3"] : ["-w", String(waitMs / 1000), "-E", "75", "3"];
    const status = await new Promise<number | null>(resolve => {
      let failed = false;
      const child = spawn("/usr/bin/flock", args, { stdio: ["ignore", "ignore", "ignore", file.fd],
        timeout: waitMs + 2000, killSignal: "SIGKILL", windowsHide: true });
      child.once("error", () => { failed = true; });
      // Settle only after close: an interrupted child must not acquire the lock
      // later, after a caller was told it failed and released its descriptor.
      child.once("close", code => resolve(failed ? null : code));
    });
    if (status === 75) { await release(); return null; }
    if (status !== 0) throw new Error("advisory_gate_unavailable");
    const current = await lstat(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) {
      throw new Error("advisory_gate_replaced");
    }
    return { release };
  } catch (error) { await release(); throw error; }
}
