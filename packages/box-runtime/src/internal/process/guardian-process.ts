import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProcessIdentity } from "./process-port.ts";
import {
  resolveRuntimeHelper,
  RUNTIME_HELPER_GUARDIAN_CHILD,
  RUNTIME_HELPER_INJECTOR_HOLD,
} from "./helpers/runtime-helpers.ts";

const CHILD = resolveRuntimeHelper(RUNTIME_HELPER_GUARDIAN_CHILD);
const HOLDER = resolveRuntimeHelper(RUNTIME_HELPER_INJECTOR_HOLD);

export type IndependentGuardian = {
  armed: boolean;
  pid: number | null;
  injectorPid: number | null;
  release: () => void;
  signal: AbortSignal;
  dispose: () => void;
  continued: () => boolean | null;
  owners: () => { guardian: { pid: number; start: number }; holder: { pid: number; start: number } } | null;
  end: () => "active" | "released" | "expired" | "lost";
  killInjector: () => void;
};

export async function spawnIndependentGuardian(input: {
  frozen: ProcessIdentity[];
  operationId?: string;
  deadlineMs: number;
  stateDir: string;
  execPath?: string;
  readyMs?: number;
}): Promise<IndependentGuardian> {
  const ownership = new AbortController();
  let end: "active" | "released" | "expired" | "lost" = "active";
  const expiresAt = Date.now() + input.deadlineMs;
  const expire = () => { if (end !== "lost") end = "expired"; ownership.abort(); };
  const timer = setTimeout(expire, input.deadlineMs);
  timer.unref();
  const lifetime = {
    signal: ownership.signal,
    end: () => { if (Date.now() >= expiresAt) expire(); return end; },
    dispose: () => clearTimeout(timer),
    owners: () => {
      try {
        const bytes = readFileSync(`${identityPath}.created.json`);
        if (bytes.length > 1024) return null;
        const row = JSON.parse(bytes.toString());
        if (row.operationId !== (input.operationId ?? null) || row.holder?.pid !== holder.pid
          || ![row.holder, row.guardian].every(value => value && Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.start) && value.start > 0)) return null;
        return { guardian: { pid: row.guardian.pid, start: row.guardian.start }, holder: { pid: row.holder.pid, start: row.holder.start } };
      } catch { return null; }
    },
    continued: (): boolean | null => {
      try {
        const bytes = readFileSync(`${identityPath}.result.json`);
        if (bytes.length > 2048) return null;
        const record = JSON.parse(bytes.toString());
        if (record.operationId !== (input.operationId ?? null) || !Array.isArray(record.continued) || !["released", "expired", "owner-ended", "lost"].includes(record.reason)
          || record.continued.some((row: { pid: number; start: number }) => !input.frozen.some(identity => identity.pid === row.pid && identity.start === row.start))) return null;
        return record.continued.length > 0;
      } catch { return null; }
    },
  };
  mkdirSync(input.stateDir, { recursive: true, mode: 0o700 });
  const identityPath = join(input.stateDir, `guardian-${process.pid}-${randomUUID()}.json`);
  writeFileSync(
    identityPath,
    `${JSON.stringify({ frozen: input.frozen, deadlineMs: input.deadlineMs, expiresAt, operationId: input.operationId })}\n`,
    { mode: 0o600 },
  );
  const execPath = input.execPath ?? process.execPath;
  const holder: ChildProcess = spawn(execPath, [HOLDER, CHILD, identityPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const empty = {
    ...lifetime,
    armed: false,
    pid: holder.pid ?? null,
    injectorPid: holder.pid ?? null,
    release() {},
    killInjector() {},
  };
  holder.once("error", () => { end = "lost"; ownership.abort(); });
  holder.once("exit", () => { if (end === "active") { end = "lost"; ownership.abort(); } });
  let notices = "";
  holder.stdout?.on("data", (chunk: Buffer) => {
    notices = (notices + String(chunk)).slice(-128);
    if (notices.includes("expired\n")) expire();
    else if (end === "active" && /(?:owner-ended|lost|released)\n/.test(notices)) {
      end = "lost"; ownership.abort();
    }
  });
  if (holder.pid == null) { lifetime.dispose(); return empty; }
  const armed = await new Promise<boolean>((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer); ownership.signal.removeEventListener("abort", aborted); resolve(value);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), input.readyMs ?? 2000);
    ownership.signal.addEventListener("abort", aborted, { once: true });
    if (ownership.signal.aborted) finish(false);
    holder.stdout?.once("data", (chunk: Buffer) => {
      finish(String(chunk).includes("armed"));
    });
    holder.once("exit", () => {
      finish(false);
    });
  });
  if (!armed) {
    try {
      holder.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    lifetime.dispose();
    return { ...empty, pid: holder.pid, injectorPid: holder.pid };
  }
  return {
    ...lifetime,
    armed: !ownership.signal.aborted,
    pid: holder.pid,
    injectorPid: holder.pid,
    release: () => {
      if (end === "active") end = "released";
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
