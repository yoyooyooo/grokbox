import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentity } from "./process.ts";
import {
  resolveRuntimeHelper,
  RUNTIME_HELPER_GUARDIAN_CHILD,
  RUNTIME_HELPER_INJECTOR_HOLD,
} from "./runtime-helpers.ts";

const CHILD = resolveRuntimeHelper(RUNTIME_HELPER_GUARDIAN_CHILD);
const HOLDER = resolveRuntimeHelper(RUNTIME_HELPER_INJECTOR_HOLD);

export type IndependentGuardian = {
  armed: boolean;
  pid: number | null;
  injectorPid: number | null;
  release: () => void;
  killInjector: () => void;
};

export async function spawnIndependentGuardian(input: {
  frozen: ProcessIdentity[];
  deadlineMs: number;
  stateDir: string;
  execPath?: string;
  readyMs?: number;
}): Promise<IndependentGuardian> {
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const identityPath = join(input.stateDir, `guardian-${process.pid}-${Date.now()}.json`);
  writeFileSync(
    identityPath,
    `${JSON.stringify({ frozen: input.frozen, deadlineMs: input.deadlineMs })}\n`,
    { mode: 0o600 },
  );
  const execPath = input.execPath ?? process.execPath;
  const holder: ChildProcess = spawn(execPath, [HOLDER, CHILD, identityPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const empty = {
    armed: false,
    pid: holder.pid ?? null,
    injectorPid: holder.pid ?? null,
    release() {},
    killInjector() {},
  };
  if (holder.pid == null) return empty;
  const armed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), input.readyMs ?? 2000);
    holder.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      resolve(String(chunk).includes("armed"));
    });
    holder.once("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (!armed) {
    try {
      holder.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    return { ...empty, pid: holder.pid, injectorPid: holder.pid };
  }
  return {
    armed: true,
    pid: holder.pid,
    injectorPid: holder.pid,
    release: () => {
      try {
        holder.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
    killInjector: () => {
      try {
        holder.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    },
  };
}
