import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import {
  identitiesMatch,
  type ProcessIdentity,
  type ProcessPort,
  type SignalName,
  type SignalResult,
} from "./process-port.ts";

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

export const LIVE_TEMP_SUPERVISOR_NEEDLE = "grokbox-temp-supervisor.cjs";

const DIAGNOSTIC_BASENAMES = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "fish",
  "rg",
  "grep",
  "egrep",
  "fgrep",
]);

const SHELL_BASENAMES = new Set(["bash", "sh", "dash", "zsh", "fish"]);

const VALUE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c"]);

function fileBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function roleFileBasenames(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part == null || part.length === 0) continue;
    if (i > 0 && VALUE_FLAGS.has(part)) {
      i += 1;
      continue;
    }
    if (i > 0 && part.startsWith("-")) continue;
    names.push(fileBasename(part));
  }
  return names;
}

export function roleOf(
  identity: ProcessIdentity,
): "wrapper" | "supervisor" | "host" | "temp-supervisor" | null {
  const argv = identity.cmdline;
  if (argv.length === 0) return null;
  const exeBase = fileBasename(identity.exe);
  const argv0 = fileBasename(argv[0] ?? "");
  const diagnostic = DIAGNOSTIC_BASENAMES.has(exeBase) || DIAGNOSTIC_BASENAMES.has(argv0);
  if (diagnostic && !SHELL_BASENAMES.has(exeBase) && !SHELL_BASENAMES.has(argv0)) return null;
  const names = new Set(roleFileBasenames(argv));
  if (names.has(LIVE_TEMP_SUPERVISOR_NEEDLE)) return "temp-supervisor";
  if (names.has("supervise-sand-supervisor")) return "wrapper";
  if (names.has("sand-supervisor.mjs")) return "supervisor";
  if (names.has("host-main.cjs")) return "host";
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

/** Role discovery may exclude readable stable non-candidates without reading
 * executable links. Exact recorded ownership never uses that exclusion. */
export function strictLinuxObservationPort(procRoot = "/proc", fullIdentity: (pid: number) => ProcessIdentity | null = inspectPid): ProcessPort {
  const missing = (error: unknown) => ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
  const stat = (pid: number) => {
    try {
      const text = readFileSync(`${procRoot}/${pid}/stat`, "utf8"), end = text.lastIndexOf(")");
      const fields = text.slice(end + 2).split(" "), start = Number(fields[19]), ppid = Number(fields[1]);
      if (end < 0 || !Number.isSafeInteger(start) || start <= 0 || !Number.isSafeInteger(ppid)) throw Error();
      return ["Z", "X"].includes(fields[0]!) ? null : { pid, start, ppid };
    } catch (error) { if (missing(error)) return null; throw Error("restoration-process-unavailable"); }
  };
  const snapshot = (pid: number) => {
    const before = stat(pid); if (!before) return null;
    try {
      const bytes = readFileSync(`${procRoot}/${pid}/cmdline`), after = stat(pid);
      if (!after) return null;
      const again = readFileSync(`${procRoot}/${pid}/cmdline`);
      if (!bytes.length || bytes.length > 65536 || bytes[bytes.length - 1] !== 0 || !bytes.equals(again)
        || before.start !== after.start || before.ppid !== after.ppid) throw Error();
      const args = bytes.toString("utf8").split("\0").filter(Boolean);
      if (!Buffer.from(bytes.toString("utf8")).equals(bytes) || !args.length) throw Error();
      return { ...after, args };
    } catch (error) { if (missing(error) && !stat(pid)) return null; throw Error("restoration-discovery-unavailable"); }
  };
  let exclusions: Array<NonNullable<ReturnType<typeof snapshot>>> = [];
  const recheckDiscovery = () => {
    for (const before of exclusions) {
      const after = snapshot(before.pid);
      if (after && JSON.stringify(after) !== JSON.stringify(before)) throw Error("restoration-discovery-changed");
    }
  };
  const inspect = (pid: number) => {
    const before = stat(pid); if (!before) return null;
    const row = fullIdentity(pid), after = stat(pid);
    if (!after) return null;
    if (!row || row.start !== before.start || after.start !== before.start || row.ppid !== after.ppid) throw Error("restoration-process-unavailable");
    return row;
  };
  return {
    inspect, recheckDiscovery,
    inspectLifetime: pid => { const before = stat(pid), after = stat(pid); if (!after) return null;
      if (!before || before.start !== after.start) throw Error("restoration-owner-changed"); return { pid, start: after.start }; },
    list: () => {
      recheckDiscovery();
      const next: typeof exclusions = [], rows: ProcessIdentity[] = [];
      const predicates = new Set(["supervise-sand-supervisor", "sand-supervisor.mjs", "host-main.cjs", LIVE_TEMP_SUPERVISOR_NEEDLE, "guardian-child.cjs", "injector-hold.cjs"]);
      for (const name of readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
        const evidence = snapshot(Number(name)); if (!evidence) continue;
        if (!evidence.args.some(arg => predicates.has(fileBasename(arg)))) { next.push(evidence); continue; }
        const identity = inspect(evidence.pid);
        if (identity) { if (JSON.stringify(snapshot(evidence.pid)) !== JSON.stringify(evidence)) throw Error("restoration-discovery-changed"); rows.push(identity); }
      }
      exclusions = next; return rows;
    },
    signal: () => { throw Error("observation-only"); },
  };
}

/** Fail-closed presence only; no environment values leave this leaf. */
export function hasRelevantPreloadStrict(pid: number): boolean {
  let present = false;
  forEachProcEnv(pid, (key, value) => {
    if (key.startsWith("GROKBOX_") || key === "NODE_OPTIONS" && /grokbox|--require|--import/.test(value)) present = true;
  });
  return present;
}
