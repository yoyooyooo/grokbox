import { acquireExclusiveLock, operationLockPath } from "./op-lock.ts";
import { findUniqueOfficialChain, loadReviewedProfile, type RoleClassifier } from "./official-chain.ts";
import {
  countRoles,
  identitiesMatch,
  signalIfMatch,
  singleOfficialChain,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process.ts";
import type { PatchProfile } from "./transform.ts";

export type IdentityMarker = {
  operationId: string;
  pid: number;
  mode: "identity";
  transformed: true;
  compiled: true;
  modeld: false;
};

export type IdentityOpResult = {
  ok: boolean;
  recoveryRequired: boolean;
  code?: string;
  signaled: boolean;
  diskShaBefore: string;
  diskShaAfter: string;
  census: Census;
  coverage: "none" | "attested" | "window-open";
  host?: ProcessIdentity;
  windowMs?: number;
};

export type IdentityOpContext = {
  processes: ProcessPort;
  classify: RoleClassifier;
  reviewedProfile: PatchProfile;
  diskSha: () => string;
  ephemeralRoot: string;
  operationId: string;
  readMarker: () => IdentityMarker | null;
  waitHostGone: (old: ProcessIdentity) => Promise<boolean>;
  supervisorRelaunch: (supervisor: ProcessIdentity) => Promise<ProcessIdentity | null>;
  waitReady: (hostPid: number) => Promise<IdentityMarker | null>;
  armGuardian: (frozen: ProcessIdentity[]) => { release: () => void };
  persistAttestation?: (host: ProcessIdentity, sha: string, windowMs: number) => Promise<void>;
  now: () => number;
};

function rolesCensus(port: ProcessPort, classify: RoleClassifier): Census {
  return countRoles(
    port.list().flatMap((ident) => {
      const role = classify(ident);
      return role ? [{ ...ident, role }] : [];
    }),
  );
}

export async function runIdentityOperation(ctx: IdentityOpContext): Promise<IdentityOpResult> {
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

    const guardian = ctx.armGuardian([wrapper]);
    const started = ctx.now();
    try {
      if (!signalIfMatch(ctx.processes, wrapper, "SIGSTOP").ok) {
        guardian.release();
        return fail("identity-mismatch", false, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        guardian.release();
        return fail("disk-sha-changed", true, true);
      }
      if (!signalIfMatch(ctx.processes, host, "SIGTERM").ok) {
        guardian.release();
        return fail("identity-mismatch", true, true);
      }
      const gone = await ctx.waitHostGone(host);
      if (!gone) {
        guardian.release();
        return fail("host-still-alive", true, true);
      }
      const replacement = await ctx.supervisorRelaunch(supervisor);
      if (!replacement) {
        guardian.release();
        return fail("relaunch-failed", true, true);
      }
      const inspected = ctx.processes.inspect(replacement.pid);
      if (!inspected || inspected.ppid !== supervisor.pid) {
        guardian.release();
        return fail("not-supervisor-owned", true, true);
      }
      const marker = await ctx.waitReady(inspected.pid);
      if (
        !marker ||
        marker.operationId !== ctx.operationId ||
        marker.pid !== inspected.pid ||
        marker.mode !== "identity" ||
        marker.transformed !== true ||
        marker.compiled !== true ||
        marker.modeld !== false
      ) {
        guardian.release();
        return fail("marker-mismatch", true, true);
      }
      guardian.release();
      const shaAfter = ctx.diskSha();
      const census = rolesCensus(ctx.processes, ctx.classify);
      if (shaAfter !== shaBefore) return fail("disk-sha-changed", true, true);
      if (!singleOfficialChain(census)) return fail("census-invalid", true, true);
      const live = findUniqueOfficialChain(ctx.processes, ctx.classify);
      if (!live.ok || live.chain.host.pid !== inspected.pid) return fail("adopt-unproven", true, true);
      const windowMs = Math.max(0, ctx.now() - started);
      await ctx.persistAttestation?.(live.chain.host, shaAfter, windowMs);
      return {
        ok: true,
        recoveryRequired: false,
        signaled: true,
        diskShaBefore: shaBefore,
        diskShaAfter: shaAfter,
        census,
        coverage: "attested",
        host: live.chain.host,
        windowMs,
      };
    } catch (error) {
      guardian.release();
      return fail(error instanceof Error ? error.message : "inject-error", true, true);
    }
  } finally {
    await lock.lock.release();
  }
}

export type DeactivateContext = {
  processes: ProcessPort;
  classify: RoleClassifier;
  diskSha: () => string;
  attestation: { identity: ProcessIdentity; diskSha: string } | null;
  waitHostGone: (old: ProcessIdentity) => Promise<boolean>;
  waitReplacement: (oldPid: number) => Promise<ProcessIdentity | null>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  clearAttestation: () => Promise<void>;
};

export async function runIdentityDeactivate(ctx: DeactivateContext): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  const fail = (code: string): IdentityOpResult => ({
    ok: false,
    recoveryRequired: true,
    code,
    signaled: true,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: rolesCensus(ctx.processes, ctx.classify),
    coverage: "window-open",
  });
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
    };
  }
  const term = signalIfMatch(ctx.processes, ctx.attestation.identity, "SIGTERM");
  if (!term.ok) return fail("deactivate-signal-failed");
  const gone = await ctx.waitHostGone(ctx.attestation.identity);
  if (!gone) return fail("patched-host-still-alive");
  const replacement = await ctx.waitReplacement(ctx.attestation.identity.pid);
  if (!replacement || replacement.pid === ctx.attestation.identity.pid) return fail("replacement-unproven");
  if (ctx.hasGrokboxPreload(replacement)) return fail("preload-still-present");
  if (ctx.diskSha() !== shaBefore || shaBefore !== ctx.attestation.diskSha) return fail("disk-sha-changed");
  const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
  if (!unique.ok || unique.chain.host.pid !== replacement.pid) return fail("census-invalid");
  if (unique.chain.host.ppid !== unique.chain.supervisor.pid) return fail("not-supervisor-owned");
  await ctx.clearAttestation();
  return {
    ok: true,
    recoveryRequired: false,
    signaled: true,
    diskShaBefore: shaBefore,
    diskShaAfter: ctx.diskSha(),
    census: rolesCensus(ctx.processes, ctx.classify),
    coverage: "none",
    host: unique.chain.host,
  };
}

export function attestationAgrees(input: {
  attestation: { identity: ProcessIdentity; diskSha: string; mode?: string } | null;
  liveHost: ProcessIdentity | null;
  diskSha: string | null;
  census: Census;
}): boolean {
  if (!input.attestation || !input.liveHost || !input.diskSha) return false;
  if (!identitiesMatch(input.attestation.identity, input.liveHost)) return false;
  if (input.attestation.diskSha !== input.diskSha) return false;
  return singleOfficialChain(input.census);
}
