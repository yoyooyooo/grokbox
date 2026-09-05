import { lstat, realpath } from "node:fs/promises";
import { CliError } from "../errors.ts";
import type { DaemonProcessConfig } from "./config.ts";

export type VerifiedExecutable = {
  name: string;
  path: string;
  dev: number;
  ino: number;
};

export class ProcessAuthority {
  private constructor(
    readonly policy: DaemonProcessConfig,
    private readonly executables: ReadonlyMap<string, VerifiedExecutable>,
    private readonly shell: VerifiedExecutable | null,
  ) {}

  static async create(policy: DaemonProcessConfig): Promise<ProcessAuthority> {
    if (process.platform !== "linux") {
      throw new CliError("process_forbidden", "Process authority requires Linux process-group identity support.");
    }
    const entries = new Map<string, VerifiedExecutable>();
    for (const executable of policy.executables) {
      entries.set(executable.name, await verifyExecutable(executable.name, executable.path));
    }
    const shell = policy.shell
      ? await verifyExecutable("shell", policy.shell.executable)
      : null;
    return new ProcessAuthority(policy, entries, shell);
  }

  capabilities(): string[] {
    return ["host.process.run", "host.process.manage", ...(this.shell ? ["host.process.shell"] : [])];
  }

  async executable(name: string, shell: boolean): Promise<VerifiedExecutable> {
    const expected = shell ? this.shell : this.executables.get(name);
    if (!expected) throw new CliError("process_forbidden", shell ? "Shell execution is not authorized." : "Executable alias is not authorized.");
    const current = await verifyExecutable(expected.name, expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new CliError("process_forbidden", "Configured executable changed after daemon startup.");
    }
    return current;
  }
}

async function verifyExecutable(name: string, path: string): Promise<VerifiedExecutable> {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!info.isFile() || canonical !== path || (info.mode & 0o111) === 0) {
      throw new CliError("process_forbidden", "Configured executable must be an executable non-symlink file.");
    }
    return { name, path, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("process_forbidden", "Configured executable is unavailable.");
  }
}
