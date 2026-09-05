import { armGuardian } from "./guardian.ts";
import {
  countRoles,
  signalIfMatch,
  singleOfficialChain,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process.ts";

export type DiskView = {
  sha: () => string;
};

export type InjectMode = "observe" | "identity";

export type RoleProcess = ProcessIdentity & { role: string };

export type InjectContext = {
  mode: InjectMode;
  expectedSha: string;
  disk: DiskView;
  processes: ProcessPort;
  roles: () => RoleProcess[];
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
  now: () => number;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  spawnTempSupervisor: () => RoleProcess;
  spawnHost: () => RoleProcess;
  kill: (identity: ProcessIdentity) => void;
};

export type InjectResult = {
  ok: boolean;
  code?: "disk-sha-changed" | "identity-mismatch" | "census-invalid";
  coverage: "none" | "attested" | "window-open";
  census: Census;
  modeldRequired: false;
};

function censusOf(ctx: InjectContext): Census {
  return countRoles(ctx.roles().filter((row) => ctx.processes.inspect(row.pid) !== null));
}

export async function runObserveOrIdentityInject(ctx: InjectContext): Promise<InjectResult> {
  const fail = (code: InjectResult["code"], coverage: InjectResult["coverage"] = "none"): InjectResult => ({
    ok: false,
    code,
    coverage,
    census: censusOf(ctx),
    modeldRequired: false,
  });

  if (ctx.disk.sha() !== ctx.expectedSha) return fail("disk-sha-changed", "window-open");

  const guardian = armGuardian({
    wrapper: ctx.wrapper,
    processes: ctx.processes,
    deadlineMs: 5_000,
    now: ctx.now,
    wait: ctx.wait,
  });

  const stop = signalIfMatch(ctx.processes, ctx.wrapper, "SIGSTOP");
  if (!stop.ok) {
    guardian.close();
    return fail("identity-mismatch");
  }

  if (ctx.disk.sha() !== ctx.expectedSha) {
    guardian.close();
    return fail("disk-sha-changed", "window-open");
  }

  const temp = ctx.spawnTempSupervisor();
  ctx.kill(ctx.host);
  ctx.spawnHost();
  ctx.kill(temp);
  guardian.close();

  const census = censusOf(ctx);
  if (!singleOfficialChain(census)) {
    return { ok: false, code: "census-invalid", coverage: "window-open", census, modeldRequired: false };
  }
  return { ok: true, coverage: "attested", census, modeldRequired: false };
}
