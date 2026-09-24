import { Context, Effect, Stream } from "effect";
import type { ModelSnapshot, ModelManagementError, ModelOperationLocator, ModelOperationKey, ModelOperation, ModelChange, ModelPublicationCheck } from "./model-management.ts";

export class ModelConfiguration extends Context.Service<ModelConfiguration, {
  read: () => Effect.Effect<ModelSnapshot, ModelManagementError>;
  lookup: (key: ModelOperationLocator & { fingerprint?: string }) => Effect.Effect<ModelOperation | undefined, ModelManagementError>;
  commit: (key: ModelOperationKey, current: ModelSnapshot, next: ModelsFile, change: ModelChange, beforePublish?: ModelPublicationCheck) => Effect.Effect<ModelOperation, unknown>;
}>()("grokbox/ModelConfiguration") {}
import type { EvidenceView } from "./observation.ts";
import type { RoutineSnapshot, RoutineError, RoutineProvisionError, RoutineBlueprint, ProvisionRecord, ProvisionLookup, ProvisionBinding, ProvisionReservation, ProvisionObservation } from "./routines.ts";
import type { Scope } from "effect/Scope";
import type { ModelsFile, DesiredFile } from "./selection.ts";
import type { ConfigChange, ConfigCommitReceipt } from "./internal/commands/config.ts";
import type { StatusEvidence } from "./internal/contract/status.ts";
import type { InferenceEvent } from "./internal/contract/events.ts";
import type { HostCompactRequest, HostCompactResult } from "./internal/contract/overflow.ts";
import type { RunStepRequest } from "./internal/contract/binding.ts";
import type { AdmissionAuthorityResult } from "./internal/contract/authority-policy.ts";
import type { ContextIntent } from "./internal/config/context-policy.ts";
import type { ContextBudget, ContextCandidate, ContextCommitReceipt, ContextFailure, ContextMaterial, ContextMeasure, ContextPlan, ContextMaintenanceIdentity, ContextSummaryInput, ContextSummaryOutput } from "./internal/contract/context-maintenance.ts";

/** Process-local opaque handle. Not a contract DTO; never stringify, log, or put on the wire. */
export type PreparedCall = { readonly _PreparedCall: unique symbol };
export type AuthLease = { readonly _AuthLease: unique symbol };

export type ConfigurationSnapshot = {
  models: ModelsFile;
  desired: DesiredFile;
  context?: ContextIntent;
};

export class ConfigurationRead extends Context.Service<ConfigurationRead, {
  readonly snapshot: () => Effect.Effect<ConfigurationSnapshot, unknown>;
}>()("grokbox/ConfigurationRead") {}

export class ConfigurationWrite extends Context.Service<ConfigurationWrite, {
  readonly changeConfig?: (command: ConfigChange) => Effect.Effect<ConfigCommitReceipt, unknown>;
  readonly saveModels: (file: ModelsFile) => Effect.Effect<{ configRevision: string }, unknown>;
  readonly saveDesired: (file: DesiredFile) => Effect.Effect<{ configRevision: string }, unknown>;
}>()("grokbox/ConfigurationWrite") {}

export class RoutineProvisionLedger extends Context.Service<RoutineProvisionLedger, {
  readonly read: (agentId: string, operationId: string) => Effect.Effect<ProvisionLookup | null, RoutineProvisionError>;
  readonly binding: (agentId: string, key: string) => Effect.Effect<ProvisionBinding | null, RoutineProvisionError>;
  readonly reserve: (input: ProvisionReservation) => Effect.Effect<{ dispatch: boolean; record: ProvisionRecord }, RoutineProvisionError>;
  readonly markUnknown: (agentId: string, operationId: string) => Effect.Effect<void, RoutineProvisionError>;
  readonly reconcileRecord: (agentId: string, operationId: string) => Effect.Effect<ProvisionRecord, RoutineProvisionError>;
  readonly finish: (record: ProvisionRecord, nativeId: string, revision: string) => Effect.Effect<ProvisionRecord, RoutineProvisionError>;
}>()("grokbox/RoutineProvisionLedger") {}
export class NativeRoutineProvision extends Context.Service<NativeRoutineProvision, {
  readonly list: (agentId: string) => Effect.Effect<ProvisionObservation, RoutineProvisionError>;
  readonly write: (agentId: string, blueprint: RoutineBlueprint, nativeId: string | null) => Effect.Effect<ProvisionObservation, RoutineProvisionError>;
}>()("grokbox/NativeRoutineProvision") {}

export class OpsTargetPairing extends Context.Service<OpsTargetPairing, {
  readonly prior: (alias: string) => Effect.Effect<import("./observation.ts").PairingRecord | null, unknown>;
  readonly plan: (command: import("./observation.ts").PairingCommand) => Effect.Effect<import("./observation.ts").PairingPlan, unknown>;
  readonly reserve: (plan: import("./observation.ts").PairingPlan, expectedRevision: number) => Effect.Effect<{ dispatch: boolean; record: import("./observation.ts").PairingRecord }, unknown>;
  readonly credential: (plan: import("./observation.ts").PairingPlan) => Effect.Effect<unknown, unknown>;
  readonly recheck: (plan: import("./observation.ts").PairingPlan) => Effect.Effect<void, unknown>;
  readonly finish: (record: import("./observation.ts").PairingRecord, credential: import("./observation.ts").PairingCredential) => Effect.Effect<import("./observation.ts").PairingRecord, unknown>;
}>()("grokbox/OpsTargetPairing") {}

export class OpsNotification extends Context.Service<OpsNotification, {
  readonly attempted: (workId: string) => Effect.Effect<boolean, unknown>;
  readonly route: () => Effect.Effect<import("./observation.ts").NotificationRoute, unknown>;
  readonly scope: () => Effect.Effect<import("./observation.ts").NotificationScope, unknown>;
  readonly inspect: (target: import("./observation.ts").NotificationTarget, scope: import("./observation.ts").NotificationScope) => Effect.Effect<import("./observation.ts").NotificationBinding | null, unknown>;
  readonly reserve: (workId: string, target: import("./observation.ts").NotificationTarget, binding: import("./observation.ts").NotificationBinding) => Effect.Effect<import("./observation.ts").NotificationReservation, unknown>;
  readonly begin: (frozen: import("./observation.ts").FrozenNotification) => Effect.Effect<{ dispatch: boolean; reason: string }, unknown>;
  readonly send: (frozen: import("./observation.ts").FrozenNotification, envelope: import("./observation.ts").NotificationEnvelope, binding: import("./observation.ts").NotificationBinding) => Effect.Effect<import("./observation.ts").NativeNotificationResult, unknown>;
  readonly settle: (frozen: import("./observation.ts").FrozenNotification, result: import("./observation.ts").NativeNotificationResult) => Effect.Effect<unknown, unknown>;
}>()("grokbox/OpsNotification") {}

export class AgentRoutines extends Context.Service<AgentRoutines, {
  readonly list: (agentId: string) => Effect.Effect<RoutineSnapshot, RoutineError>;
  readonly change: (agentId: string, routineId: string, action: "enable" | "disable" | "delete") => Effect.Effect<RoutineSnapshot, RoutineError>;
}>()("grokbox/AgentRoutines") {}

export class EvidenceRead extends Context.Service<EvidenceRead, {
  readonly read: (query: { incidentId: string; revision?: number; view: EvidenceView }) => Effect.Effect<unknown, unknown>;
}>()("grokbox/EvidenceRead") {}
export class EvidenceStore extends Context.Service<EvidenceStore, {
  readonly capture: (incidentId: string, nowMs: number) => Effect.Effect<unknown, unknown>;
  readonly lease: (request: { incidentId: string; revision: number; durationMs: number; nowMs: number }) => Effect.Effect<unknown, unknown>;
}>()("grokbox/EvidenceStore") {}

/** Process-local controls from the STEP owner, never decoded from caller JSON.
 * Only the source coordinator consumes retries; the gate owns the total budget. */
export type AuthorityReadControl = {
  /** Identity of the currently claimed STEP lifetime. This is neither a permit
   * nor caller input; copied/new objects cannot borrow another STEP's reuse. */
  readonly evidenceOwner?: object;
  readonly waitBudgetMs: number;
  readonly takeRetry: () => Effect.Effect<boolean>;
};
export class AdmissionAuthority extends Context.Service<AdmissionAuthority, {
  readonly current: (request: RunStepRequest, control?: AuthorityReadControl) => Effect.Effect<AdmissionAuthorityResult, unknown>;
  /** Same native evidence reader; no fabricated business STEP for maintenance. */
  readonly currentContext?: (request: ContextMaintenanceIdentity, control?: AuthorityReadControl) => Effect.Effect<AdmissionAuthorityResult, unknown>;
}>()("grokbox/AdmissionAuthority") {}

export class BackendAuth extends Context.Service<BackendAuth, {
  readonly pin: (input: unknown) => Effect.Effect<{ lease: AuthLease; fingerprint: string }, unknown, Scope>;
  readonly verify: (lease: AuthLease) => Effect.Effect<void, unknown>;
}>()("grokbox/BackendAuth") {}

export class ModelBackend extends Context.Service<ModelBackend, {
  readonly prepare: (selection: unknown, snapshot: unknown) => Effect.Effect<PreparedCall, unknown>;
  readonly infer: (
    admittedCall: unknown,
    prepared: PreparedCall,
    authLease: AuthLease,
  ) => Stream.Stream<InferenceEvent, unknown>;
}>()("grokbox/ModelBackend") {}

export class RuntimeEvents extends Context.Service<RuntimeEvents, {
  readonly append: (event: unknown) => Effect.Effect<void, unknown>;
}>()("grokbox/RuntimeEvents") {}

export class ModeldControl extends Context.Service<ModeldControl, {
  readonly ensure: () => Effect.Effect<unknown, unknown>;
}>()("grokbox/ModeldControl") {}

export type ControllerIntent = "preview" | "apply" | "reconcile";
export type LaunchStrategy = "direct" | "transient";

export type ControllerRequest = {
  intent: ControllerIntent;
  confirmed: boolean;
  operationId: string;
  boxRoot: string;
  strategy?: LaunchStrategy;
};

export type FrozenControllerCommand = Readonly<{
  intent: ControllerIntent;
  confirmed: boolean;
  operationId: string;
  boxRoot: string;
  strategy: LaunchStrategy | null;
  fingerprint: string;
}>;

/** Bounded facts only: never exception messages, command lines or child output. */
export type ControllerDiagnostic = {
  code: string | null;
  phase: string;
  recoveryRequired: boolean;
  guardianEnd: "active" | "released" | "expired" | "lost" | "unarmed";
  /** null: independent CONT outcome was not yet observed, never proof of no signal. */
  guardianContinued?: boolean | null;
  signals?: Array<{ pid: number; start: number; signal: "SIGSTOP" | "SIGTERM"; sent: boolean }>;
  cleanup?: Array<{ role: "host" | "temp-supervisor"; pid: number; start: number; signalSent: boolean;
    outcome: "confirmed-gone" | "unproven"; observed: "absent" | "same-identity" | "different-identity" | "unavailable" }>;
  child?: { pid: number; start: number; exitCode: number | null; signal: string | null };
  readiness?: { expectedPid: number; gatewayPid: number | null; compiled: boolean; alive: boolean };
};

export type ControllerReceipt = {
  outcome: "preview" | "refused" | "signaled" | "partial" | "recovery-required" | "unknown" | "converged";
  reason: string | null;
  signaled: boolean;
  spawned: boolean;
  guardian: boolean;
  operationId: string;
  diagnostic?: ControllerDiagnostic;
};

export type LeaseDecision =
  | { status: "acquired" }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "uncertain" }
  | { status: "conflict" }
  | { status: "corrupt" };

export type OperationPrefix = {
  diagnostic?: ControllerDiagnostic;
  signaled: boolean;
  spawned: boolean;
  guardian: boolean;
};

export type OperationRecord = {
  fingerprint: string;
  state: "reserved" | "running" | "unknown" | "terminal";
  prefix?: OperationPrefix;
};

export class ControlResources extends Context.Service<ControlResources, {
  readonly lease: (input: FrozenControllerCommand) => Effect.Effect<LeaseDecision, unknown, Scope>;
  readonly peek: (input: { operationId: string; boxRoot: string }) => Effect.Effect<OperationRecord | null, unknown>;
  readonly settle: (input: { operationId: string; boxRoot: string; state: "running" | "unknown" | "terminal"; prefix?: OperationPrefix }) => Effect.Effect<void, unknown>;
  readonly preflight: (input: FrozenControllerCommand) => Effect.Effect<{ ok: boolean; reason: string | null; strategy?: LaunchStrategy }, unknown>;
  readonly recheck: (input: FrozenControllerCommand) => Effect.Effect<{ ok: boolean; reason: string | null }, unknown>;
  readonly signal: (input: FrozenControllerCommand) => Effect.Effect<{ signaled: boolean; diagnostic?: ControllerDiagnostic }, unknown>;
  readonly spawn: (input: FrozenControllerCommand) => Effect.Effect<{ spawned: boolean; signaled?: boolean; guardian?: boolean; diagnostic?: ControllerDiagnostic }, unknown>;
  readonly armGuardian: (input: FrozenControllerCommand) => Effect.Effect<{ guardian: boolean }, unknown>;
  readonly wait: (input: FrozenControllerCommand) => Effect.Effect<void, unknown>;
  readonly commit: (input: FrozenControllerCommand) => Effect.Effect<{ committed: boolean; diagnostic?: ControllerDiagnostic }, unknown>;
}>()("grokbox/ControlResources") {}

export class ObservationRead extends Context.Service<ObservationRead, {
  readonly snapshot: () => Effect.Effect<StatusEvidence, unknown>;
}>()("grokbox/ObservationRead") {}

export type ContextSummaryRequest = (input: ContextSummaryInput) => Effect.Effect<ContextSummaryOutput, ContextFailure>;

/** One external-algorithm boundary. No Pi types, credentials, root writes or Runtime. */
export class ContextCompactionAlgorithm extends Context.Service<ContextCompactionAlgorithm, {
  readonly measure: (material: ContextMaterial) => Effect.Effect<ContextMeasure, ContextFailure>;
  readonly plan: (material: ContextMaterial, budget: ContextBudget, summaryBudget: ContextBudget) => Effect.Effect<ContextPlan, ContextFailure>;
  readonly generate: (plan: ContextPlan, budget: ContextBudget, request: ContextSummaryRequest) => Effect.Effect<string, ContextFailure>;
}>()("grokbox/ContextCompactionAlgorithm") {}

/** A qualified native root lease; never populated from caller JSON. Preview
 * materializes the real carrier without replacing the active/persisted root. */
export type HostContextMaintenance = {
  /** Native activity reporting is observation only; it grants no execution or write authority. */
  readonly startActivity?: (identity: ContextMaintenanceIdentity) => Effect.Effect<void, ContextFailure>;
  readonly authorize: (identity: ContextMaintenanceIdentity) => Effect.Effect<void, ContextFailure>;
  readonly inspect: (identity: ContextMaintenanceIdentity) => Effect.Effect<ContextMaterial, ContextFailure>;
  readonly preview: (identity: ContextMaintenanceIdentity, candidate: ContextCandidate) => Effect.Effect<ContextMaterial, ContextFailure>;
  readonly commit: (identity: ContextMaintenanceIdentity, candidate: ContextCandidate) => Effect.Effect<ContextCommitReceipt, ContextFailure>;
  readonly readCommit: (identity: ContextMaintenanceIdentity) => Effect.Effect<ContextCommitReceipt | undefined, ContextFailure>;
};
export class HostCompact extends Context.Service<HostCompact, {
  readonly request: (input: HostCompactRequest) => Effect.Effect<HostCompactResult>;
  readonly maintenance?: HostContextMaintenance;
}>()("grokbox/HostCompact") {}
