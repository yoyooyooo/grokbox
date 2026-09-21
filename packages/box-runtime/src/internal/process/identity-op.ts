import { operationLockPath, acquireOperationLease } from "../io/operation-lease.node.ts";
import { findUniqueOfficialChain, loadReviewedProfile, type RoleClassifier } from "./official-chain.ts";
import {
  countRoles,
  identitiesMatch,
  signalIfMatch,
  singleOfficialChain,
  type Census,
  type ProcessIdentity,
  type ProcessPort,
} from "./process-port.ts";
import type { PatchProfile } from "../host/profile.ts";
import type { CompileReceipt } from "../host/compile-receipt.ts";
import type { CoverageAttestation } from "../io/authority.node.ts";

export type IdentityMarker = {
  operationId: string;
  pid: number;
  /** Linux process start ticks, captured by the compiling process itself. */
  start?: number;
  mode: "identity" | "route";
  transformed: true;
  compiled: true;
  modeld: false;
  /** Required for transient-adopt receipts; old markers cannot attest a new launch. */
  compile?: CompileReceipt;
  /** SHA-256 of the preload module that compiled this Host. Missing ⇒ other generation. */
  preloadSha256?: string;
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
  launchMode?: "direct-launch" | "transient-adopt";
  /** Exact canonical read-back, not a planned or reconstructed attestation. */
  committedAttestation?: CoverageAttestation;
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
  armGuardian: (frozen: ProcessIdentity[]) => Promise<{ ok: true; release: () => void } | { ok: false }>;
  prepareReplacement?: () => Promise<void>;
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

  const lock = await acquireOperationLease(operationLockPath(ctx.ephemeralRoot), ctx.operationId);
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
    try {
      if (!signalIfMatch(ctx.processes, wrapper, "SIGSTOP").ok) {
        guardian.release();
        return fail("identity-mismatch", false, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        guardian.release();
        return fail("disk-sha-changed", true, true);
      }
      await ctx.prepareReplacement?.();
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
  ephemeralRoot: string;
  attestation: { identity: ProcessIdentity; diskSha: string } | null;
  waitHostGone: (old: ProcessIdentity) => Promise<boolean>;
  waitReplacement: (oldPid: number) => Promise<ProcessIdentity | null>;
  hasGrokboxPreload: (host: ProcessIdentity) => boolean;
  clearAttestation: () => Promise<void>;
};

export async function runIdentityDeactivate(ctx: DeactivateContext): Promise<IdentityOpResult> {
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
  });
  const lock = await acquireOperationLease(operationLockPath(ctx.ephemeralRoot));
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
  } finally {
    await lock.lock.release();
  }
}

export function canonicalOwnershipAgrees(input: {
  attestation: {
    identity: ProcessIdentity;
    diskSha: string;
    mode: string;
    coverage: string;
    modeld: boolean;
  } | null;
  liveHost: ProcessIdentity | null;
  census: Census;
}): boolean {
  if (!input.attestation || !input.liveHost) return false;
  if (input.attestation.mode !== "identity" && input.attestation.mode !== "route") return false;
  if (input.attestation.coverage !== "attested") return false;
  if (input.attestation.mode === "identity" && input.attestation.modeld !== false) return false;
  if (input.attestation.mode === "route" && input.attestation.modeld !== true) return false;
  if (!identitiesMatch(input.attestation.identity, input.liveHost)) return false;
  return singleOfficialChain(input.census);
}

export function attestationAgrees(input: {
  attestation: {
    identity: ProcessIdentity;
    diskSha: string;
    mode: string;
    coverage: string;
    modeld: boolean;
  } | null;
  liveHost: ProcessIdentity | null;
  diskSha: string | null;
  census: Census;
}): boolean {
  if (!input.diskSha) return false;
  if (!canonicalOwnershipAgrees(input)) return false;
  return input.attestation!.diskSha === input.diskSha;
}
