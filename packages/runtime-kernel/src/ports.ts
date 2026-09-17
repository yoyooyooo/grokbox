import { Context, Effect, Stream } from "effect";
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

export type ControllerReceipt = {
  outcome: "preview" | "refused" | "signaled" | "partial" | "recovery-required" | "unknown" | "converged";
  reason: string | null;
  signaled: boolean;
  spawned: boolean;
  guardian: boolean;
  operationId: string;
};

export type LeaseDecision =
  | { status: "acquired" }
  | { status: "duplicate" }
  | { status: "busy" }
  | { status: "uncertain" }
  | { status: "conflict" }
  | { status: "corrupt" };

export type OperationPrefix = {
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
  readonly signal: (input: FrozenControllerCommand) => Effect.Effect<{ signaled: boolean }, unknown>;
  readonly spawn: (input: FrozenControllerCommand) => Effect.Effect<{ spawned: boolean }, unknown>;
  readonly armGuardian: (input: FrozenControllerCommand) => Effect.Effect<{ guardian: boolean }, unknown>;
  readonly wait: (input: FrozenControllerCommand) => Effect.Effect<void, unknown>;
  readonly commit: (input: FrozenControllerCommand) => Effect.Effect<{ committed: boolean }, unknown>;
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
