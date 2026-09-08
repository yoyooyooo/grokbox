import { Clock, Effect, Stream, SynchronizedRef } from "effect";
import { BackendFailure, type InferenceEvent } from "../contract/events.ts";
import { BindingFailure, type CancelStepRequest, type DuplicateStep, type RunStepRequest } from "../contract/binding.ts";
import { AdmissionAuthority, BackendAuth, ConfigurationRead, ModelBackend, type AuthLease } from "../../ports.ts";
import { captureManagedSelection, modelForAgent } from "../../selection.ts";
import {
  InferenceMemory,
  bindingStoreKey,
  ledgerKey,
  makeBindingId,
  turnKey,
  type RouteBindingRecord,
} from "./route-binding.ts";
import { markCancelled, occupy, releaseOccupancy, type OccupyResult } from "./step-ledger.ts";
import type { InferenceState } from "./route-binding.ts";
import { fenceStream } from "./stream-state.ts";

export type LiveStep = {
  kind: "live";
  bindingId: string;
  stream: Stream.Stream<InferenceEvent, BindingFailure | BackendFailure>;
};

export type AdmittedStep = DuplicateStep | LiveStep;

function asBindingOrBackend(error: unknown): BindingFailure | BackendFailure {
  if (error instanceof BindingFailure || error instanceof BackendFailure) return error;
  return new BindingFailure("not_admitted");
}

export function runStep(request: RunStepRequest) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const now = yield* Clock.currentTimeMillis;
    const occupied = yield* SynchronizedRef.modify(memory.ref, (state): readonly [OccupyResult, InferenceState] => {
      const result = occupy(state, request, now);
      if (!result.ok) return [result, state];
      if (result.kind === "duplicate") return [result, state];
      return [result, result.state];
    });
    if (!occupied.ok) return yield* Effect.fail(occupied.error);
    if (occupied.kind === "duplicate") {
      return { kind: "duplicate", bindingId: occupied.bindingId, snapshotDigest: occupied.snapshotDigest };
    }

    const release = (status: "rejected" | "terminal" | "cancelled") =>
      SynchronizedRef.update(memory.ref, (state) => releaseOccupancy(state, request, status));

    return yield* admitLive(request, now).pipe(
      Effect.onInterrupt(() => SynchronizedRef.update(memory.ref, (state) => markCancelled(state, request))),
      Effect.matchEffect({
        onFailure: (error) => release("rejected").pipe(Effect.andThen(Effect.fail(asBindingOrBackend(error)))),
        onSuccess: (live) => Effect.succeed({
          ...live,
          stream: Stream.ensuring(
            Stream.tap(live.stream, (event) => event.type === "backend_finish" ? release("terminal") : Effect.void),
            Effect.gen(function* () {
              const current = yield* SynchronizedRef.get(memory.ref);
              const entry = current.ledger.get(ledgerKey(request));
              if (entry?.status === "active") {
                yield* release(current.cancelled.has(ledgerKey(request)) ? "cancelled" : "rejected");
              }
            }),
          ),
        }),
      }),
    );
  });
}

function admitLive(request: RunStepRequest, now: number) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const config = yield* ConfigurationRead;
    const snapshot = yield* config.snapshot();
    const captured = captureManagedSelection(snapshot.models, request.agentId);
    if (captured.kind !== "managed") return yield* Effect.fail(new BindingFailure("not_admitted"));
    if (captured.modelId !== request.selection.modelId || captured.selectionRevision !== request.selection.selectionRevision) {
      return yield* Effect.fail(new BindingFailure("selection_mismatch"));
    }
    const model = modelForAgent(snapshot.models, request.agentId);
    if (!model) return yield* Effect.fail(new BindingFailure("not_admitted"));

    const authority = yield* AdmissionAuthority;
    yield* authority.current().pipe(Effect.mapError(() => new BindingFailure("not_admitted")));

    const backend = yield* ModelBackend;
    const prepared = yield* backend.prepare(model, request.snapshot).pipe(Effect.mapError(asBindingOrBackend));

    const auth = yield* BackendAuth;
    const state = yield* SynchronizedRef.get(memory.ref);
    const storeKey = bindingStoreKey(request);
    const existing = state.bindings.get(storeKey);

    let bindingId: string;
    let lease: AuthLease;
    if (existing) {
      if (!request.bindingId) return yield* Effect.fail(new BindingFailure("binding_missing"));
      if (request.bindingId !== existing.bindingId) return yield* Effect.fail(new BindingFailure("binding_mismatch"));
      if (request.selection.modelId !== existing.selection.modelId) {
        return yield* Effect.fail(new BindingFailure("binding_mismatch"));
      }
      if (existing.serviceEpoch.incarnationId !== request.serviceEpoch.incarnationId) {
        return yield* Effect.fail(new BindingFailure("service_epoch_mismatch"));
      }
      yield* auth.verify(existing.lease).pipe(Effect.mapError(() => new BindingFailure("auth_mismatch")));
      bindingId = existing.bindingId;
      lease = existing.lease;
      yield* SynchronizedRef.update(memory.ref, (current) => {
        const bound = current.bindings.get(storeKey);
        if (bound) bound.lastActivityMs = now;
        const turn = current.turns.get(turnKey(request));
        if (turn) turn.lastActivityMs = now;
        const entry = current.ledger.get(ledgerKey(request));
        if (entry) entry.bindingId = bindingId;
        return current;
      });
    } else {
      if (request.bindingId) return yield* Effect.fail(new BindingFailure("binding_missing"));
      const pinned = yield* auth.pin({ apiKeyRef: model.apiKeyRef }).pipe(Effect.mapError(asBindingOrBackend));
      bindingId = makeBindingId({
        hostEpoch: request.hostEpoch,
        agentId: request.agentId,
        turnId: request.turnId,
        serviceEpoch: request.serviceEpoch.incarnationId,
        selectionRevision: request.selection.selectionRevision,
      });
      lease = pinned.lease;
      const record: RouteBindingRecord = {
        bindingId,
        hostEpoch: request.hostEpoch,
        serviceEpoch: request.serviceEpoch,
        agentId: request.agentId,
        turnId: request.turnId,
        selection: request.selection,
        fingerprint: pinned.fingerprint,
        lease,
        lastActivityMs: now,
      };
      yield* SynchronizedRef.update(memory.ref, (current) => {
        current.bindings.set(storeKey, record);
        const turn = current.turns.get(turnKey(request));
        if (turn) {
          turn.bindingId = bindingId;
          turn.lastActivityMs = now;
        }
        const entry = current.ledger.get(ledgerKey(request));
        if (entry) entry.bindingId = bindingId;
        return current;
      });
    }

    const cancelled = SynchronizedRef.get(memory.ref).pipe(
      Effect.map((current) => current.cancelled.has(ledgerKey(request))),
    );
    return {
      kind: "live" as const,
      bindingId,
      stream: fenceStream(backend.infer({}, prepared, lease), cancelled),
    };
  });
}

export function cancelStep(request: CancelStepRequest): Effect.Effect<void, BindingFailure, InferenceMemory> {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    yield* SynchronizedRef.update(memory.ref, (state) => markCancelled(state, request));
  });
}
