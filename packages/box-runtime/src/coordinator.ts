import { isDeepStrictEqual } from "node:util";
import { clearAttestation, readAttestation, routeAttestationAgrees, type CoverageAttestation } from "./attestation.ts";
import { writeRuntimeArtifact } from "./runtime-artifact.ts";
import { observeCoordinatorState, type CoordinatorState } from "./coordinator-state.ts";
export type { CoordinatorState } from "./coordinator-state.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { BoxRuntimeError } from "./errors.ts";
import { appendEvent, compactEvents } from "./events.ts";
import { canonicalOwnershipAgrees, type IdentityOpResult } from "./identity-op.ts";
import { inspectPid, linuxProcessPort, roleOf } from "./live-proc.ts";
import { probeStubModeld } from "./modeld-ipc.ts";
import { routeHasNonStubAssignment, type DesiredFile, type ModelsFile } from "./models.ts";
import { projectLiveStatus, type HostOrigin } from "./observe.ts";
import { findAdoptedHostState, findUniqueOfficialChain, loadReviewedProfile, waitOfficialReplacement, type RoleClassifier } from "./official-chain.ts";
import { loadDurableReviewedProfile, validateReviewedProfile } from "./reviewed-profile.ts";
import { acquireCoordinatorLease, coordinatorLeasePath, type LeaseOwner } from "./op-lock.ts";
import { coordinatorStatePath } from "./paths.ts";
import { countRoles, identitiesMatch, readOnlyProcessPort, singleOfficialChain, type ProcessIdentity, type ProcessPort } from "./process.ts";
import {
  adoptJournalNeedsRecovery,
  readAdoptOpState,
  settleStaleAdoptJournal,
  runTransientAdoptDeactivate,
  runTransientAdoptOperation,
  writeAdoptOpState,
  type TransientAdoptContext,
  type AdoptTargetPorts,
} from "./transient-adopt.ts";
import type { PatchProfile } from "./transform.ts";

export const WATCHDOG_OPERATION_ID = "watchdog-identity";
export const WATCHDOG_MUTATION_BUDGET = 2;

export type WatchdogReconcile = "converged" | "pending" | "blocked" | "recovery-required";

export type WatchdogTickResult = {
  reconcile: WatchdogReconcile;
  reason: string | null;
  attemptKey: string | null;
  signaled: boolean;
  injected: boolean;
  circuit: "closed" | "open";
  watchdogState: "idle" | "running" | "degraded";
  origin: HostOrigin;
  committedAttestation?: CoverageAttestation;
};

export type WatchdogAdoptPorts = Pick<
  TransientAdoptContext,
  | "spawnTempSupervisor"
  | "waitNewHost"
  | "waitGone"
  | "waitReady"
  | "armGuardian"
  | "hasGrokboxPreload"
  | "readGatewayPid"
  | "persistAttestation"
  | "prepareTempLaunch"
  | "adoptProveMs"
> & {
  /** Read-only source/capability facts; absence cannot authorize a mutation. */
  target?: AdoptTargetPorts;
};

export type LegacyWitness = {
  identity: ProcessIdentity;
};

export type WatchdogTickInput = {
  root: string;
  desired: DesiredFile;
  models: ModelsFile;
  ephemeralRoot?: string;
  processes?: ProcessPort;
  classify?: RoleClassifier;
  envHas?: (pid: number, key: string) => boolean;
  diskSha?: string | null;
  gatewayPid?: number | null;
  freshDiskSha?: () => string;
  reviewedProfile?: PatchProfile;
  adopt?: WatchdogAdoptPorts;
  waitReplacement?: (oldPid: number) => Promise<ProcessIdentity | null>;
  legacyWitness?: LegacyWitness;
  operationId?: string;
  inspectLeaseOwner?: (pid: number) => LeaseOwner | null;
  selfLease?: LeaseOwner;
  now: () => number;
  isoNow?: () => string;
  confirmed?: boolean;
  modeldReady?: () => boolean | Promise<boolean>;
};

const EMPTY_STATE: CoordinatorState = {
  version: 1,
  circuit: "closed",
  mutationCount: 0,
  attemptedKeys: [],
};

function attemptKey(mode: DesiredFile["mode"], host: ProcessIdentity, sha: string | null): string {
  return `${mode}:${host.pid}:${host.start}:${sha ?? "none"}`;
}

function defaultLeaseOwner(pid: number): LeaseOwner | null {
  const ident = inspectPid(pid);
  return ident ? { pid: ident.pid, start: ident.start, uid: ident.uid } : null;
}

async function loadState(root: string): Promise<CoordinatorState> {
  const observed = await observeCoordinatorState(root);
  if (observed.state === "present") return observed.value;
  if (observed.state === "missing") return { ...EMPTY_STATE, attemptedKeys: [] };
  throw new Error("coordinator-state-unavailable");
}

async function saveState(root: string, state: CoordinatorState): Promise<void> {
  await writeRuntimeArtifact(coordinatorStatePath(root), state);
}

function resultOf(
  state: CoordinatorState,
  origin: HostOrigin,
  partial: Omit<WatchdogTickResult, "circuit" | "origin">,
): WatchdogTickResult {
  return { ...partial, circuit: state.circuit, origin };
}

function resolveFreshSha(input: WatchdogTickInput): () => string {
  if (input.freshDiskSha) return input.freshDiskSha;
  if (typeof input.diskSha === "string") return () => input.diskSha as string;
  if (input.diskSha === null) return () => "none";
  return () => "none";
}

async function resolveModeldReady(input: WatchdogTickInput, ephemeralRoot: string): Promise<boolean> {
  if (input.modeldReady) return await input.modeldReady();
  return await probeStubModeld(ephemeralRoot);
}

function reviewedIdentityForRoute(input: WatchdogTickInput): PatchProfile | undefined {
  return input.reviewedProfile ?? loadDurableReviewedProfile(input.root);
}

function mutationBudgetGate(
  state: CoordinatorState,
  key: string,
  manualFresh: boolean,
): null | {
  save: boolean;
  state: CoordinatorState;
  event?: string;
  result: Omit<WatchdogTickResult, "circuit" | "origin">;
} {
  if (state.attemptedKeys.includes(key)) {
    const blocked = state.circuit === "open";
    return {
      save: false,
      state,
      result: {
        reconcile: blocked ? "blocked" : "converged",
        reason: blocked ? "circuit_open" : "generation_attempted",
        attemptKey: key,
        signaled: false,
        injected: false,
        watchdogState: blocked ? "degraded" : "idle",
      },
    };
  }
  if (state.mutationCount >= WATCHDOG_MUTATION_BUDGET && !manualFresh) {
    const next = { ...state, circuit: "open" as const, circuitReason: "mutation_budget", lastAttemptKey: key };
    return {
      save: true,
      state: next,
      event: "mutation_budget",
      result: {
        reconcile: "blocked",
        reason: "mutation_budget",
        attemptKey: key,
        signaled: false,
        injected: false,
        watchdogState: "degraded",
      },
    };
  }
  return null;
}

type TargetContext = {
  ephemeralRoot: string;
  processes: ProcessPort;
  classify: RoleClassifier;
  freshDiskSha: () => string;
  liveHost: ProcessIdentity;
  sha: string | null;
  origin: HostOrigin;
};

/** Reused before refresh/deactivate and under the operation lock before the first signal. */
async function preflightNextTarget(input: WatchdogTickInput, ctx: TargetContext): Promise<
  { ok: true; profile: PatchProfile } | { ok: false; code: string }
> {
  try {
    const adopt = input.adopt;
    if (!input.reviewedProfile) return { ok: false, code: "missing_reviewed_profile" };
    if (!adopt) return { ok: false, code: "mutation_ports_unavailable" };
    const reviewed = loadReviewedProfile(input.reviewedProfile, ctx.sha ?? "none");
    if (!reviewed.ok) return reviewed;
    if (ctx.freshDiskSha() !== ctx.sha) return { ok: false, code: "disk-sha-changed" };
    if (adoptJournalNeedsRecovery(await readAdoptOpState(ctx.ephemeralRoot))) {
      return { ok: false, code: "pending-uncertain" };
    }
    const census = countRoles(ctx.processes.list().flatMap((ident) => {
      const role = ctx.classify(ident);
      return role ? [{ ...ident, role }] : [];
    }));
    if (!singleOfficialChain(census)) return { ok: false, code: "census-invalid" };
    if (!identitiesMatch(ctx.liveHost, ctx.processes.inspect(ctx.liveHost.pid))) {
      return { ok: false, code: "identity-mismatch" };
    }
    const gatewayPid = adopt.readGatewayPid();
    if (gatewayPid !== ctx.liveHost.pid) return { ok: false, code: "gateway-mismatch" };
    let supervisor: ProcessIdentity;
    let wrapper: ProcessIdentity;
    if (ctx.origin === "grokbox-attested" || (ctx.origin === "grokbox-unattested" && input.legacyWitness)) {
      if (ctx.origin === "grokbox-attested") {
        const att = await readAttestation(ctx.ephemeralRoot);
        if (!canonicalOwnershipAgrees({ attestation: att, liveHost: ctx.liveHost, census }) ||
          att?.pid !== ctx.liveHost.pid || att.start !== ctx.liveHost.start) {
          return { ok: false, code: "identity-mismatch" };
        }
      } else if (!identitiesMatch(input.legacyWitness!.identity, ctx.liveHost)) {
        return { ok: false, code: "identity-mismatch" };
      }
      const found = findAdoptedHostState(ctx.processes, ctx.classify, { gatewayPid, expectedHost: ctx.liveHost });
      if (!found.ok) return found;
      if (!adopt.hasGrokboxPreload(found.state.host)) return { ok: false, code: "preload-missing" };
      ({ supervisor, wrapper } = found.state);
    } else if (ctx.origin === "official") {
      const found = findUniqueOfficialChain(ctx.processes, ctx.classify);
      if (!found.ok) return found;
      if (!identitiesMatch(ctx.liveHost, found.chain.host)) return { ok: false, code: "identity-mismatch" };
      if (adopt.hasGrokboxPreload(found.chain.host)) return { ok: false, code: "unmanaged_preload" };
      ({ supervisor, wrapper } = found.chain);
    } else return { ok: false, code: "ownership-unproven" };
    if (adopt.hasGrokboxPreload(supervisor) || adopt.hasGrokboxPreload(wrapper)) {
      return { ok: false, code: "supervisor-preloaded" };
    }
    if (!adopt.target) return { ok: false, code: "target-admission-unavailable" };
    if (adopt.target.launchStrategy(supervisor) !== "transient-adopt-candidate") {
      return { ok: false, code: "launch-strategy-unavailable" };
    }
    const validated = validateReviewedProfile(input.reviewedProfile, adopt.target.readSource());
    if (!validated.ok) return validated;
    if (ctx.freshDiskSha() !== ctx.sha) return { ok: false, code: "disk-sha-changed" };
    if (input.desired.mode === "route") {
      if (!input.models.assignments.main) return { ok: false, code: "missing_main_assignment" };
      if (routeHasNonStubAssignment(input.models)) return { ok: false, code: "non_stub_assignment" };
      if (!await resolveModeldReady(input, ctx.ephemeralRoot)) return { ok: false, code: "modeld_not_ready" };
    }
    return validated;
  } catch {
    return { ok: false, code: "target-admission-failed" };
  }
}

type PreparedTarget = WatchdogTickInput & { reviewedProfile: PatchProfile; adopt: WatchdogAdoptPorts };

async function prepareNextTarget(input: WatchdogTickInput, ctx: TargetContext): Promise<
  { ok: true; input: PreparedTarget } | { ok: false; code: string }
> {
  const checked = await preflightNextTarget(input, ctx);
  if (!checked.ok) return checked;
  const adopt = input.adopt!;
  try {
    await adopt.prepareTempLaunch?.(structuredClone(checked.profile));
  } catch {
    return { ok: false, code: "launch-preparation-failed" };
  }
  return { ok: true, input: {
    ...input, reviewedProfile: checked.profile, adopt: { ...adopt, prepareTempLaunch: undefined },
  } };
}

function refusedTarget(state: CoordinatorState, origin: HostOrigin, key: string, reason: string): WatchdogTickResult {
  return resultOf(state, origin, {
    reconcile: "recovery-required", reason, attemptKey: key,
    signaled: false, injected: false, watchdogState: "degraded",
  });
}

async function waitDirectOfficialReplacement(
  input: WatchdogTickInput,
  processes: ProcessPort,
  classify: RoleClassifier,
  oldPid: number,
): Promise<ProcessIdentity | null> {
  if (input.waitReplacement) return await input.waitReplacement(oldPid);
  const adopt = input.adopt;
  if (!adopt) return null;
  return await waitOfficialReplacement({
    oldPid,
    processes,
    classify,
    hasGrokboxPreload: (host) => adopt.hasGrokboxPreload(host),
    readGatewayPid: () => adopt.readGatewayPid(),
    budgetMs: adopt.adoptProveMs ?? 8000,
  });
}

type AttemptProgress = {
  signaled: boolean;
  injected: boolean;
  attemptKey: string | null;
  committedAttestation?: CoverageAttestation;
};

function recordOperation(progress: AttemptProgress, result: IdentityOpResult, key: string | null): void {
  progress.signaled ||= result.signaled;
  progress.injected ||= result.ok && result.coverage === "attested";
  if (result.signaled) progress.attemptKey ??= key;
  if (result.committedAttestation) progress.committedAttestation = result.committedAttestation;
}

async function runAttestedRefresh(
  input: WatchdogTickInput,
  ctx: {
    progress: AttemptProgress;
    state: CoordinatorState;
    ephemeralRoot: string;
    processes: ProcessPort;
    classify: RoleClassifier;
    freshDiskSha: () => string;
    iso: () => string;
    operationId?: string;
    liveHost: ProcessIdentity;
    sha: string | null;
    origin: HostOrigin;
  },
): Promise<WatchdogTickResult> {
  let { state } = ctx;
  const { ephemeralRoot, processes, classify, freshDiskSha, iso, liveHost, sha, origin } = ctx;
  const key = attemptKey(input.desired.mode, liveHost, sha);
  const liveSha = typeof sha === "string" && sha.length > 0 ? sha : freshDiskSha();

  if (!input.reviewedProfile) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: "missing_reviewed_profile",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }
  const reviewed = loadReviewedProfile(input.reviewedProfile, liveSha);
  if (!reviewed.ok) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: reviewed.code,
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }
  if (!input.adopt) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: "mutation_ports_unavailable",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }

  const budgetGate = mutationBudgetGate(state, key, true);
  if (budgetGate) {
    if (budgetGate.save) {
      state = budgetGate.state;
      await saveState(input.root, state);
      if (budgetGate.event) {
        await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: budgetGate.event });
      }
    } else {
      await saveState(input.root, state);
    }
    return resultOf(state, origin, budgetGate.result);
  }

  const prepared = await prepareNextTarget(input, ctx);
  if (!prepared.ok) return refusedTarget(state, origin, key, prepared.code);
  const nextInput = prepared.input;

  const att = await readAttestation(ephemeralRoot);
  if (!att) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "recovery-required",
      reason: "no-attestation",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "degraded",
    });
  }

  const deact = await runTransientAdoptDeactivate({
    processes,
    classify,
    diskSha: freshDiskSha,
    ephemeralRoot,
    attestation: att,
    waitGone: input.adopt.waitGone,
    waitReplacement: (oldPid) => waitDirectOfficialReplacement(input, processes, classify, oldPid),
    hasGrokboxPreload: input.adopt.hasGrokboxPreload,
    readGatewayPid: input.adopt.readGatewayPid,
    clearAttestation: async () => {
      await clearAttestation(ephemeralRoot);
    },
    allowStaleAttestedSha: input.desired.mode === "identity",
    beforeSignal: () => preflightNextTarget(nextInput, ctx),
  });

  recordOperation(ctx.progress, deact, key);
  if (!deact.ok && !deact.signaled) return refusedTarget(state, origin, key, deact.code ?? "deactivate_failed");
  if (deact.signaled) {
    state = {
      ...state,
      attemptedKeys: [...state.attemptedKeys.filter((entry) => entry !== key), key].slice(-32),
      lastAttemptKey: key,
    };
  }
  if (!deact.ok) {
    state = {
      ...state,
      circuit: "open",
      circuitReason: deact.code,
      mutationCount: state.mutationCount + (deact.signaled ? 1 : 0),
    };
    await saveState(input.root, state);
    await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: deact.code ?? "deactivate_failed" });
    return resultOf(state, origin, {
      reconcile: "recovery-required",
      reason: deact.code ?? "deactivate_failed",
      attemptKey: key,
      signaled: deact.signaled,
      injected: false,
      watchdogState: "degraded",
    });
  }

  state = {
    ...state,
    mutationCount: state.mutationCount + (deact.signaled ? 1 : 0),
  };
  await saveState(input.root, state);
  const next = await runWatchdogTickBody({ ...nextInput, confirmed: true }, ctx.progress);
  return { ...next, attemptKey: key, signaled: deact.signaled || next.signaled };
}

async function withCoordinatorLease<T>(
  input: WatchdogTickInput,
  ephemeralRoot: string,
  body: () => Promise<T>,
): Promise<T | WatchdogTickResult> {
  const inspect = input.inspectLeaseOwner ?? defaultLeaseOwner;
  const self = input.selfLease ?? inspect(process.pid) ?? { pid: process.pid, start: 0, uid: 0 };
  const lease = await acquireCoordinatorLease({
    path: coordinatorLeasePath(ephemeralRoot),
    self,
    inspect,
  });
  if (!lease.ok) {
    return {
      reconcile: "blocked",
      reason: "lock-conflict",
      attemptKey: null,
      signaled: false,
      injected: false,
      circuit: "closed",
      watchdogState: "idle",
      origin: "ambiguous",
    };
  }
  try {
    return await body();
  } finally {
    await lease.lock.release();
  }
}

async function runWatchdogTickBody(input: WatchdogTickInput, progress: AttemptProgress): Promise<WatchdogTickResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const processes = input.processes ?? readOnlyProcessPort(linuxProcessPort());
  const classify = input.classify ?? roleOf;
  const iso = input.isoNow ?? (() => new Date(input.now()).toISOString());
  const freshDiskSha = resolveFreshSha(input);
  const operationId = input.operationId ?? WATCHDOG_OPERATION_ID;
  let state = await loadState(input.root);

  const pending = await readAdoptOpState(ephemeralRoot);
  const uniqueNow = findUniqueOfficialChain(processes, classify);
  const settled = settleStaleAdoptJournal({
    state: pending,
    inspect: (pid) => processes.inspect(pid),
    uniqueHost: uniqueNow.ok ? uniqueNow.chain.host : null,
    uniqueSupervisor: uniqueNow.ok ? uniqueNow.chain.supervisor : null,
    gatewayPid: input.adopt?.readGatewayPid() ?? null,
  });
  if (settled && settled !== pending) await writeAdoptOpState(ephemeralRoot, settled);
  if (adoptJournalNeedsRecovery(settled)) {
    state = {
      ...state,
      circuit: "open",
      circuitReason: "pending-uncertain",
    };
    await saveState(input.root, state);
    await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: "pending-uncertain" });
    return resultOf(state, "ambiguous", {
      reconcile: "recovery-required",
      reason: "pending-uncertain",
      attemptKey: null,
      signaled: false,
      injected: false,
      watchdogState: "degraded",
    });
  }

  const status = await projectLiveStatus({
    root: input.root,
    desired: input.desired,
    models: input.models,
    processes,
    ephemeralRoot,
    envHas: input.envHas,
    classify,
    gatewayPid: input.gatewayPid ?? input.adopt?.readGatewayPid() ?? null,
    modeldReady: () => resolveModeldReady(input, ephemeralRoot),
    reviewedProfile: input.reviewedProfile,
    diskSha: freshDiskSha() === "none"
      ? (input.freshDiskSha || input.diskSha !== undefined ? null : undefined)
      : freshDiskSha(),
  });
  const origin = status.host.origin;
  const sha = status.host.diskSha;

  if (origin === "grokbox-unattested" && input.legacyWitness && input.adopt && input.waitReplacement) {
    let continuation = input;
    let beforeSignal: TransientAdoptContext["beforeSignal"];
    if (input.desired.mode === "identity" || input.desired.mode === "route") {
      const legacy = input.legacyWitness.identity;
      const context = { ephemeralRoot, processes, classify, freshDiskSha, liveHost: legacy, sha, origin };
      const key = attemptKey(input.desired.mode, legacy, sha);
      const gate = mutationBudgetGate(state, key, input.confirmed === true);
      if (gate) {
        state = gate.state;
        if (gate.save) await saveState(input.root, state);
        return resultOf(state, origin, gate.result);
      }
      const prepared = await prepareNextTarget(input, context);
      if (!prepared.ok) return refusedTarget(state, origin, key, prepared.code);
      continuation = prepared.input;
      beforeSignal = () => preflightNextTarget(continuation, context);
    }
    const deact = await runTransientAdoptDeactivate({
      processes,
      classify,
      diskSha: freshDiskSha,
      ephemeralRoot,
      attestation: { identity: input.legacyWitness.identity, diskSha: freshDiskSha() },
      beforeSignal,
      waitGone: input.adopt.waitGone,
      waitReplacement: input.waitReplacement,
      hasGrokboxPreload: input.adopt.hasGrokboxPreload,
      readGatewayPid: input.adopt.readGatewayPid,
      clearAttestation: async () => {
        await clearAttestation(ephemeralRoot);
      },
    });
    recordOperation(progress, deact, attemptKey(input.desired.mode, input.legacyWitness.identity, sha));
    if (!deact.ok) {
      state = {
        ...state,
        circuit: "open",
        circuitReason: deact.code,
        mutationCount: state.mutationCount + (deact.signaled ? 1 : 0),
      };
      await saveState(input.root, state);
      await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: deact.code ?? "deactivate_failed" });
      return resultOf(state, origin, {
        reconcile: "recovery-required",
        reason: deact.code ?? "deactivate_failed",
        attemptKey: null,
        signaled: deact.signaled,
        injected: false,
        watchdogState: "degraded",
      });
    }
    state = {
      ...state,
      mutationCount: state.mutationCount + (deact.signaled ? 1 : 0),
    };
    await saveState(input.root, state);
    if (input.desired.mode !== "identity") {
      return resultOf(state, "official", {
        reconcile: "converged",
        reason: null,
        attemptKey: null,
        signaled: deact.signaled,
        injected: false,
        watchdogState: "idle",
      });
    }
    return await runWatchdogTickBody({ ...continuation, legacyWitness: undefined }, progress);
  }

  if (origin === "grokbox-unattested" || origin === "ambiguous") {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "recovery-required",
      reason: status.host.reason ?? origin,
      attemptKey: null,
      signaled: false,
      injected: false,
      watchdogState: "degraded",
    });
  }

  if (input.desired.mode === "route") {
    const hosts = processes.list().filter((ident) => classify(ident) === "host");
    const liveHost = hosts.length === 1 ? hosts[0]! : null;
    const key = liveHost ? attemptKey(input.desired.mode, liveHost, sha) : null;
    const ready = await resolveModeldReady(input, ephemeralRoot);
    const att = await readAttestation(ephemeralRoot);
    const census = countRoles(
      processes.list().flatMap((ident) => {
        const role = classify(ident);
        return role ? [{ ...ident, role }] : [];
      }),
    );
    const blocked = (reason: string): WatchdogTickResult =>
      resultOf(state, origin, {
        reconcile: "blocked",
        reason,
        attemptKey: key,
        signaled: false,
        injected: false,
        watchdogState: "idle",
      });
    const recovery = (reason: string): WatchdogTickResult =>
      resultOf(state, origin, {
        reconcile: "recovery-required",
        reason,
        attemptKey: key,
        signaled: false,
        injected: false,
        watchdogState: "degraded",
      });

    if (routeHasNonStubAssignment(input.models)) {
      await saveState(input.root, state);
      return recovery("non_stub_assignment");
    }

    if (origin === "grokbox-attested" && liveHost) {
      const ownership = canonicalOwnershipAgrees({ attestation: att, liveHost, census });
      const shaMatch = Boolean(att && typeof sha === "string" && att.diskSha === sha);
      const profileMatch = routeAttestationAgrees(att, reviewedIdentityForRoute(input));
      if (shaMatch && profileMatch && ready && status.coverage === "attested") {
        await saveState(input.root, state);
        return resultOf(state, origin, {
          reconcile: "converged",
          reason: null,
          attemptKey: key,
          signaled: false,
          injected: false,
          watchdogState: "running",
        });
      }
      if (att?.mode === "identity" && ownership && shaMatch) {
        if (input.confirmed !== true) {
          await saveState(input.root, state);
          return blocked("route_requires_confirm");
        }
        if (!ready) {
          await saveState(input.root, state);
          return blocked("modeld_not_ready");
        }
        return await runAttestedRefresh(input, {
          progress, state, ephemeralRoot, processes, classify, freshDiskSha, iso, liveHost, sha, origin,
        });
      }
      if (att?.mode === "route" && ownership && shaMatch && !profileMatch) {
        if (input.confirmed !== true) {
          await saveState(input.root, state);
          return recovery("route_mismatch");
        }
        if (!ready) {
          await saveState(input.root, state);
          return blocked("modeld_not_ready");
        }
        return await runAttestedRefresh(input, {
          progress, state, ephemeralRoot, processes, classify, freshDiskSha, iso, liveHost, sha, origin,
        });
      }
      if (!ready && att?.mode === "route" && shaMatch && ownership) {
        await saveState(input.root, state);
        return blocked("modeld_not_ready");
      }
      await saveState(input.root, state);
      return recovery(status.host.reason ?? (status.operation.pending !== false ? "pending-uncertain" : "route_mismatch"));
    }

    if (origin === "official" && liveHost) {
      if (input.confirmed !== true) {
        await saveState(input.root, state);
        return blocked("route_requires_confirm");
      }
      if (!ready) {
        await saveState(input.root, state);
        return blocked("modeld_not_ready");
      }
    } else {
      await saveState(input.root, state);
      return recovery(status.host.reason ?? origin);
    }
  }

  if (input.desired.mode === "observe" || input.desired.mode === "disabled") {
    await saveState(input.root, state);
    const restored = input.desired.mode !== "disabled" || status.activation.actual === "official";
    return resultOf(state, origin, {
      reconcile: restored ? "converged" : "pending",
      reason: restored ? null : "rollback_pending",
      attemptKey: null,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }

  const hosts = processes.list().filter((ident) => classify(ident) === "host");
  const liveHost = hosts.length === 1 ? hosts[0]! : null;

  if (origin === "grokbox-attested" && liveHost) {
    if ((status.host.topology !== "direct" && status.host.topology !== "adopted") || sha === null || status.operation.pending !== false) {
      return resultOf(state, origin, { reconcile: "recovery-required", reason: status.host.reason === "gateway_mismatch" ? "gateway-mismatch" : status.host.reason ?? "pending-uncertain",
        attemptKey: attemptKey(input.desired.mode, liveHost, sha), signaled: false, injected: false, watchdogState: "degraded" });
    }
    const stale = status.host.reason === "stale_attestation";
    if (!stale || input.confirmed !== true) {
      await saveState(input.root, state);
      return resultOf(state, origin, {
        reconcile: "converged",
        reason: stale ? "stale_attestation" : null,
        attemptKey: attemptKey(input.desired.mode, liveHost, sha),
        signaled: false,
        injected: false,
        watchdogState: "running",
      });
    }
    return await runAttestedRefresh(input, {
      progress,
      state,
      ephemeralRoot,
      processes,
      classify,
      freshDiskSha,
      iso,
      operationId,
      liveHost,
      sha,
      origin,
    });
  }

  if (origin !== "official" || !liveHost) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "recovery-required",
      reason: status.host.reason ?? origin,
      attemptKey: null,
      signaled: false,
      injected: false,
      watchdogState: "degraded",
    });
  }

  const key = attemptKey(input.desired.mode, liveHost, sha);
  const budgetGate = mutationBudgetGate(state, key, input.confirmed === true);
  if (budgetGate) {
    if (budgetGate.save) {
      state = budgetGate.state;
      await saveState(input.root, state);
      if (budgetGate.event) {
        await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: budgetGate.event });
      }
    } else {
      await saveState(input.root, state);
    }
    return resultOf(state, origin, budgetGate.result);
  }
  if (!input.reviewedProfile) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: "missing_reviewed_profile",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }
  if (!input.adopt) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: "mutation_ports_unavailable",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }

  const targetContext = { ephemeralRoot, processes, classify, freshDiskSha, liveHost, sha, origin };
  const prepared = await prepareNextTarget(input, targetContext);
  if (!prepared.ok) return refusedTarget(state, origin, key, prepared.code);
  const nextInput = prepared.input;
  const markerMode = input.desired.mode === "route" ? "route" : "identity";
  const adopted = await runTransientAdoptOperation({
    processes,
    classify,
    reviewedProfile: nextInput.reviewedProfile,
    diskSha: freshDiskSha,
    ephemeralRoot,
    operationId,
    readMarker: () => null,
    waitGone: input.adopt.waitGone,
    waitReady: input.adopt.waitReady,
    spawnTempSupervisor: input.adopt.spawnTempSupervisor,
    waitNewHost: input.adopt.waitNewHost,
    readGatewayPid: input.adopt.readGatewayPid,
    armGuardian: input.adopt.armGuardian,
    expectedMode: markerMode,
    persistAttestation: input.adopt.persistAttestation,
    modeldReady: () => resolveModeldReady(input, ephemeralRoot),
    beforeSignal: () => preflightNextTarget(nextInput, targetContext),
    hasGrokboxPreload: input.adopt.hasGrokboxPreload,
    now: input.now,
    adoptProveMs: input.adopt.adoptProveMs,
  });

  recordOperation(progress, adopted, key);
  if (adopted.signaled || adopted.ok) {
    const attemptedKeys = [...state.attemptedKeys.filter((entry) => entry !== key), key].slice(-32);
    state = {
      ...state,
      mutationCount: state.mutationCount + (adopted.signaled ? 1 : 0),
      attemptedKeys,
      lastAttemptKey: key,
      circuit: adopted.ok ? state.circuit : "open",
      circuitReason: adopted.ok ? state.circuitReason : adopted.code,
    };
  }

  await saveState(input.root, state);
  if (!adopted.ok && state.circuit === "open") {
    await appendEvent(input.root, { name: "circuit_open", at: iso(), reason: adopted.code ?? "adopt_failed" });
  }
  if (adopted.ok) {
    return resultOf(state, "grokbox-attested", {
      reconcile: "converged",
      reason: null,
      attemptKey: key,
      signaled: adopted.signaled,
      committedAttestation: adopted.committedAttestation,
      injected: true,
      watchdogState: "running",
    });
  }
  return resultOf(state, origin, {
    reconcile: "recovery-required",
    reason: adopted.code ?? "adopt_failed",
    attemptKey: key,
    signaled: adopted.signaled,
    committedAttestation: adopted.committedAttestation,
    injected: false,
    watchdogState: "degraded",
  });
}

function needsMutationLease(input: WatchdogTickInput): boolean {
  return Boolean(input.adopt) || Boolean(input.legacyWitness);
}

async function runCoordinatedTick(input: WatchdogTickInput, forceLease = false): Promise<WatchdogTickResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const progress: AttemptProgress = { signaled: false, injected: false, attemptKey: null };
  const failed = (): WatchdogTickResult => ({
    reconcile: "recovery-required", reason: "coordinator-persistence-failed", ...progress,
    circuit: "open", origin: "ambiguous", watchdogState: "degraded",
  });
  const fenceUncertain = async () => {
    if (!progress.signaled) return;
    try {
      const journal = await readAdoptOpState(ephemeralRoot);
      await writeAdoptOpState(ephemeralRoot, {
        launchMode: "transient-adopt", tempSupervisor: null, adoptingSupervisor: null, host: null,
        ...journal, phase: "recovery-required",
      });
    } catch { /* An unreadable journal/lock is still fail-closed; never retry here. */ }
  };
  const body = async (): Promise<WatchdogTickResult> => {
    try {
      let result = await runWatchdogTickBody(input, progress);
      await compactEvents(input.root);
      if (result.reconcile === "converged" && progress.committedAttestation) {
        const expected = progress.committedAttestation;
        progress.committedAttestation = undefined;
        const record = await readAttestation(ephemeralRoot);
        let reason: string | null = null;
        if (!isDeepStrictEqual(record, expected)) reason = "attestation-uncommitted";
        else {
          progress.committedAttestation = record!;
          if (record!.mode === "route" && !await resolveModeldReady(input, ephemeralRoot)) reason = "modeld_not_ready";
        }
        if (reason) result = { ...result, committedAttestation: progress.committedAttestation,
          reconcile: "recovery-required", reason, watchdogState: "degraded" };
      }
      if (progress.signaled && (result.reconcile !== "converged" || result.reason === "generation_attempted")) {
        await fenceUncertain();
        return { ...result, ...progress, reconcile: "recovery-required", watchdogState: "degraded" };
      }
      return { ...result, signaled: progress.signaled || result.signaled,
        ...(progress.committedAttestation ? { committedAttestation: progress.committedAttestation } : {}) };
    } catch {
      await fenceUncertain();
      return failed();
    }
  };
  try {
    return !forceLease && !needsMutationLease(input) ? await body() : await withCoordinatorLease(input, ephemeralRoot, body);
  } catch {
    // Lease release can fail after an otherwise committed operation. Preserve its evidence.
    return failed();
  }
}

export async function runWatchdogTick(input: WatchdogTickInput): Promise<WatchdogTickResult> {
  return await runCoordinatedTick(input);
}

export async function runWatchdogCutover(input: WatchdogTickInput): Promise<WatchdogTickResult> {
  return await runCoordinatedTick(input, true);
}

export type ManualReadoptInput = WatchdogTickInput & {
  confirmed: boolean;
};

/** Explicit one-shot into the same coordinator. Not a loop or second writer. */
export async function runManualReadopt(input: ManualReadoptInput): Promise<WatchdogTickResult> {
  if (input.confirmed !== true) {
    throw new BoxRuntimeError("invalid_usage", "runtime re-adopt requires --confirm.");
  }
  if (input.legacyWitness) {
    throw new BoxRuntimeError("invalid_usage", "Manual re-adopt requires canonical ownership, not a legacy witness.");
  }
  return await runWatchdogTick(input);
}
