import type { ProcessIdentity, StableProcessIdentity } from "@grokbox/runtime-kernel/contract";
export type { ProcessIdentity, StableProcessIdentity } from "@grokbox/runtime-kernel/contract";

export type SignalName = "SIGSTOP" | "SIGCONT" | "SIGTERM" | "SIGKILL";

export type SignalResult = { ok: true } | { ok: false; reason: "identity-mismatch" | "not-found" };

export type ProcessPort = {
  inspect: (pid: number) => ProcessIdentity | null;
  list: () => ProcessIdentity[];
  signal: (expected: ProcessIdentity, signal: SignalName) => SignalResult;
};

export function identitiesMatch(expected: ProcessIdentity, observed: ProcessIdentity | null): boolean {
  if (!observed) return false;
  return (
    stableIdentitiesMatch(expected, observed) &&
    expected.ppid === observed.ppid &&
    expected.ancestry.length === observed.ancestry.length &&
    expected.ancestry.every((value, index) => value === observed.ancestry[index])
  );
}

/** Survives Unix re-parenting. Do not use as a substitute for full identity at signal time. */
export function stableIdentitiesMatch(
  expected: StableProcessIdentity,
  observed: ProcessIdentity | null,
): boolean {
  if (!observed) return false;
  return (
    expected.pid === observed.pid &&
    expected.uid === observed.uid &&
    expected.start === observed.start &&
    expected.exe === observed.exe &&
    expected.cmdline.length === observed.cmdline.length &&
    expected.cmdline.every((value, index) => value === observed.cmdline[index])
  );
}

export function signalIfMatch(port: ProcessPort, expected: ProcessIdentity, signal: SignalName): SignalResult {
  const observed = port.inspect(expected.pid);
  if (!identitiesMatch(expected, observed)) {
    return { ok: false, reason: observed ? "identity-mismatch" : "not-found" };
  }
  return port.signal(expected, signal);
}

/** Classification-only view. Never forwards signals. */
export function readOnlyProcessPort(inner: ProcessPort): ProcessPort {
  return {
    inspect: (pid) => inner.inspect(pid),
    list: () => inner.list(),
    signal: () => ({ ok: false, reason: "not-found" }),
  };
}

export type Census = {
  wrapper: number;
  supervisor: number;
  host: number;
  tempSupervisor: number;
  guardian: number;
  extras: number;
};

export type RoleCounts = Census;

export function countRoles(
  identities: readonly { role: string }[],
): Census {
  const census: Census = { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 };
  for (const row of identities) {
    if (row.role === "wrapper") census.wrapper += 1;
    else if (row.role === "supervisor") census.supervisor += 1;
    else if (row.role === "host") census.host += 1;
    else if (row.role === "temp-supervisor") census.tempSupervisor += 1;
    else if (row.role === "guardian") census.guardian += 1;
    else census.extras += 1;
  }
  return census;
}

export function singleOfficialChain(census: Census): boolean {
  return (
    census.wrapper === 1 &&
    census.supervisor === 1 &&
    census.host === 1 &&
    census.tempSupervisor === 0 &&
    census.guardian === 0
  );
}
