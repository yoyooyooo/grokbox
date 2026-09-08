import { Context, Effect, Stream } from "effect";
import type { ModelsFile, DesiredFile } from "./selection.ts";

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
  readonly pin: (input: unknown) => Effect.Effect<{ lease: AuthLease; fingerprint: string }, unknown>;
  readonly verify: (lease: AuthLease) => Effect.Effect<void, unknown>;
}>()("grokbox/BackendAuth") {}

export class ModelBackend extends Context.Service<ModelBackend, {
  readonly prepare: (selection: unknown, snapshot: unknown) => Effect.Effect<PreparedCall, unknown>;
  readonly infer: (
    admittedCall: unknown,
    prepared: PreparedCall,
    authLease: AuthLease,
  ) => Stream.Stream<unknown, unknown>;
}>()("grokbox/ModelBackend") {}

export class RuntimeEvents extends Context.Service<RuntimeEvents, {
  readonly append: (event: unknown) => Effect.Effect<void, unknown>;
}>()("grokbox/RuntimeEvents") {}

export class ModeldControl extends Context.Service<ModeldControl, {
  readonly ensure: () => Effect.Effect<unknown, unknown>;
}>()("grokbox/ModeldControl") {}

export class ControlResources extends Context.Service<ControlResources, {
  readonly lease: (input: unknown) => Effect.Effect<unknown, unknown>;
}>()("grokbox/ControlResources") {}

export class ObservationRead extends Context.Service<ObservationRead, {
  readonly snapshot: () => Effect.Effect<unknown, unknown>;
}>()("grokbox/ObservationRead") {}

export class HostCompact extends Context.Service<HostCompact, {
  readonly request: (input: unknown) => Effect.Effect<unknown, unknown>;
}>()("grokbox/HostCompact") {}
