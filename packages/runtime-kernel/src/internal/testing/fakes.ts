import { Effect, Layer, Stream } from "effect";
import {
  BackendFailure,
  applyInferenceEvent,
  emptyStreamValidation,
  finishInferenceStream,
  type InferenceEvent,
} from "../contract/events.ts";
import { sha256Text } from "../../hash.ts";
import { AdmissionAuthority, BackendAuth, ConfigurationRead, ModelBackend, type AuthLease, type PreparedCall } from "../../ports.ts";
import type { ModelsFile, DesiredFile } from "../../selection.ts";

const prepared = new WeakMap<PreparedCall, { snapshot: unknown }>();
const leases = new WeakMap<AuthLease, { fingerprint: string; secret: string }>();

export type CountedSeams = {
  credential: number;
  network: number;
  prepare: number;
  verify: number;
  authority: number;
  leasesAlive: number;
  order: string[];
};

export function createCountedSeams(): CountedSeams {
  return { credential: 0, network: 0, prepare: 0, verify: 0, authority: 0, leasesAlive: 0, order: [] };
}

function handle<T extends object>(tag: string): T {
  return Object.freeze(Object.create(null)) as T;
}

export function fakeBackendAuthLayer(
  secret = "synthetic-secret",
  counts?: CountedSeams,
  options?: {
    afterMaterialize?: Effect.Effect<void>;
    beforeVerify?: Effect.Effect<void>;
    verifyOk?: () => boolean;
  },
): Layer.Layer<BackendAuth> {
  const fingerprint = sha256Text(secret);
  return Layer.succeed(BackendAuth, {
    pin: (_input: unknown) => Effect.acquireRelease(
      Effect.gen(function* () {
        if (counts) {
          counts.credential += 1;
          counts.leasesAlive += 1;
          counts.order.push("pin");
        }
        if (options?.afterMaterialize) yield* options.afterMaterialize;
        const lease = handle<AuthLease>("auth");
        leases.set(lease, { fingerprint, secret });
        return { lease, fingerprint };
      }),
      ({ lease }) => Effect.sync(() => {
        leases.delete(lease);
        if (counts) counts.leasesAlive = Math.max(0, counts.leasesAlive - 1);
      }),
    ),
    verify: (lease: AuthLease) => Effect.gen(function* () {
      if (counts) {
        counts.verify += 1;
        counts.order.push("verify");
      }
      if (options?.beforeVerify) yield* options.beforeVerify;
      if (options?.verifyOk && !options.verifyOk()) return yield* Effect.fail(new BackendFailure("auth_mismatch"));
      if (!leases.has(lease)) return yield* Effect.fail(new BackendFailure("auth_mismatch"));
    }),
  });
}

export function fakeModelBackendLayer(
  events: InferenceEvent[],
  counts?: CountedSeams,
  options?: { beforeInfer?: Effect.Effect<void>; failAfterFirst?: boolean; afterStream?: Effect.Effect<void> },
): Layer.Layer<ModelBackend> {
  return Layer.succeed(ModelBackend, {
    prepare: (_selection: unknown, snapshot: unknown) => Effect.sync(() => {
      if (counts) {
        counts.prepare += 1;
        counts.order.push("prepare");
      }
      const call = handle<PreparedCall>("prepared");
      prepared.set(call, { snapshot });
      return call;
    }),
    infer: (_admitted: unknown, call: PreparedCall, _lease: AuthLease) => {
      if (!prepared.has(call)) {
        return Stream.fail(new BackendFailure("invalid_prepared_call"));
      }
      let started = false;
      return Stream.ensuring(
        Stream.unwrap(Effect.gen(function* () {
          if (options?.beforeInfer) yield* options.beforeInfer;
          return Stream.fromAsyncIterable((async function* () {
            if (started) return;
            started = true;
            if (counts) {
              counts.network += 1;
              counts.order.push("infer");
            }
            const state = emptyStreamValidation();
            for (const [index, event] of events.entries()) {
              applyInferenceEvent(state, event);
              yield event;
              if (options?.failAfterFirst && index === 0) throw new BackendFailure("provider_error");
            }
            finishInferenceStream(state);
          })(), (error) => error instanceof BackendFailure ? error : new BackendFailure("stream_invalid"));
        })),
        options?.afterStream ?? Effect.void,
      );
    },
  });
}

export function fakeConfigurationReadLayer(input: {
  models: () => ModelsFile;
  desired?: DesiredFile;
  beforeRead?: Effect.Effect<void>;
}): Layer.Layer<ConfigurationRead> {
  return Layer.succeed(ConfigurationRead, {
    snapshot: () => Effect.gen(function* () {
      if (input.beforeRead) yield* input.beforeRead;
      return {
        models: input.models(),
        desired: input.desired ?? { version: 1, mode: "route" as const },
      };
    }),
  });
}

export function fakeAdmissionAuthorityLayer(
  evidence: () => unknown = () => ({ admitted: true }),
  counts?: CountedSeams,
): Layer.Layer<AdmissionAuthority> {
  return Layer.succeed(AdmissionAuthority, {
    current: () => Effect.gen(function* () {
      if (counts) {
        counts.authority += 1;
        counts.order.push("authority");
      }
      return evidence();
    }),
  });
}

export function peekFakeSecret(lease: AuthLease): string | undefined {
  return leases.get(lease)?.secret;
}

export function unsealFakeAuth(lease: AuthLease): string {
  const record = leases.get(lease);
  if (!record) throw new BackendFailure("auth_mismatch");
  return record.secret;
}
