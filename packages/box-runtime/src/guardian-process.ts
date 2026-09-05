import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessIdentity } from "./process.ts";

const CHILD = fileURLToPath(new URL("./guardian-child.cjs", import.meta.url));

export type IndependentGuardian = {
  pid: number;
  release: () => void;
  /** test helper: kill this injector-side pipe owner only */
  crashInjectorPipe: () => void;
};

export function spawnIndependentGuardian(input: {
  frozen: ProcessIdentity[];
  deadlineMs: number;
  stateDir: string;
  execPath?: string;
}): IndependentGuardian {
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const identityPath = join(input.stateDir, `guardian-${process.pid}.json`);
  writeFileSync(
    identityPath,
    `${JSON.stringify({ frozen: input.frozen, deadlineMs: input.deadlineMs })}\n`,
    { mode: 0o600 },
  );
  const child: ChildProcess = spawn(input.execPath ?? process.execPath, [CHILD, identityPath], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  if (child.pid == null) throw new Error("guardian-spawn-failed");
  child.unref();
  const release = () => {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  };
  return {
    pid: child.pid,
    release,
    crashInjectorPipe: () => {
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}
