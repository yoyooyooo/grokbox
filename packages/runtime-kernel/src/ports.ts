import { Context, Effect, Stream } from "effect";
import type { Scope } from "effect/Scope";
import type { ModelsFile, DesiredFile } from "./selection.ts";
import type { StatusEvidence } from "./internal/contract/status.ts";
import type { InferenceEvent } from "./internal/contract/events.ts";

/** Process-local opaque handle. Not a contract DTO; never stringify, log, or put on the wire. */
export type PreparedCall = { readonly _PreparedCall: unique symbol };
export type AuthLease = { readonly _AuthLease: unique symbol };

export type ConfigurationSnapshot = {
  models: ModelsFile;
  desired: DesiredFile;
};

export class ConfigurationRead extends Context.Service<ConfigurationRead, {
  readonly snapshot: () => Effect.Effect<ConfigurationSnapshot, unknown>;
}>()("grokbox/ConfigurationRead") {}

export class ConfigurationWrite extends Context.Service<ConfigurationWrite, {
  readonly saveModels: (file: ModelsFile) => Effect.Effect<{ configRevision: string }, unknown>;
  readonly saveDesired: (file: DesiredFile) => Effect.Effect<{ configRevision: string }, unknown>;
}>()("grokbox/ConfigurationWrite") {}

export class AdmissionAuthority extends Context.Service<AdmissionAuthority, {
  readonly current: () => Effect.Effect<unknown, unknown>;
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

export class HostCompact extends Context.Service<HostCompact, {
  readonly request: (input: unknown) => Effect.Effect<unknown, unknown>;
}>()("grokbox/HostCompact") {}
