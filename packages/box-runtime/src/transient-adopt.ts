import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IdentityMarker, IdentityOpResult } from "./identity-op.ts";
import { acquireExclusiveLock, operationLockPath } from "./op-lock.ts";
import {
  findAdoptedHostState,
  findUniqueOfficialChain,
  loadReviewedProfile,
  proveStableOfficialState,
  type OfficialChain,
  type RoleClassifier,
} from "./official-chain.ts";
import {
  countRoles,
  signalIfMatch,
  singleOfficialChain,
  stableIdentitiesMatch,
  type ProcessIdentity,
  type ProcessPort,
  type StableProcessIdentity,
} from "./process.ts";
import type { PatchProfile } from "./transform.ts";

export type AdoptOpState = {
  launchMode: "transient-adopt";
  tempSupervisor: ProcessIdentity | null;
  adoptingSupervisor: ProcessIdentity | null;
  host: StableProcessIdentity | null;
};

export function adoptOpStatePath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "state", "adopt-op.json");
}

export async function writeAdoptOpState(root: string, state: AdoptOpState): Promise<void> {
  const path = adoptOpStatePath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function rolesCensus(port: ProcessPort, classify: RoleClassifier) {
  return countRoles(
    port.list().flatMap((ident) => {
      const role = classify(ident);
      return role ? [{ ...ident, role }] : [];
    }),
  );
}

export type TransientAdoptContext = {
  processes: ProcessPort;
  classify: RoleClassifier;
  reviewedProfile: PatchProfile;
  diskSha: () => string;
  ephemeralRoot: string;
  operationId: string;
  readMarker: () => IdentityMarker | null;
  waitGone: (old: ProcessIdentity) => Promise<boolean>;
  waitReady: (hostPid: number) => Promise<IdentityMarker | null>;
  prepareTempLaunch?: () => Promise<void>;
  spawnTempSupervisor: () => Promise<ProcessIdentity | null>;
  waitNewHost: (oldHostPid: number) => Promise<ProcessIdentity | null>;
  readGatewayPid: () => number | null;
  armGuardian: (frozen: ProcessIdentity[]) => Promise<{ ok: true; release: () => void } | { ok: false }>;
  persistAttestation?: (host: ProcessIdentity, sha: string, windowMs: number) => Promise<void>;
  hasGrokboxPreload: (ident: ProcessIdentity) => boolean;
  now: () => number;
};

export async function runTransientAdoptOperation(ctx: TransientAdoptContext): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  const fail = (code: string, signaled: boolean, recoveryRequired = true): IdentityOpResult => ({
    ok: false,
    recoveryRequired,
    code,
    signaled,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: rolesCensus(ctx.processes, ctx.classify),
    coverage: signaled ? "window-open" : "none",
    launchMode: "transient-adopt",
  });

  const lock = await acquireExclusiveLock(operationLockPath(ctx.ephemeralRoot));
  if (!lock.ok) return fail("lock-conflict", false, false);

  try {
    const reviewed = loadReviewedProfile(ctx.reviewedProfile, shaBefore);
    if (!reviewed.ok) return fail(reviewed.code, false, false);

    const stale = ctx.readMarker();
    if (stale && stale.operationId !== ctx.operationId) return fail("stale-marker", false, false);

    const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
    if (!unique.ok) return fail(unique.code, false, false);
    const { wrapper, supervisor, host } = unique.chain;

    const guardian = await ctx.armGuardian([wrapper]);
    if (!guardian.ok) return fail("guardian-not-armed", false, false);
    const started = ctx.now();
    const release = () => guardian.release();

    try {
      if (!signalIfMatch(ctx.processes, wrapper, "SIGSTOP").ok) {
        release();
        return fail("identity-mismatch", false, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        release();
        return fail("disk-sha-changed", true, true);
      }
      await ctx.prepareTempLaunch?.();
      if (!signalIfMatch(ctx.processes, host, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(host))) {
        release();
        return fail("host-still-alive", true, true);
      }
      if (!signalIfMatch(ctx.processes, supervisor, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(supervisor))) {
        release();
        return fail("supervisor-still-alive", true, true);
      }
      const temp = await ctx.spawnTempSupervisor();
      if (!temp) {
        release();
        return fail("temp-spawn-failed", true, true);
      }
      const replacement = await ctx.waitNewHost(host.pid);
      if (!replacement) {
        release();
        return fail("relaunch-failed", true, true);
      }
      const marker = await ctx.waitReady(replacement.pid);
      if (
        !marker ||
        marker.operationId !== ctx.operationId ||
        marker.pid !== replacement.pid ||
        marker.mode !== "identity" ||
        marker.transformed !== true ||
        marker.compiled !== true ||
        marker.modeld !== false
      ) {
        release();
        return fail("marker-mismatch", true, true);
      }
      const stableHost: StableProcessIdentity = {
        pid: replacement.pid,
        uid: replacement.uid,
        start: replacement.start,
        exe: replacement.exe,
        cmdline: replacement.cmdline,
      };
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: stableHost,
      });
      if (ctx.diskSha() !== shaBefore) {
        release();
        return fail("disk-sha-changed", true, true);
      }
      if (!signalIfMatch(ctx.processes, temp, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(temp))) {
        release();
        return fail("temp-still-alive", true, true);
      }
      const afterTemp = ctx.processes.inspect(replacement.pid);
      if (!afterTemp || !stableIdentitiesMatch(stableHost, afterTemp)) {
        release();
        return fail("host-lost", true, true);
      }
      release();
      const adopted = await waitAdopted(ctx, wrapper, stableHost, 8000);
      if (!adopted) return fail("adopt-unproven", true, true);
      if (adopted.host.ppid === adopted.supervisor.pid) return fail("still-supervisor-child", true, true);
      if (ctx.hasGrokboxPreload(adopted.supervisor)) return fail("supervisor-preloaded", true, true);
      if (!ctx.hasGrokboxPreload(adopted.host)) return fail("preload-missing", true, true);
      if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed", true, true);
      const census = rolesCensus(ctx.processes, ctx.classify);
      if (!singleOfficialChain(census)) return fail("census-invalid", true, true);
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        tempSupervisor: null,
        adoptingSupervisor: adopted.supervisor,
        host: stableHost,
      });
      const shaAfter = ctx.diskSha();
      const windowMs = Math.max(0, ctx.now() - started);
      await ctx.persistAttestation?.(adopted.host, shaAfter, windowMs);
      return {
        ok: true,
        recoveryRequired: false,
        signaled: true,
        diskShaBefore: shaBefore,
        diskShaAfter: shaAfter,
        census,
        coverage: "attested",
        host: adopted.host,
        windowMs,
        launchMode: "transient-adopt",
      };
    } catch (error) {
      release();
      return fail(error instanceof Error ? error.message : "inject-error", true, true);
    }
  } finally {
    await lock.lock.release();
  }
}

async function waitAdopted(
  ctx: TransientAdoptContext,
  wrapper: ProcessIdentity,
  expectedHost: StableProcessIdentity,
  ms: number,
): Promise<OfficialChain | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const liveWrapper = ctx.processes.inspect(wrapper.pid);
    if (liveWrapper) {
      const found = findAdoptedHostState(ctx.processes, ctx.classify, {
        gatewayPid: ctx.readGatewayPid(),
        expectedHost,
      });
      if (found.ok && found.state.wrapper.pid === wrapper.pid) return found.state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const found = findAdoptedHostState(ctx.processes, ctx.classify, {
    gatewayPid: ctx.readGatewayPid(),
    expectedHost,
  });
  return found.ok ? found.state : null;
}

export type TransientAdoptDeactivateContext = {
  processes: ProcessPort;
  classify: RoleClassifier;
  diskSha: () => string;
  ephemeralRoot: string;
  attestation: { identity: ProcessIdentity; diskSha: string } | null;
  waitGone: (old: ProcessIdentity) => Promise<boolean>;
  waitReplacement: (oldPid: number) => Promise<ProcessIdentity | null>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  readGatewayPid: () => number | null;
  clearAttestation: () => Promise<void>;
};

export async function runTransientAdoptDeactivate(
  ctx: TransientAdoptDeactivateContext,
): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  const fail = (code: string, signaled = true): IdentityOpResult => ({
    ok: false,
    recoveryRequired: true,
    code,
    signaled,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: rolesCensus(ctx.processes, ctx.classify),
    coverage: "window-open",
    launchMode: "transient-adopt",
  });
  const lock = await acquireExclusiveLock(operationLockPath(ctx.ephemeralRoot));
  if (!lock.ok) return fail("lock-conflict", false);
  try {
    if (!ctx.attestation) {
      return {
        ok: false,
        recoveryRequired: true,
        code: "no-attestation",
        signaled: false,
        diskShaBefore: shaBefore,
        diskShaAfter: shaBefore,
        census: rolesCensus(ctx.processes, ctx.classify),
        coverage: "none",
        launchMode: "transient-adopt",
      };
    }
    if (!signalIfMatch(ctx.processes, ctx.attestation.identity, "SIGTERM").ok) {
      return fail("deactivate-signal-failed");
    }
    if (!(await ctx.waitGone(ctx.attestation.identity))) return fail("patched-host-still-alive");
    const replacement = await ctx.waitReplacement(ctx.attestation.identity.pid);
    if (!replacement || replacement.pid === ctx.attestation.identity.pid) return fail("replacement-unproven");
    if (ctx.hasGrokboxPreload(replacement)) return fail("preload-still-present");
    if (ctx.diskSha() !== shaBefore || shaBefore !== ctx.attestation.diskSha) return fail("disk-sha-changed");
    const proved = proveStableOfficialState(ctx.processes, ctx.classify, {
      gatewayPid: ctx.readGatewayPid(),
      expectedHost: replacement,
    });
    if (!proved.ok || proved.chain.host.pid !== replacement.pid) return fail("census-invalid");
    await ctx.clearAttestation();
    return {
      ok: true,
      recoveryRequired: false,
      signaled: true,
      diskShaBefore: shaBefore,
      diskShaAfter: ctx.diskSha(),
      census: rolesCensus(ctx.processes, ctx.classify),
      coverage: "none",
      host: proved.chain.host,
      launchMode: "transient-adopt",
    };
  } finally {
    await lock.lock.release();
  }
}
