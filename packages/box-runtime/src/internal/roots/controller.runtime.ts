import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import type { DesiredFile, ModelsFile } from "@grokbox/runtime-kernel/selection";
import type { CoverageAttestation } from "../io/authority.node.ts";
export type { CoordinatorState } from "../io/coordinator-state.ts";
import type { HostOrigin } from "../io/observe.ts";
import type { LeaseOwner } from "../io/op-lock.ts";
import type { PatchProfile } from "../host/profile.ts";
import type { RoleClassifier } from "../process/official-chain.ts";
import type { ProcessIdentity, ProcessPort } from "../process/process-port.ts";
import type { AdoptTargetPorts, TransientAdoptContext } from "../process/transient-adopt.ts";

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
  operationId?: string;
  inspectLeaseOwner?: (pid: number) => LeaseOwner | null;
  selfLease?: LeaseOwner;
  now: () => number;
  isoNow?: () => string;
  confirmed?: boolean;
  modeldReady?: () => boolean | Promise<boolean>;
};

export type ManualReadoptInput = WatchdogTickInput & {
  confirmed: boolean;
};

const LEGACY_REMOVED = "legacy controller executor removed; use startControlOperation";

function refuseLegacy(): never {
  throw new BoxRuntimeError("invalid_usage", LEGACY_REMOVED);
}

export async function runWatchdogTick(_input: WatchdogTickInput): Promise<WatchdogTickResult> {
  return refuseLegacy();
}

export async function runWatchdogCutover(_input: WatchdogTickInput): Promise<WatchdogTickResult> {
  return refuseLegacy();
}

/** Retired one-shot. Confirmed apply goes through startControlOperation. */
export async function runManualReadopt(input: ManualReadoptInput): Promise<WatchdogTickResult> {
  if (input.confirmed !== true) {
    throw new BoxRuntimeError("invalid_usage", "runtime re-adopt requires --confirm.");
  }
  return refuseLegacy();
}
