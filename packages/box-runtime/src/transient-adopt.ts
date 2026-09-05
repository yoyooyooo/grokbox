import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IdentityMarker, IdentityOpResult } from "./identity-op.ts";
import { acquireExclusiveLock, operationLockPath } from "./op-lock.ts";
import {
  findAdoptedHostState,
  findUniqueOfficialChain,
  loadReviewedProfile,
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

export type AdoptOpPhase =
  | "preflight"
  | "wrapper-stop"
  | "term-old-host"
  | "term-old-supervisor"
  | "spawn-temp"
  | "temp-host-ready"
  | "term-temp"
  | "await-adopt"
  | "attested"
  | "deactivate-preflight"
  | "deactivate-term"
  | "direct-official"
  | "recovery-required";

export type AdoptOpState = {
  launchMode: "transient-adopt";
  phase?: AdoptOpPhase;
  operationId?: string;
  tempSupervisor: ProcessIdentity | null;
  adoptingSupervisor: ProcessIdentity | null;
  host: StableProcessIdentity | null;
};

const DONE_PHASES = new Set<AdoptOpPhase>(["attested", "direct-official"]);

export function adoptJournalNeedsRecovery(state: AdoptOpState | null): boolean {
  if (!state) return false;
  if (state.tempSupervisor) return true;
  if (state.phase === "recovery-required") return true;
  if (state.phase && !DONE_PHASES.has(state.phase)) return true;
  return false;
}

function stableOf(ident: ProcessIdentity): StableProcessIdentity {
  return {
    pid: ident.pid,
    uid: ident.uid,
    start: ident.start,
    exe: ident.exe,
    cmdline: ident.cmdline,
  };
}

export function adoptOpStatePath(ephemeralRoot: string): string {
  return join(ephemeralRoot, "state", "adopt-op.json");
}

export async function writeAdoptOpState(root: string, state: AdoptOpState): Promise<void> {
  const path = adoptOpStatePath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export async function readAdoptOpState(root: string): Promise<AdoptOpState | null> {
  try {
    return JSON.parse(await readFile(adoptOpStatePath(root), "utf8")) as AdoptOpState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Official supervisor launches a new Host unless gateway discovery names this live identity Host. */
export function canHandoffAdopt(input: {
  gatewayPid: number | null;
  hostPid: number;
  hostAlive: boolean;
}): boolean {
  return input.hostAlive && input.gatewayPid === input.hostPid;
}

export function officialWouldSpawn(input: {
  gatewayPid: number | null;
  identityHostPid: number;
  identityHostAlive: boolean;
}): boolean {
  return !canHandoffAdopt({
    gatewayPid: input.gatewayPid,
    hostPid: input.identityHostPid,
    hostAlive: input.identityHostAlive,
  });
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
  adoptProveMs?: number;
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
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "wrapper-stop",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: stableOf(host),
      });
      if (!signalIfMatch(ctx.processes, wrapper, "SIGSTOP").ok) {
        release();
        return fail("identity-mismatch", false, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        release();
        return fail("disk-sha-changed", true, true);
      }
      await ctx.prepareTempLaunch?.();
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-old-host",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: stableOf(host),
      });
      if (!signalIfMatch(ctx.processes, host, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-old-supervisor",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: supervisor,
        host: stableOf(host),
      });
      if (!signalIfMatch(ctx.processes, supervisor, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(host))) {
        release();
        return fail("host-still-alive", true, true);
      }
      if (!(await ctx.waitGone(supervisor))) {
        release();
        return fail("supervisor-still-alive", true, true);
      }
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "spawn-temp",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: null,
      });
      const temp = await ctx.spawnTempSupervisor();
      if (!temp) {
        release();
        return fail("temp-spawn-failed", true, true);
      }
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "spawn-temp",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: null,
      });
      await ctx.waitNewHost(host.pid);
      const hosts = ctx.processes.list().filter((ident) => ctx.classify(ident) === "host" && ident.pid !== host.pid);
      const owned = hosts.filter((ident) => ident.ppid === temp.pid);
      const competitors = hosts.filter((ident) => ident.ppid !== temp.pid);
      if (competitors.length > 0) {
        await reapOperationOwned(ctx, temp, owned[0] ?? null);
        release();
        return fail("competitor-host", true, true);
      }
      const replacement = owned[0];
      if (!replacement) {
        await reapOperationOwned(ctx, temp, null);
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
        await reapOperationOwned(ctx, temp, replacement);
        release();
        return fail("marker-mismatch", true, true);
      }
      const stableHost = stableOf(replacement);
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "temp-host-ready",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: stableHost,
      });
      const handoffMs = ctx.adoptProveMs ?? 8000;
      if (!(await waitHandoffReady(ctx, replacement.pid, handoffMs))) {
        await reapOperationOwned(ctx, temp, replacement);
        release();
        return fail("gateway-unproven", true, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        await reapOperationOwned(ctx, temp, replacement);
        release();
        return fail("disk-sha-changed", true, true);
      }
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-temp",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: stableHost,
      });
      if (!signalIfMatch(ctx.processes, temp, "SIGTERM").ok) {
        await reapOperationOwned(ctx, temp, replacement);
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(temp))) {
        await reapOperationOwned(ctx, null, replacement);
        release();
        return fail("temp-still-alive", true, true);
      }
      const afterTemp = ctx.processes.inspect(replacement.pid);
      if (!afterTemp || !stableIdentitiesMatch(stableHost, afterTemp)) {
        release();
        return fail("host-lost", true, true);
      }
      if (
        officialWouldSpawn({
          gatewayPid: ctx.readGatewayPid(),
          identityHostPid: afterTemp.pid,
          identityHostAlive: true,
        })
      ) {
        await reapOperationOwned(ctx, null, afterTemp);
        release();
        return fail("gateway-unproven", true, true);
      }
      release();
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "await-adopt",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: stableHost,
      });
      const adopted = await waitAdopted(ctx, wrapper, stableHost, ctx.adoptProveMs ?? 8000);
      if (!adopted) return fail("adopt-unproven", true, true);
      if (adopted.host.ppid === adopted.supervisor.pid) return fail("still-supervisor-child", true, true);
      if (ctx.hasGrokboxPreload(adopted.supervisor)) return fail("supervisor-preloaded", true, true);
      if (!ctx.hasGrokboxPreload(adopted.host)) return fail("preload-missing", true, true);
      if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed", true, true);
      const census = rolesCensus(ctx.processes, ctx.classify);
      if (!singleOfficialChain(census)) return fail("census-invalid", true, true);
      await writeAdoptOpState(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "attested",
        operationId: ctx.operationId,
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

async function waitHandoffReady(
  ctx: TransientAdoptContext,
  hostPid: number,
  ms: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (
      canHandoffAdopt({
        gatewayPid: ctx.readGatewayPid(),
        hostPid,
        hostAlive: ctx.processes.inspect(hostPid) != null,
      })
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return canHandoffAdopt({
    gatewayPid: ctx.readGatewayPid(),
    hostPid,
    hostAlive: ctx.processes.inspect(hostPid) != null,
  });
}

function isOperationOwnedHost(
  ctx: TransientAdoptContext,
  temp: ProcessIdentity | null,
  host: ProcessIdentity,
): boolean {
  const live = ctx.processes.inspect(host.pid);
  if (!live || !stableIdentitiesMatch(host, live)) return false;
  if (temp) {
    const liveTemp = ctx.processes.inspect(temp.pid);
    if (liveTemp && live.ppid === liveTemp.pid) return true;
    if (!liveTemp && ctx.hasGrokboxPreload(live)) return true;
    return false;
  }
  return ctx.hasGrokboxPreload(live);
}

async function reapOperationOwned(
  ctx: TransientAdoptContext,
  temp: ProcessIdentity | null,
  host: ProcessIdentity | null,
): Promise<void> {
  if (host && isOperationOwnedHost(ctx, temp, host)) {
    const liveHost = ctx.processes.inspect(host.pid);
    if (liveHost) signalIfMatch(ctx.processes, liveHost, "SIGTERM");
    await ctx.waitGone(host);
  }
  if (temp) {
    const liveTemp = ctx.processes.inspect(temp.pid);
    if (liveTemp) signalIfMatch(ctx.processes, liveTemp, "SIGTERM");
    await ctx.waitGone(temp);
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
    const hosts = ctx.processes.list().filter((ident) => ctx.classify(ident) === "host");
    if (hosts.some((ident) => ident.pid !== expectedHost.pid)) return null;
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
    coverage: signaled ? "window-open" : "none",
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
    const live = ctx.processes.inspect(ctx.attestation.identity.pid);
    if (!live || !stableIdentitiesMatch(ctx.attestation.identity, live)) {
      return fail("identity-mismatch", false);
    }
    if (ctx.diskSha() !== shaBefore || shaBefore !== ctx.attestation.diskSha) {
      return fail("disk-sha-changed", false);
    }
    const census = rolesCensus(ctx.processes, ctx.classify);
    if (!singleOfficialChain(census)) return fail("census-invalid", false);
    const adopted = findAdoptedHostState(ctx.processes, ctx.classify, {
      gatewayPid: ctx.readGatewayPid(),
      expectedHost: live,
    });
    if (!adopted.ok) return fail(adopted.code, false);
    if (!ctx.hasGrokboxPreload(adopted.state.host)) return fail("preload-missing", false);
    if (ctx.hasGrokboxPreload(adopted.state.supervisor)) return fail("supervisor-preloaded", false);
    await writeAdoptOpState(ctx.ephemeralRoot, {
      launchMode: "transient-adopt",
      phase: "deactivate-term",
      tempSupervisor: null,
      adoptingSupervisor: adopted.state.supervisor,
      host: stableOf(live),
    });
    if (!signalIfMatch(ctx.processes, live, "SIGTERM").ok) {
      return fail("deactivate-signal-failed");
    }
    if (!(await ctx.waitGone(live))) return fail("patched-host-still-alive");
    const replacement = await ctx.waitReplacement(live.pid);
    if (!replacement || replacement.pid === live.pid) return fail("replacement-unproven");
    if (ctx.hasGrokboxPreload(replacement)) return fail("preload-still-present");
    if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed");
    const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
    if (!unique.ok || unique.chain.host.pid !== replacement.pid) return fail("census-invalid");
    if (unique.chain.host.ppid !== unique.chain.supervisor.pid) return fail("not-supervisor-owned");
    if (ctx.readGatewayPid() !== unique.chain.host.pid) return fail("gateway-unproven");
    await ctx.clearAttestation();
    await writeAdoptOpState(ctx.ephemeralRoot, {
      launchMode: "transient-adopt",
      phase: "direct-official",
      tempSupervisor: null,
      adoptingSupervisor: unique.chain.supervisor,
      host: stableOf(unique.chain.host),
    });
    return {
      ok: true,
      recoveryRequired: false,
      signaled: true,
      diskShaBefore: shaBefore,
      diskShaAfter: ctx.diskSha(),
      census: rolesCensus(ctx.processes, ctx.classify),
      coverage: "none",
      host: unique.chain.host,
      launchMode: "transient-adopt",
    };
  } finally {
    await lock.lock.release();
  }
}
