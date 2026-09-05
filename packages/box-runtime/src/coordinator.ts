import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clearAttestation, readAttestation, writeAttestation, type CoverageAttestation } from "./attestation.ts";
import { ephemeralRuntimeRoot } from "./ephemeral.ts";
import { BoxRuntimeError } from "./errors.ts";
import { appendEvent, compactEvents } from "./events.ts";
import { canonicalOwnershipAgrees } from "./identity-op.ts";
import { inspectPid, linuxProcessPort, roleOf } from "./live-proc.ts";
import { probeStubModeld } from "./modeld-ipc.ts";
import type { DesiredFile, ModelsFile } from "./models.ts";
import { projectLiveStatus, type HostOrigin } from "./observe.ts";
import { findAdoptedHostState, findUniqueOfficialChain, loadReviewedProfile, type RoleClassifier } from "./official-chain.ts";
import { acquireCoordinatorLease, coordinatorLeasePath, type LeaseOwner } from "./op-lock.ts";
import { coordinatorStatePath } from "./paths.ts";
import { countRoles, readOnlyProcessPort, type ProcessIdentity, type ProcessPort } from "./process.ts";
import {
  adoptJournalNeedsRecovery,
  readAdoptOpState,
  runTransientAdoptDeactivate,
  runTransientAdoptOperation,
  type TransientAdoptContext,
} from "./transient-adopt.ts";
import type { PatchProfile } from "./transform.ts";

export const WATCHDOG_OPERATION_ID = "watchdog-identity";
export const WATCHDOG_MUTATION_BUDGET = 2;

export type WatchdogReconcile = "converged" | "pending" | "blocked" | "recovery-required";

export type CoordinatorState = {
  version: 1;
  circuit: "closed" | "open";
  circuitReason?: string;
  mutationCount: number;
  attemptedKeys: string[];
  lastAttemptKey?: string;
};

export type WatchdogTickResult = {
  reconcile: WatchdogReconcile;
  reason: string | null;
  attemptKey: string | null;
  signaled: boolean;
  injected: boolean;
  circuit: "closed" | "open";
  watchdogState: "idle" | "running" | "degraded";
  origin: HostOrigin;
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
>;

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
  try {
    const parsed = JSON.parse(await readFile(coordinatorStatePath(root), "utf8")) as CoordinatorState;
    if (parsed.version !== 1) return { ...EMPTY_STATE };
    return {
      version: 1,
      circuit: parsed.circuit === "open" ? "open" : "closed",
      circuitReason: parsed.circuitReason,
      mutationCount: Number.isFinite(parsed.mutationCount) ? parsed.mutationCount : 0,
      attemptedKeys: Array.isArray(parsed.attemptedKeys)
        ? parsed.attemptedKeys.filter((key): key is string => typeof key === "string").slice(-32)
        : [],
      lastAttemptKey: typeof parsed.lastAttemptKey === "string" ? parsed.lastAttemptKey : undefined,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...EMPTY_STATE };
    throw error;
  }
}

async function saveState(root: string, state: CoordinatorState): Promise<void> {
  const path = coordinatorStatePath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
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

function routeProfileAgrees(att: CoverageAttestation, reviewed: PatchProfile | undefined): boolean {
  if (!reviewed) return false;
  if (att.diskSha !== reviewed.sourceSha256) return false;
  if (att.transformedSha && att.transformedSha !== reviewed.transformedSourceSha256) return false;
  if (att.profileId && att.profileId !== reviewed.profileId) return false;
  return true;
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

async function waitDirectOfficialReplacement(
  input: WatchdogTickInput,
  processes: ProcessPort,
  classify: RoleClassifier,
  oldPid: number,
): Promise<ProcessIdentity | null> {
  if (input.waitReplacement) return await input.waitReplacement(oldPid);
  const adopt = input.adopt;
  if (!adopt) return null;
  const started = Date.now();
  const budget = adopt.adoptProveMs ?? 8000;
  while (Date.now() - started < budget) {
    const unique = findUniqueOfficialChain(processes, classify);
    if (
      unique.ok &&
      unique.chain.host.pid !== oldPid &&
      !adopt.hasGrokboxPreload(unique.chain.host)
    ) {
      return unique.chain.host;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const unique = findUniqueOfficialChain(processes, classify);
  if (
    unique.ok &&
    unique.chain.host.pid !== oldPid &&
    !adopt.hasGrokboxPreload(unique.chain.host)
  ) {
    return unique.chain.host;
  }
  return null;
}

async function runStaleAttestedReadopt(
  input: WatchdogTickInput,
  ctx: {
    state: CoordinatorState;
    ephemeralRoot: string;
    processes: ProcessPort;
    classify: RoleClassifier;
    freshDiskSha: () => string;
    iso: () => string;
    operationId: string;
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

  const adopted = findAdoptedHostState(processes, classify, {
    gatewayPid: input.adopt.readGatewayPid(),
    expectedHost: liveHost,
  });
  if (!adopted.ok) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "recovery-required",
      reason: adopted.code,
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "degraded",
    });
  }

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
    allowStaleAttestedSha: true,
  });

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
  if (input.desired.mode !== "identity") {
    return resultOf(state, "official", {
      reconcile: "converged",
      reason: null,
      attemptKey: key,
      signaled: deact.signaled,
      injected: false,
      watchdogState: "idle",
    });
  }
  return await runWatchdogTickBody({ ...input, confirmed: true });
}

async function runIdentityToRouteRefresh(
  input: WatchdogTickInput,
  ctx: {
    state: CoordinatorState;
    ephemeralRoot: string;
    processes: ProcessPort;
    classify: RoleClassifier;
    freshDiskSha: () => string;
    iso: () => string;
    liveHost: ProcessIdentity;
    sha: string | null;
    origin: HostOrigin;
  },
): Promise<WatchdogTickResult> {
  let { state } = ctx;
  const { ephemeralRoot, processes, classify, freshDiskSha, iso, liveHost, sha, origin } = ctx;
  const key = attemptKey(input.desired.mode, liveHost, sha);
  if (!input.reviewedProfile || !input.adopt) {
    await saveState(input.root, state);
    return resultOf(state, origin, {
      reconcile: "blocked",
      reason: input.reviewedProfile ? "mutation_ports_unavailable" : "missing_reviewed_profile",
      attemptKey: key,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }
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
  });
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
  return await runWatchdogTickBody({ ...input, confirmed: true });
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

async function runWatchdogTickBody(input: WatchdogTickInput): Promise<WatchdogTickResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const processes = input.processes ?? readOnlyProcessPort(linuxProcessPort());
  const classify = input.classify ?? roleOf;
  const iso = input.isoNow ?? (() => new Date(input.now()).toISOString());
  const freshDiskSha = resolveFreshSha(input);
  const operationId = input.operationId ?? WATCHDOG_OPERATION_ID;
  let state = await loadState(input.root);

  const pending = await readAdoptOpState(ephemeralRoot);
  if (adoptJournalNeedsRecovery(pending)) {
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
    diskSha: freshDiskSha() === "none" && input.diskSha === undefined ? undefined : freshDiskSha(),
  });
  const origin = status.host.origin;
  const sha = status.host.diskSha;

  if (origin === "grokbox-unattested" && input.legacyWitness && input.adopt && input.waitReplacement) {
    const deact = await runTransientAdoptDeactivate({
      processes,
      classify,
      diskSha: freshDiskSha,
      ephemeralRoot,
      attestation: { identity: input.legacyWitness.identity, diskSha: freshDiskSha() },
      waitGone: input.adopt.waitGone,
      waitReplacement: input.waitReplacement,
      hasGrokboxPreload: input.adopt.hasGrokboxPreload,
      readGatewayPid: input.adopt.readGatewayPid,
      clearAttestation: async () => {
        await clearAttestation(ephemeralRoot);
      },
    });
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
    return await runWatchdogTickBody({ ...input, legacyWitness: undefined });
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

    if (origin === "grokbox-attested" && liveHost) {
      const ownership = canonicalOwnershipAgrees({ attestation: att, liveHost, census });
      const shaMatch = Boolean(att && typeof sha === "string" && att.diskSha === sha);
      if (att?.mode === "route" && att.modeld === true && shaMatch && routeProfileAgrees(att, input.reviewedProfile) && ready) {
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
        return await runIdentityToRouteRefresh(input, {
          state,
          ephemeralRoot,
          processes,
          classify,
          freshDiskSha,
          iso,
          liveHost,
          sha,
          origin,
        });
      }
      if (!ready && att?.mode === "route" && shaMatch && ownership) {
        await saveState(input.root, state);
        return blocked("modeld_not_ready");
      }
      await saveState(input.root, state);
      return recovery(status.host.reason ?? "route_mismatch");
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
    return resultOf(state, origin, {
      reconcile: "converged",
      reason: null,
      attemptKey: null,
      signaled: false,
      injected: false,
      watchdogState: "idle",
    });
  }

  const hosts = processes.list().filter((ident) => classify(ident) === "host");
  const liveHost = hosts.length === 1 ? hosts[0]! : null;

  if (origin === "grokbox-attested" && liveHost) {
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
    return await runStaleAttestedReadopt(input, {
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

  const markerMode = input.desired.mode === "route" ? "route" : "identity";
  const adopted = await runTransientAdoptOperation({
    processes,
    classify,
    reviewedProfile: input.reviewedProfile,
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
    persistAttestation:
      markerMode === "route"
        ? async (host, nextSha, windowMs) => {
            await writeAttestation(ephemeralRoot, {
              mode: "route",
              coverage: "attested",
              diskSha: nextSha,
              pid: host.pid,
              start: host.start,
              identity: host,
              at: iso(),
              modeld: true,
              windowMs,
              launchMode: "transient-adopt",
              profileId: input.reviewedProfile?.profileId,
              transformedSha: input.reviewedProfile?.transformedSourceSha256,
            });
          }
        : input.adopt.persistAttestation ??
          (async (host, nextSha, windowMs) => {
            await writeAttestation(ephemeralRoot, {
              mode: "identity",
              coverage: "attested",
              diskSha: nextSha,
              pid: host.pid,
              start: host.start,
              identity: host,
              at: iso(),
              modeld: false,
              windowMs,
              launchMode: "transient-adopt",
            });
          }),
    prepareTempLaunch: input.adopt.prepareTempLaunch,
    hasGrokboxPreload: input.adopt.hasGrokboxPreload,
    now: input.now,
    adoptProveMs: input.adopt.adoptProveMs,
  });

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
      injected: true,
      watchdogState: "running",
    });
  }
  return resultOf(state, origin, {
    reconcile: "recovery-required",
    reason: adopted.code ?? "adopt_failed",
    attemptKey: key,
    signaled: adopted.signaled,
    injected: false,
    watchdogState: "degraded",
  });
}

function needsMutationLease(input: WatchdogTickInput): boolean {
  return Boolean(input.adopt) || Boolean(input.legacyWitness);
}

export async function runWatchdogTick(input: WatchdogTickInput): Promise<WatchdogTickResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const result = !needsMutationLease(input)
    ? await runWatchdogTickBody(input)
    : (await withCoordinatorLease(input, ephemeralRoot, () => runWatchdogTickBody(input))) as WatchdogTickResult;
  await compactEvents(input.root);
  return result;
}

export async function runWatchdogCutover(input: WatchdogTickInput): Promise<WatchdogTickResult> {
  const ephemeralRoot = input.ephemeralRoot ?? ephemeralRuntimeRoot();
  const leased = await withCoordinatorLease(input, ephemeralRoot, () => runWatchdogTickBody(input));
  return leased as WatchdogTickResult;
}

export type ManualReadoptInput = WatchdogTickInput & {
  confirmed: boolean;
};

/** Explicit one-shot into the same coordinator. Not a loop or second writer. */
export async function runManualReadopt(input: ManualReadoptInput): Promise<WatchdogTickResult> {
  if (input.confirmed !== true) {
    throw new BoxRuntimeError("invalid_usage", "runtime re-adopt requires --confirm.");
  }
  return await runWatchdogTick(input);
}
