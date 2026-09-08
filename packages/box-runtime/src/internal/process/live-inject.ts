import { armGuardian } from "./guardian.node.ts";
import {
  countRoles,
  signalIfMatch,
  singleOfficialChain,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process-port.ts";

export type LiveIdentityResult = {
  ok: boolean;
  recoveryRequired: boolean;
  code?: string;
  diskShaBefore: string;
  diskShaAfter: string;
  census: Census;
  coverage: "none" | "attested" | "window-open";
  hostPid?: number;
  marker?: { mode?: string; transformed?: boolean; modeld?: boolean };
};

export type IdentityChainContext = {
  processes: ProcessPort;
  wrapper: ProcessIdentity;
  supervisor: ProcessIdentity;
  host: ProcessIdentity;
  diskSha: () => string;
  roles: () => Array<ProcessIdentity & { role: string }>;
  spawnHost: () => ProcessIdentity;
  readMarker: () => { mode?: string; transformed?: boolean; modeld?: boolean } | undefined;
  wait: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  now: () => number;
  persist?: (host: ProcessIdentity, sha: string) => Promise<void>;
};

function censusOf(ctx: IdentityChainContext): Census {
  return countRoles(ctx.roles().filter((row) => ctx.processes.inspect(row.pid) !== null));
}

/** Legacy fake-tree protocol. New identity-op is the land-now kernel. */
export async function runIdentityChainInject(ctx: IdentityChainContext): Promise<LiveIdentityResult> {
  const shaBefore = ctx.diskSha();
  const fail = (code: string, recoveryRequired = true): LiveIdentityResult => ({
    ok: false,
    recoveryRequired,
    code,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: censusOf(ctx),
    coverage: "window-open",
  });

  const guardianWrapper = armGuardian({
    wrapper: ctx.wrapper,
    processes: ctx.processes,
    deadlineMs: 5_000,
    now: ctx.now,
    wait: ctx.wait,
  });
  const guardianSupervisor = armGuardian({
    wrapper: ctx.supervisor,
    processes: ctx.processes,
    deadlineMs: 5_000,
    now: ctx.now,
    wait: ctx.wait,
  });
  const contAll = () => {
    guardianSupervisor.close();
    guardianWrapper.close();
  };

  try {
    if (!signalIfMatch(ctx.processes, ctx.wrapper, "SIGSTOP").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    if (!signalIfMatch(ctx.processes, ctx.supervisor, "SIGSTOP").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    if (ctx.diskSha() !== shaBefore) {
      contAll();
      return fail("disk-sha-changed");
    }
    if (!signalIfMatch(ctx.processes, ctx.host, "SIGTERM").ok) {
      contAll();
      return fail("identity-mismatch");
    }
    const spawned = ctx.spawnHost();
    const marker = ctx.readMarker();
    if (marker?.transformed !== true || marker.mode !== "identity" || marker.modeld !== false) {
      contAll();
      return fail("marker-missing");
    }
    signalIfMatch(ctx.processes, ctx.supervisor, "SIGCONT");
    signalIfMatch(ctx.processes, ctx.wrapper, "SIGCONT");
    contAll();

    const shaAfter = ctx.diskSha();
    const census = censusOf(ctx);
    if (shaAfter !== shaBefore) return { ...fail("disk-sha-changed"), diskShaAfter: shaAfter, census };
    if (!singleOfficialChain(census)) return { ...fail("census-invalid"), diskShaAfter: shaAfter, census, hostPid: spawned.pid, marker };
    await ctx.persist?.(spawned, shaAfter);
    return {
      ok: true,
      recoveryRequired: false,
      diskShaBefore: shaBefore,
      diskShaAfter: shaAfter,
      census,
      coverage: "attested",
      hostPid: spawned.pid,
      marker,
    };
  } catch (error) {
    contAll();
    return fail(error instanceof Error ? error.message : "inject-error");
  }
}

const BLOCKED: LiveIdentityResult = {
  ok: false,
  recoveryRequired: false,
  code: "live-host-blocked",
  diskShaBefore: "",
  diskShaAfter: "",
  census: { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 },
  coverage: "none",
};

export async function runLiveIdentityInject(input?: {
  root: string;
  preloadPath: string;
  reviewedProfilePath?: string;
  ephemeralRoot?: string;
}): Promise<LiveIdentityResult> {
  if (!input?.preloadPath || !input.reviewedProfilePath) {
    return { ...BLOCKED };
  }
  const { runH3LiveIdentitySession } = await import("./h3-live.ts");
  const session = await runH3LiveIdentitySession({
    ephemeralRoot: input.ephemeralRoot ?? input.root,
    reviewedProfilePath: input.reviewedProfilePath,
    preloadPath: input.preloadPath,
  });
  if (!session.injected) {
    return {
      ok: false,
      recoveryRequired: false,
      code: session.preflight.code ?? "live-preflight",
      diskShaBefore: session.preflight.diskSha,
      diskShaAfter: session.preflight.diskSha,
      census: session.preflight.census,
      coverage: "none",
    };
  }
  const result = session.deactivate ?? session.inject;
  if (!result) {
    return { ...BLOCKED, code: "live-preflight" };
  }
  return {
    ok: result.ok,
    recoveryRequired: result.recoveryRequired,
    code: result.code,
    diskShaBefore: result.diskShaBefore,
    diskShaAfter: result.diskShaAfter,
    census: result.census,
    coverage: result.coverage,
    hostPid: result.host?.pid,
  };
}

export async function runLiveIdentityDeactivate(_input?: { root: string }): Promise<LiveIdentityResult> {
  return { ...BLOCKED };
}
