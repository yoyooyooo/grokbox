import { Effect, Layer, Stream } from "effect";
import {
  BackendFailure,
  applyInferenceEvent,
  emptyStreamValidation,
  finishInferenceStream,
  type InferenceEvent,
} from "../contract/events.ts";
import { sha256Text } from "../../hash.ts";
import { BackendAuth, ModelBackend, type AuthLease, type PreparedCall } from "../../ports.ts";

const prepared = new WeakMap<PreparedCall, { snapshot: unknown }>();
const leases = new WeakMap<AuthLease, { fingerprint: string; secret: string }>();

export type CountedSeams = {
  credential: number;
  network: number;
};

export function createCountedSeams(): CountedSeams {
  return { credential: 0, network: 0 };
}

function handle<T extends object>(tag: string): T {
  return Object.freeze(Object.create(null)) as T;
}

export function fakeBackendAuthLayer(secret = "synthetic-secret", counts?: CountedSeams): Layer.Layer<BackendAuth> {
  const fingerprint = sha256Text(secret);
  return Layer.succeed(BackendAuth, {
    pin: (_input: unknown) => Effect.acquireRelease(
      Effect.sync(() => {
        if (counts) counts.credential += 1;
        const lease = handle<AuthLease>("auth");
        leases.set(lease, { fingerprint, secret });
        return { lease, fingerprint };
      }),
      ({ lease }) => Effect.sync(() => {
        leases.delete(lease);
      }),
    ),
    verify: (lease: AuthLease) => Effect.sync(() => {
      if (!leases.has(lease)) throw new BackendFailure("auth_mismatch");
    }),
  });
}

export function fakeModelBackendLayer(events: InferenceEvent[], counts?: CountedSeams): Layer.Layer<ModelBackend> {
  return Layer.succeed(ModelBackend, {
    prepare: (_selection: unknown, snapshot: unknown) => Effect.sync(() => {
      const call = handle<PreparedCall>("prepared");
      prepared.set(call, { snapshot });
      return call;
    }),
    infer: (_admitted: unknown, call: PreparedCall, _lease: AuthLease) => {
      if (!prepared.has(call)) {
        return Stream.fail(new BackendFailure("invalid_prepared_call"));
      }
      let started = false;
      return Stream.fromAsyncIterable((async function* () {
        if (started) return;
        started = true;
        if (counts) counts.network += 1;
        const state = emptyStreamValidation();
        for (const event of events) {
          applyInferenceEvent(state, event);
          yield event;
        }
        finishInferenceStream(state);
      })(), (error) => error instanceof BackendFailure ? error : new BackendFailure("stream_invalid"));
    },
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
