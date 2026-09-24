import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readAttestation, writeAttestation, type CoverageAttestation } from "../io/authority.node.ts";
import { compileReceiptAgrees, expectedCompileReceipt, type CompileReceipt } from "../host/compile-receipt.ts";
import { writeRuntimeArtifact } from "../io/artifacts.node.ts";
import { count, isRecord } from "../io/observation.node.ts";
import type { IdentityMarker, IdentityOpResult } from "./identity-op.ts";
import { operationLockPath, acquireOperationLease } from "../io/operation-lease.node.ts";
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
} from "./process-port.ts";
import type { PatchProfile } from "../host/profile.ts";
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
  failure?: IdentityOpResult["diagnostic"];
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
  waitGone: (old: ProcessIdentity, signal?: AbortSignal) => Promise<boolean>;
  waitReady: (hostPid: number, signal?: AbortSignal) => Promise<IdentityMarker | null>;
  prepareTempLaunch?: (profile: PatchProfile) => Promise<void>;
  /** Coordinator-supplied admission recheck under the operation lock, before arming a guardian. */
  beforeSignal?: BeforeAdoptSignal;
  spawnTempSupervisor: (signal?: AbortSignal) => Promise<ProcessIdentity | null>;
  waitNewHost: (oldHostPid: number, signal?: AbortSignal) => Promise<ProcessIdentity | null>;
  readGatewayPid: () => number | null;
  armGuardian: (frozen: ProcessIdentity[]) => Promise<{ ok: true; release: () => void;
    signal?: AbortSignal; end?: () => "active" | "released" | "expired" | "lost"; dispose?: () => void; continued?: () => boolean | null } | { ok: false }>;
  tempSpawned?: () => boolean;
  childEvidence?: () => NonNullable<IdentityOpResult["diagnostic"]>["child"] | undefined;
  /** Storage port only: the operation owns the marker-derived value and canonical read-back. */
  persistAttestation?: (value: CoverageAttestation, beforePublish: () => void) => Promise<void>;
  modeldReady?: (signal?: AbortSignal) => Promise<boolean>;
  hasGrokboxPreload: (ident: ProcessIdentity) => boolean;
  now: () => number;
  adoptProveMs?: number;
  expectedMode?: "identity" | "route";
};

export async function runTransientAdoptOperation(ctx: TransientAdoptContext): Promise<IdentityOpResult> {
  const shaBefore = ctx.diskSha();
  let signaled = false;
  let complete = false;
  let spawned = false, guardianArmed = false;
  let phase: AdoptOpPhase = "preflight";
  let lifetime: AbortSignal | undefined;
  let guardianEnd: () => "active" | "released" | "expired" | "lost" | "unarmed" = () => "unarmed";
  let dispose: (() => void) | undefined;
  let guardianContinued: () => boolean | null = () => null;
  let ownedTemp: ProcessIdentity | null = null, ownedHost: ProcessIdentity | null = null;
  let lastFailure: IdentityOpResult["diagnostic"];
  const signals: NonNullable<NonNullable<IdentityOpResult["diagnostic"]>["signals"]> = [];
  const cleanup: NonNullable<NonNullable<IdentityOpResult["diagnostic"]>["cleanup"]> = [];
  const reap = (temp: ProcessIdentity | null, host: ProcessIdentity | null) =>
    reapOperationOwned(ctx, temp, host, lifetime, event => { if (signals.length < 8) signals.push(event); },
      result => { if (cleanup.length < 8) cleanup.push(result); });
  const signalOwned = (identity: ProcessIdentity, signal: "SIGSTOP" | "SIGTERM") => {
    assertOwned();
    const result = signalIfMatch(ctx.processes, identity, signal);
    if (signals.length < 8) signals.push({ pid: identity.pid, start: identity.start, signal, sent: result.ok });
    if (result.ok) signaled = true;
    return result;
  };
  const assertOwned = () => { guardianEnd(); if (lifetime?.aborted) throw new Error("guardian-ownership-ended"); };
  const checkpoint = async (root: string, state: AdoptOpState) => {
    assertOwned();
    phase = state.phase!;
    await writeAdoptOpState(root, state);
    assertOwned();
  };
  let committedAttestation: CoverageAttestation | undefined;
  const profile = structuredClone(ctx.reviewedProfile);
  const expectedCompile = expectedCompileReceipt(profile);
  const fail = (code: string, didSignal: boolean, recoveryRequired = true): IdentityOpResult => {
    spawned ||= ctx.tempSpawned?.() === true;
    let marker: IdentityMarker | null = null;
    let child: NonNullable<IdentityOpResult["diagnostic"]>["child"];
    try { marker = ctx.readMarker(); child = ctx.childEvidence?.(); } catch { /* Evidence remains absent. */ }
    const expectedPid = ownedHost?.pid ?? child?.pid;
    const end = guardianEnd();
    lastFailure = {
      code: lifetime?.aborted ? "guardian-ownership-ended" : code,
      phase, recoveryRequired, guardianEnd: end, guardianContinued: guardianContinued(), signals: [...signals], cleanup: [...cleanup],
      ...(child ? { child } : {}),
      ...(expectedPid ? { readiness: { expectedPid, gatewayPid: ctx.readGatewayPid(),
        compiled: marker?.operationId === ctx.operationId && marker.pid === expectedPid && marker.compiled === true,
        alive: !!ctx.processes.inspect(expectedPid) && (!ownedHost || stableIdentitiesMatch(ownedHost, ctx.processes.inspect(expectedPid))) } } : {}),
    };
    return { ok: false, recoveryRequired, code: lastFailure.code!, signaled: signaled || didSignal || lastFailure.guardianContinued === true,
      spawned, guardian: guardianArmed, diagnostic: lastFailure,
      ...(committedAttestation ? { committedAttestation } : {}),
      diskShaBefore: shaBefore, diskShaAfter: failureDiskSha(ctx.diskSha),
      census: failureCensus(ctx.processes, ctx.classify), coverage: signaled || didSignal ? "window-open" : "none",
      launchMode: "transient-adopt" };
  };

  const lock = await acquireOperationLease(operationLockPath(ctx.ephemeralRoot), ctx.operationId);
  if (!lock.ok) return fail("lock-conflict", false, false);

  try {
    const reviewed = loadReviewedProfile(profile, shaBefore);
    if (!reviewed.ok) return fail(reviewed.code, false, false);

    const stale = ctx.readMarker();
    if (stale && stale.operationId !== ctx.operationId) return fail("stale-marker", false, false);

    const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
    let chain = unique.ok ? unique.chain : null;
    if (!chain) {
      const adopted = findAdoptedHostState(ctx.processes, ctx.classify, { gatewayPid: ctx.readGatewayPid() });
      if (!adopted.ok) return fail(unique.ok ? "adopt-unproven" : unique.code === "bad-parentage" ? adopted.code : unique.code, false, false);
      chain = adopted.state;
    }
    const { wrapper, supervisor, host } = chain;

    try {
      await ctx.prepareTempLaunch?.(profile);
      if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed", false, false);
      const admitted = await ctx.beforeSignal?.();
      if (admitted && !admitted.ok) return fail(admitted.code, false, false);
    } catch {
      return fail("launch-preparation-failed", false, false);
    }
    await checkpoint(ctx.ephemeralRoot, {
      launchMode: "transient-adopt", phase: "wrapper-stop", operationId: ctx.operationId,
      tempSupervisor: null, adoptingSupervisor: null, host: stableOf(host),
    });
    const guardian = await ctx.armGuardian([wrapper]);
    if (!guardian.ok) return fail("guardian-not-armed", false, false);
    guardianArmed = true;
    lifetime = guardian.signal;
    guardianEnd = guardian.end ?? (() => released ? "released" : "active");
    dispose = guardian.dispose;
    guardianContinued = guardian.continued ?? (() => null);
    const started = ctx.now();
    let failureCode: string | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      guardian.release();
    };

    try {
      assertOwned();
      if (!signalOwned(wrapper, "SIGSTOP").ok) {
        release();
        return fail("identity-mismatch", false, true);
      }
      signaled = true;
      if (ctx.diskSha() !== shaBefore) {
        release();
        return fail("disk-sha-changed", true, true);
      }
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-old-host",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: stableOf(host),
      });
      if (!signalOwned(host, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-old-supervisor",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: supervisor,
        host: stableOf(host),
      });
      if (!signalOwned(supervisor, "SIGTERM").ok) {
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(host, lifetime))) {
        release();
        return fail("host-still-alive", true, true);
      }
      if (!(await ctx.waitGone(supervisor, lifetime))) {
        release();
        return fail("supervisor-still-alive", true, true);
      }
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "spawn-temp",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: null,
      });
      assertOwned();
      const temp = await ctx.spawnTempSupervisor(lifetime);
      ownedTemp = temp;
      spawned = temp != null || ctx.tempSpawned?.() === true;
      assertOwned();
      if (!temp) {
        release();
        return fail("temp-spawn-failed", true, true);
      }
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "spawn-temp",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: null,
      });
      await ctx.waitNewHost(host.pid, lifetime);
      assertOwned();
      const hosts = ctx.processes.list().filter((ident) => ctx.classify(ident) === "host" && ident.pid !== host.pid);
      const owned = hosts.filter((ident) => ident.ppid === temp.pid);
      const competitors = hosts.filter((ident) => ident.ppid !== temp.pid);
      if (competitors.length > 0) {
        await reap(temp, owned[0] ?? null);
        release();
        return fail("competitor-host", true, true);
      }
      const replacement = owned[0];
      ownedHost = replacement ?? null;
      if (!replacement) {
        await reap(temp, null);
        release();
        return fail("relaunch-failed", true, true);
      }
      const marker = structuredClone(await ctx.waitReady(replacement.pid, lifetime));
      assertOwned();
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
        await reap(temp, replacement);
        release();
        return fail("marker-mismatch", true, true);
      }
      const stableHost = stableOf(replacement);
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "temp-host-ready",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: stableHost,
      });
      const handoffMs = ctx.adoptProveMs ?? 8000;
      if (!(await waitHandoffReady(ctx, replacement.pid, handoffMs, lifetime))) {
        await reap(temp, replacement);
        release();
        return fail("gateway-unproven", true, true);
      }
      if (ctx.diskSha() !== shaBefore) {
        await reap(temp, replacement);
        release();
        return fail("disk-sha-changed", true, true);
      }
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "term-temp",
        operationId: ctx.operationId,
        tempSupervisor: temp,
        adoptingSupervisor: null,
        host: stableHost,
      });
      if (!signalOwned(temp, "SIGTERM").ok) {
        await reap(temp, replacement);
        release();
        return fail("identity-mismatch", true, true);
      }
      if (!(await ctx.waitGone(temp, lifetime))) {
        await reap(null, replacement);
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
        await reap(null, afterTemp);
        release();
        return fail("gateway-unproven", true, true);
      }
      ownedTemp = null;
      ownedHost = null; // Handoff ends child-cleanup authority.
      release();
      await checkpoint(ctx.ephemeralRoot, {
        launchMode: "transient-adopt",
        phase: "await-adopt",
        operationId: ctx.operationId,
        tempSupervisor: null,
        adoptingSupervisor: null,
        host: stableHost,
      });
      const adopted = await waitAdopted(ctx, wrapper, stableHost, ctx.adoptProveMs ?? 8000, lifetime);
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
        assertOwned();
        if (expectedMode === "route" && ctx.modeldReady && !await ctx.modeldReady(lifetime)) return "modeld_not_ready";
        assertOwned();
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
      await checkpoint(ctx.ephemeralRoot, journal);
      const atCommit = await finalCheck();
      if (atCommit) return fail(atCommit, true);
      let persistFailed = false;
      try {
        await (ctx.persistAttestation ?? ((value, beforePublish) => writeAttestation(ctx.ephemeralRoot, value, beforePublish)))(structuredClone(proposed), assertOwned);
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
      await checkpoint(ctx.ephemeralRoot, done);
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
        signaled: true, spawned, guardian: guardianArmed,
        diagnostic: { code: null, phase: "attested", recoveryRequired: false, guardianEnd: guardianEnd(), guardianContinued: guardianContinued(), signals: [...signals] },
        diskShaBefore: shaBefore,
        diskShaAfter: shaAfter,
        census,
        coverage: "attested",
        host: adopted.host,
        windowMs,
        launchMode: "transient-adopt",
        committedAttestation,
      };
    } catch {
      // A child can have appeared during an interrupted spawn/new-host wait.
      // Capture only a child of the exact supervisor lifetime still owned here.
      if (!ownedHost && ownedTemp && stableIdentitiesMatch(ownedTemp, ctx.processes.inspect(ownedTemp.pid))) {
        const children = ctx.processes.list().filter(row => row.ppid === ownedTemp!.pid && ctx.classify(row) === "host");
        if (children.length === 1) ownedHost = children[0]!;
      }
      try { await reap(ownedTemp, ownedHost); }
      catch { failureCode = "owned-cleanup-unproven"; }
      release();
      return fail(failureCode ?? "adopt-stage-failed", signaled, signaled);
    }
  } catch {
    return fail("adopt-persistence-failed", signaled, signaled);
  } finally {
    dispose?.();
    if (signaled && !complete) {
      try {
        const journal = await readAdoptOpState(ctx.ephemeralRoot);
        await writeAdoptOpState(ctx.ephemeralRoot, {
          launchMode: "transient-adopt", tempSupervisor: null, adoptingSupervisor: null, host: null,
          ...journal, phase: "recovery-required", operationId: ctx.operationId, failure: lastFailure,
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
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (!signal?.aborted && Date.now() - start < ms) {
    if (
      canHandoffAdopt({
        gatewayPid: ctx.readGatewayPid(),
        hostPid,
        hostAlive: ctx.processes.inspect(hostPid) != null,
      })
    ) {
      return true;
    }
    await delay(50, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error; });
  }
  if (signal?.aborted) return false;
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
    if (liveTemp && stableIdentitiesMatch(temp, liveTemp) && live.ppid === liveTemp.pid) return true;
    if (!liveTemp && ctx.hasGrokboxPreload(live)) return true;
    return false;
  }
  return ctx.hasGrokboxPreload(live);
}

async function reapOperationOwned(
  ctx: TransientAdoptContext,
  temp: ProcessIdentity | null,
  host: ProcessIdentity | null,
  signal?: AbortSignal,
  record?: (event: { pid: number; start: number; signal: "SIGTERM"; sent: boolean }) => void,
  recordCleanup?: (result: NonNullable<NonNullable<IdentityOpResult["diagnostic"]>["cleanup"]>[number]) => void,
): Promise<void> {
  for (const [role, expected] of [["host", host], ["temp-supervisor", temp]] as const) {
    if (!expected) continue;
    const result: NonNullable<NonNullable<IdentityOpResult["diagnostic"]>["cleanup"]>[number] = {
      role, pid: expected.pid, start: expected.start, signalSent: false, outcome: "unproven", observed: "unavailable",
    };
    try {
      const before = ctx.processes.inspect(expected.pid);
      if (!before) { result.observed = "absent"; result.outcome = "confirmed-gone"; continue; }
      result.observed = stableIdentitiesMatch(expected, before) ? "same-identity" : "different-identity";
      if (result.observed !== "same-identity" || role === "host" && !isOperationOwnedHost(ctx, temp, expected)) continue;
      // A Host may have reparented after its exact temp owner exited. Full
      // identity is still rechecked at the syscall; a reused PID is never used.
      const sent = signalIfMatch(ctx.processes, role === "host" ? before : expected, "SIGTERM");
      result.signalSent = sent.ok;
      record?.({ pid: expected.pid, start: expected.start, signal: "SIGTERM", sent: sent.ok });
      const waited = await ctx.waitGone(expected, signal);
      const after = ctx.processes.inspect(expected.pid);
      result.observed = !after ? "absent" : stableIdentitiesMatch(expected, after) ? "same-identity" : "different-identity";
      // Expiry cancels the existing wait; it is not an exit receipt. Do not
      // renew ownership or hide the still-live child behind a completed scope.
      if (waited && result.observed !== "same-identity") result.outcome = "confirmed-gone";
    } catch { result.observed = "unavailable"; }
    finally { recordCleanup?.(result); }
  }
}

async function waitAdopted(
  ctx: TransientAdoptContext,
  wrapper: ProcessIdentity,
  expectedHost: StableProcessIdentity,
  ms: number,
  signal?: AbortSignal,
): Promise<OfficialChain | null> {
  const start = Date.now();
  while (!signal?.aborted && Date.now() - start < ms) {
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
    await delay(50, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error; });
  }
  if (signal?.aborted) return null;
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
  waitGone: (old: ProcessIdentity, signal?: AbortSignal) => Promise<boolean>;
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
    if (!replacement || replacement.pid === live.pid) {
      const uniqueGone = findUniqueOfficialChain(ctx.processes, ctx.classify);
      if (
        uniqueGone.ok &&
        uniqueGone.chain.host.pid !== live.pid &&
        !ctx.hasGrokboxPreload(uniqueGone.chain.host) &&
        ctx.readGatewayPid() !== uniqueGone.chain.host.pid
      ) {
        return fail("replacement-gateway-unproven");
      }
      return fail("replacement-unproven");
    }
    if (ctx.hasGrokboxPreload(replacement)) return fail("preload-still-present");
    if (ctx.diskSha() !== shaBefore) return fail("disk-sha-changed");
    const unique = findUniqueOfficialChain(ctx.processes, ctx.classify);
    if (!unique.ok || unique.chain.host.pid !== replacement.pid) return fail("census-invalid");
    if (unique.chain.host.ppid !== unique.chain.supervisor.pid) return fail("not-supervisor-owned");
    if (ctx.readGatewayPid() !== unique.chain.host.pid) return fail("replacement-gateway-unproven");
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
