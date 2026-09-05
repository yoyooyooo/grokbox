import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import {
  identitiesMatch,
  type ProcessIdentity,
  type ProcessPort,
  type SignalName,
  type SignalResult,
} from "./process.ts";

export function inspectPid(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commEnd = stat.lastIndexOf(")");
    const rest = stat.slice(commEnd + 2).split(" ");
    const ppid = Number(rest[1]);
    const start = Number(rest[19]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const uidLine = status.split("Uid:")[1];
    if (!uidLine) return null;
    const uid = Number(uidLine.trim().split(/\s+/)[0]);
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    const exe = readlinkSync(`/proc/${pid}/exe`);
    const ancestry: number[] = [];
    let parent = ppid;
    for (let i = 0; i < 8 && parent > 1; i += 1) {
      ancestry.push(parent);
      const parentStat = readFileSync(`/proc/${parent}/stat`, "utf8");
      const parentEnd = parentStat.lastIndexOf(")");
      parent = Number(parentStat.slice(parentEnd + 2).split(" ")[1]);
    }
    return { pid, uid, start, exe, cmdline, ppid, ancestry };
  } catch {
    return null;
  }
}

export function roleOf(identity: ProcessIdentity): "wrapper" | "supervisor" | "host" | null {
  const line = identity.cmdline.join(" ");
  if (line.includes("supervise-sand-supervisor")) return "wrapper";
  if (line.includes("sand-supervisor.mjs")) return "supervisor";
  if (line.includes("host-main.cjs") && !line.includes("rg ")) return "host";
  return null;
}

export function linuxProcessPort(): ProcessPort {
  return {
    inspect: inspectPid,
    list: () => {
      const ids: ProcessIdentity[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const ident = inspectPid(Number(name));
        if (ident) ids.push(ident);
      }
      return ids;
    },
    signal: (expected, signal: SignalName): SignalResult => {
      const observed = inspectPid(expected.pid);
      if (!identitiesMatch(expected, observed)) {
        return { ok: false, reason: observed ? "identity-mismatch" : "not-found" };
      }
      try {
        process.kill(expected.pid, signal);
        return { ok: true };
      } catch {
        return { ok: false, reason: "not-found" };
      }
    },
  };
}

export function findRole(
  port: ProcessPort,
  role: "wrapper" | "supervisor" | "host",
): ProcessIdentity | null {
  for (const ident of port.list()) {
    if (roleOf(ident) === role) return ident;
  }
  return null;
}

export function readEnviron(pid: number): Record<string, string> {
  const env: Record<string, string> = {};
  const raw = readFileSync(`/proc/${pid}/environ`);
  for (const item of raw.toString("utf8").split("\0")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return env;
}

function forEachProcEnv(pid: number, visit: (key: string, value: string) => boolean | void): void {
  const raw = readFileSync(`/proc/${pid}/environ`);
  for (const item of raw.toString("utf8").split("\0")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    const stop = visit(item.slice(0, eq), item.slice(eq + 1));
    if (stop === false) return;
  }
}

/** Presence-only. Does not return or retain the full environ map. */
export function procEnvHas(pid: number, key: string, valueNeedle?: string): boolean {
  let found = false;
  try {
    forEachProcEnv(pid, (name, value) => {
      if (name !== key) return;
      found = valueNeedle == null ? true : value.includes(valueNeedle);
      return false;
    });
  } catch {
    return false;
  }
  return found;
}

/** Copies only the named keys. Never materializes the rest of `/proc/environ`. */
export function readNamedProcEnv(pid: number, keys: readonly string[]): Record<string, string> {
  const wanted = new Set(keys);
  const env: Record<string, string> = {};
  try {
    forEachProcEnv(pid, (name, value) => {
      if (!wanted.has(name) || value.length === 0) return;
      env[name] = value;
      if (Object.keys(env).length >= wanted.size) return false;
    });
  } catch {
    return env;
  }
  return env;
}
