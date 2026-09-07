import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readAttestation, writeAttestation, type CoverageAttestation } from "./attestation.ts";
import { compileReceiptAgrees, expectedCompileReceipt, type CompileReceipt } from "./compile-receipt.ts";
import { writeRuntimeArtifact } from "./runtime-artifact.ts";
import { count, isRecord } from "./observation.ts";
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
import type { H3LaunchStrategy } from "./launch-strategy.ts";

const ADOPT_OP_PHASES = [
  "preflight", "wrapper-stop", "term-old-host", "term-old-supervisor", "spawn-temp", "temp-host-ready",
  "term-temp", "await-adopt", "commit-attestation", "attested", "deactivate-preflight", "deactivate-term",
  "direct-official", "recovery-required",
] as const;
export type AdoptOpPhase = (typeof ADOPT_OP_PHASES)[number];

export type AdoptOpState = {
  launchMode: "transient-adopt";
  phase?: AdoptOpPhase;
  operationId?: string;
  compile?: CompileReceipt;
  tempSupervisor: ProcessIdentity | null;
  adoptingSupervisor: ProcessIdentity | null;
  host: StableProcessIdentity | null;
};

const DONE_PHASES = new Set<AdoptOpPhase>(["attested", "direct-official"]);

/** Observation parser: malformed or legacy phase-less journals are unknown, not settled. */
export function parseAdoptOpState(value: unknown): AdoptOpState {
  if (!isRecord(value) || value.launchMode !== "transient-adopt" || !(ADOPT_OP_PHASES as readonly unknown[]).includes(value.phase)) {
    throw new Error("invalid adopt journal");
  }
  for (const key of ["host", "tempSupervisor", "adoptingSupervisor"]) {
    const identity = value[key];
    if (identity !== null && (!isRecord(identity) || !count(identity.pid) || identity.pid === 0 || !count(identity.start))) {
      throw new Error("invalid journal identity");
    }
  }
  if ((value.phase === "attested" || value.phase === "direct-official") && (!value.host || !value.adoptingSupervisor)) {
    throw new Error("incomplete settled journal");
  }
  return value as AdoptOpState;
}

export function adoptJournalNeedsRecovery(state: AdoptOpState | null): boolean {
  if (!state) return false;
  if (state.tempSupervisor) return true;
  if (state.phase === "recovery-required") return true;
  if (state.phase && !DONE_PHASES.has(state.phase)) return true;
  return false;
}

/** Complete a stuck journal when its host is gone, no temp owner remains, and a unique official chain is gateway-proven. */
export function settleStaleAdoptJournal(input: {
  state: AdoptOpState | null;
  inspect: (pid: number) => ProcessIdentity | null;
  uniqueHost: ProcessIdentity | null;
  uniqueSupervisor: ProcessIdentity | null;
  gatewayPid: number | null;
}): AdoptOpState | null {
  const state = input.state;
  if (!state || !adoptJournalNeedsRecovery(state) || state.phase === "recovery-required" || state.phase === "commit-attestation") return state;
  if (state.tempSupervisor) {
    const temp = input.inspect(state.tempSupervisor.pid);
    if (temp && temp.start === state.tempSupervisor.start) return state;
  }
  if (state.host) {
    const live = input.inspect(state.host.pid);
    if (live && live.start === state.host.start) return state;
  }
  if (!input.uniqueHost || !input.uniqueSupervisor) return state;
  if (input.gatewayPid !== input.uniqueHost.pid) return state;
  return {
    launchMode: "transient-adopt",
    phase: "direct-official",
    tempSupervisor: null,
    adoptingSupervisor: input.uniqueSupervisor,
    host: stableOf(input.uniqueHost),
  };
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
  await writeRuntimeArtifact(adoptOpStatePath(root), state);
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

function failureDiskSha(read: () => string): string {
  try { return read(); } catch { return "none"; }
}

function failureCensus(processes: ProcessPort, classify: RoleClassifier) {
  try { return rolesCensus(processes, classify); }
  catch { return { wrapper: 0, supervisor: 0, host: 0, tempSupervisor: 0, guardian: 0, extras: 0 }; }
}

export type AdoptTargetPorts = {
  readSource: () => string;
  launchStrategy: (supervisor: ProcessIdentity) => H3LaunchStrategy;
};

export type BeforeAdoptSignal = () => Promise<{ ok: true } | { ok: false; code: string }>;

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
  prepareTempLaunch?: (profile: PatchProfile) => Promise<void>;
  /** Coordinator-supplied admission recheck under the operation lock, before arming a guardian. */
  beforeSignal?: BeforeAdoptSignal;
  spawnTempSupervisor: () => Promise<ProcessIdentity | null>;
  waitNewHost: (oldHostPid: number) => Promise<ProcessIdentity | null>;
  readGatewayPid: () => number | null;
  armGuardian: (frozen: ProcessIdentity[]) => Promise<{ ok: true; release: () => void } | { ok: false }>;
  /** Storage port only: the operation owns the marker-derived value and canonical read-back. */
  persistAttestation?: (value: CoverageAttestation) => Promise<void>;
  modeldReady?: () => Promise<boolean>;
  hasGrokboxPreload: (ident: ProcessIdentity) => boolean;
  now: () => number;
  adoptProveMs?: number;
  expectedMode?: "identity" | "route";
};

export async function runTransientAdoptOperation(ctx: TransientAdoptContext): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  let signaled = false;
  let complete = false;
  let committedAttestation: CoverageAttestation | undefined;
  const profile = structuredClone(ctx.reviewedProfile);
  const expectedCompile = expectedCompileReceipt(profile);
  const fail = (code: string, didSignal: boolean, recoveryRequired = true): IdentityOpResult => ({
    ok: false,
    recoveryRequired,
    code,
    signaled: signaled || didSignal,
    ...(committedAttestation ? { committedAttestation } : {}),
    diskShaBefore: shaBefore,
    diskShaAfter: failureDiskSha(ctx.diskSha),
    census: failureCensus(ctx.processes, ctx.classify),
    coverage: signaled || didSignal ? "window-open" : "none",
    launchMode: "transient-adopt",
  });

  const lock = await acquireExclusiveLock(operationLockPath(ctx.ephemeralRoot));
  if (!lock.ok) return fail("lock-conflict", false, false);

  try {
    const reviewed = loadReviewedProfile(profile, shaBefore);
    if (!reviewed.ok) return fail(reviewed.code, false, false);

    const stale = ctx.readMarker();
    if (stale && stale.operationId !== ctx.operationId) return fail("stale-marker", false, false);

    const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
    if (!unique.ok) return fail(unique.code, false, false);
    const { wrapper, supervisor, host } = unique.chain;

    try {
      await ctx.prepareTempLaunch?.(profile);
      if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed", false, false);
      const admitted = await ctx.beforeSignal?.();
      if (admitted && !admitted.ok) return fail(admitted.code, false, false);
    } catch {
      return fail("launch-preparation-failed", false, false);
    }
    await writeAdoptOpState(ctx.ephemeralRoot, {
      launchMode: "transient-adopt", phase: "wrapper-stop", operationId: ctx.operationId,
      tempSupervisor: null, adoptingSupervisor: null, host: stableOf(host),
    });
    const guardian = await ctx.armGuardian([wrapper]);
    if (!guardian.ok) return fail("guardian-not-armed", false, false);
    const started = ctx.now();
    let failureCode: string | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signaled = true; // Guardian release can emit CONT, including a failed STOP attempt.
      guardian.release();
    };

    try {
      if (!signalIfMatch(ctx.processes, wrapper, "SIGSTOP").ok) {
        release();
        return fail("identity-mismatch", false, true);
      }
      signaled = true;
      if (ctx.diskSha() !== shaBefore) {
        release();
        return fail("disk-sha-changed", true, true);
      }
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
      const marker = structuredClone(await ctx.waitReady(replacement.pid));
      const expectedMode = ctx.expectedMode ?? "identity";
      if (
        !marker ||
        marker.operationId !== ctx.operationId ||
        marker.pid !== replacement.pid ||
        marker.start !== replacement.start ||
        marker.mode !== expectedMode ||
        marker.transformed !== true ||
        marker.compiled !== true ||
        marker.modeld !== false ||
        !compileReceiptAgrees(marker.compile, expectedCompile)
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
      const shaAfter = ctx.diskSha();
      const windowMs = Math.max(0, ctx.now() - started);
      const finalCheck = async (): Promise<string | null> => {
        if (expectedMode === "route" && !await ctx.modeldReady?.()) return "modeld_not_ready";
        if (ctx.diskSha() !== shaBefore) return "disk-sha-changed";
        const current = findAdoptedHostState(ctx.processes, ctx.classify, {
          gatewayPid: ctx.readGatewayPid(), expectedHost: stableHost,
        });
        if (!current.ok) return current.code;
        if (!ctx.hasGrokboxPreload(current.state.host) || ctx.hasGrokboxPreload(current.state.supervisor)) return "preload-mismatch";
        return null;
      };
      const beforeCommit = await finalCheck();
      if (beforeCommit) return fail(beforeCommit, true);
      const { profileId, profileSha256, sourceSha256, transformedSha256 } = marker.compile!;
      const compile = { profileId, profileSha256, sourceSha256, transformedSha256 };
      const base = {
        coverage: "attested" as const, diskSha: compile.sourceSha256, pid: adopted.host.pid,
        start: adopted.host.start, identity: adopted.host, at: new Date(ctx.now()).toISOString(),
        windowMs, launchMode: "transient-adopt" as const, operationId: ctx.operationId,
        profileId: compile.profileId, transformedSha: compile.transformedSha256, compile,
      };
      const proposed: CoverageAttestation = expectedMode === "route"
        ? { ...base, mode: "route", modeld: true }
        : { ...base, mode: "identity", modeld: false };
      const journal: AdoptOpState = {
        launchMode: "transient-adopt", phase: "commit-attestation", operationId: ctx.operationId, compile,
        tempSupervisor: null, adoptingSupervisor: adopted.supervisor, host: stableHost,
      };
      failureCode = "attestation-persist-failed";
      await writeAdoptOpState(ctx.ephemeralRoot, journal);
      const atCommit = await finalCheck();
      if (atCommit) return fail(atCommit, true);
      let persistFailed = false;
      try {
        await (ctx.persistAttestation ?? ((value) => writeAttestation(ctx.ephemeralRoot, value)))(structuredClone(proposed));
      } catch {
        persistFailed = true;
      }
      const record = await readAttestation(ctx.ephemeralRoot);
      if (!isDeepStrictEqual(record, proposed)) return fail("attestation-uncommitted", true);
      committedAttestation = record!;
      if (persistFailed) return fail("attestation-persist-failed", true);
      const afterCommit = await finalCheck();
      if (afterCommit) return fail(afterCommit, true);
      const done: AdoptOpState = { ...journal, phase: "attested" };
      failureCode = "journal-persist-failed";
      await writeAdoptOpState(ctx.ephemeralRoot, done);
      if (!isDeepStrictEqual(await readAdoptOpState(ctx.ephemeralRoot), done)) return fail("journal-uncommitted", true);
      committedAttestation = undefined;
      const finalRecord = await readAttestation(ctx.ephemeralRoot);
      if (!isDeepStrictEqual(finalRecord, proposed)) return fail("attestation-uncommitted", true);
      committedAttestation = finalRecord!;
      const afterReadBack = await finalCheck();
      if (afterReadBack) return fail(afterReadBack, true);
      complete = true;
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
        committedAttestation,
      };
    } catch (error) {
      release();
      return fail(failureCode ?? (error instanceof Error ? error.message : "inject-error"), true, true);
    }
  } catch {
    return fail("adopt-persistence-failed", signaled, signaled);
  } finally {
    if (signaled && !complete) {
      try {
        const journal = await readAdoptOpState(ctx.ephemeralRoot);
        await writeAdoptOpState(ctx.ephemeralRoot, {
          launchMode: "transient-adopt", tempSupervisor: null, adoptingSupervisor: null, host: null,
          ...journal, phase: "recovery-required",
        });
      } catch { /* An unreadable/pending journal remains fail-closed. */ }
    }
    try { await lock.lock.release(); }
    catch { return fail("operation-lock-release-failed", signaled); }
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
  /** Relax only attestation-vs-live SHA equality. Fresh SHA must still be stable. */
  allowStaleAttestedSha?: boolean;
  beforeSignal?: BeforeAdoptSignal;
};

export async function runTransientAdoptDeactivate(
  ctx: TransientAdoptDeactivateContext,
): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  let signaled = false;
  const fail = (code: string, didSignal = signaled): IdentityOpResult => ({
    ok: false,
    recoveryRequired: true,
    code,
    signaled: didSignal,
    diskShaBefore: shaBefore,
    diskShaAfter: failureDiskSha(ctx.diskSha),
    census: failureCensus(ctx.processes, ctx.classify),
    coverage: didSignal ? "window-open" : "none",
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
    if (ctx.diskSha() !== shaBefore) {
      return fail("disk-sha-changed", false);
    }
    if (shaBefore !== ctx.attestation.diskSha && ctx.allowStaleAttestedSha !== true) {
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
    try {
      const admitted = await ctx.beforeSignal?.();
      if (admitted && !admitted.ok) return fail(admitted.code, false);
    } catch {
      return fail("target-admission-failed", false);
    }
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
    signaled = true;
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
  } catch {
    return fail("deactivate-persistence-failed");
  } finally {
    try { await lock.lock.release(); }
    catch { return fail("operation-lock-release-failed"); }
  }
}
