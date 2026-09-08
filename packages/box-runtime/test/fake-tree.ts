import {
  identitiesMatch,
  type ProcessIdentity,
  type ProcessPort,
  type SignalName,
  type SignalResult,
} from "../src/internal/process/process-port.ts";

export type FakeRole = "wrapper" | "supervisor" | "host" | "temp-supervisor" | "guardian" | "extra";

type Row = {
  ident: ProcessIdentity;
  role: FakeRole;
  alive: boolean;
  stopped: boolean;
};

export class FakeProcessTree implements ProcessPort {
  nextPid = 10_000;
  nextStart = 1;
  readonly procs = new Map<number, Row>();
  readonly signals: Array<{ pid: number; signal: SignalName; start: number; exe: string }> = [];

  spawn(role: FakeRole, reuse?: { pid?: number; parent?: ProcessIdentity }): ProcessIdentity & { role: FakeRole } {
    const pid = reuse?.pid ?? this.nextPid++;
    const parent = reuse?.parent;
    const ident: ProcessIdentity = {
      pid,
      uid: 1000,
      start: this.nextStart++,
      exe: `/fake/${role}`,
      cmdline: ["node", `/fake/${role}`],
      ppid: parent?.pid ?? 1,
      ancestry: parent ? [parent.pid, ...parent.ancestry] : [1],
    };
    this.procs.set(pid, { ident, role, alive: true, stopped: false });
    return { ...ident, role };
  }

  inspect(pid: number): ProcessIdentity | null {
    const row = this.procs.get(pid);
    if (!row?.alive) return null;
    return { ...row.ident };
  }

  list(): ProcessIdentity[] {
    return [...this.procs.values()].filter((row) => row.alive).map((row) => ({ ...row.ident }));
  }

  signal(expected: ProcessIdentity, signal: SignalName): SignalResult {
    const row = this.procs.get(expected.pid);
    if (!row?.alive) return { ok: false, reason: "not-found" };
    if (!identitiesMatch(expected, row.ident)) return { ok: false, reason: "identity-mismatch" };
    this.signals.push({ pid: expected.pid, signal, start: expected.start, exe: expected.exe });
    if (signal === "SIGSTOP") row.stopped = true;
    if (signal === "SIGCONT") row.stopped = false;
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      row.alive = false;
      for (const child of this.procs.values()) {
        if (!child.alive || child.ident.ppid !== expected.pid) continue;
        child.ident = { ...child.ident, ppid: 1, ancestry: [1] };
      }
    }
    return { ok: true };
  }

  kill(identity: ProcessIdentity): void {
    this.signal(identity, "SIGTERM");
  }

  roles(): Array<ProcessIdentity & { role: string }> {
    return [...this.procs.values()].filter((row) => row.alive).map((row) => ({ ...row.ident, role: row.role }));
  }

  stopped(pid: number): boolean {
    return this.procs.get(pid)?.stopped === true;
  }

  alive(pid: number): boolean {
    return this.procs.get(pid)?.alive === true;
  }
}

export function hangUntilAbort() {
  return async (_ms: number, signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) return false;
    return await new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(false), { once: true });
    });
  };
}
