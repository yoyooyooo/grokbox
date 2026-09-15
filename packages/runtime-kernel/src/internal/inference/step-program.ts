import { Clock, Context, Deferred, Effect, Option, Stream, SynchronizedRef } from "effect";
import * as Scope from "effect/Scope";
import { BackendFailure, type InferenceEvent } from "../contract/events.ts";
import { BindingFailure, type CancelStepRequest, type DuplicateStep, type RunStepRequest } from "../contract/binding.ts";
import { emptyRecoveryLedger } from "../contract/overflow.ts";
import { AdmissionAuthority, BackendAuth, ConfigurationRead, HostCompact, ModelBackend, type AuthLease, type PreparedCall } from "../../ports.ts";
import { runOverflowRecovery } from "./overflow-recovery.ts";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, modelForAgent, qualifiedContextWindowTokens } from "../../selection.ts";
import {
  InferenceMemory,
  bindingStoreKey,
  ledgerKey,
  makeBindingId,
  turnKey,
  type RouteBindingRecord,
} from "./route-binding.ts";
import { applyCancel, occupy, releaseOccupancy, type OccupyResult } from "./step-ledger.ts";
import type { InferenceState } from "./route-binding.ts";
import { contextSnapshotBody, parseContextSnapshot } from "../contract/snapshot.ts";
import { computeSnapshotDigest } from "../../hash.ts";
import { fenceStream } from "./stream-state.ts";
import { OWNERSHIP_EVIDENCE_MAX_AGE_MS, type OwnershipAdmission } from "../contract/ownership.ts";

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

function requireAdmitted(evidence: unknown): Effect.Effect<void, BindingFailure> {
  if (evidence && typeof evidence === "object" && "admitted" in evidence && (evidence as { admitted: unknown }).admitted === true) {
    return Effect.void;
  }
  return Effect.fail(new BindingFailure("not_admitted"));
}

function readAuthority(request: RunStepRequest) {
  return Effect.gen(function* () {
    const authority = yield* AdmissionAuthority;
    const evidence = yield* authority.current(request).pipe(Effect.mapError(() => new BindingFailure("not_admitted")));
    yield* requireAdmitted(evidence);
    const fact = evidence && typeof evidence === "object" && "ownership" in evidence ? evidence.ownership : undefined;
    const now = yield* Clock.currentTimeMillis;
    if (!fact || typeof fact !== "object" || !("scopeId" in fact) || !("serverId" in fact) || !("observedAtMs" in fact)
      || typeof fact.scopeId !== "string" || !/^[a-f0-9]{64}$/.test(fact.scopeId)
      || typeof fact.serverId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(fact.serverId)
      || typeof fact.observedAtMs !== "number" || !Number.isFinite(fact.observedAtMs)
      || fact.observedAtMs > now || now - fact.observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
      return yield* Effect.fail(new BindingFailure("not_admitted"));
    }
    const memory = yield* InferenceMemory;
    const state = yield* SynchronizedRef.get(memory.ref);
    const bound = state.bindings.get(bindingStoreKey(request));
    if (state.turns.get(turnKey(request))?.poisoned || (bound && (bound.ownership.scopeId !== fact.scopeId || bound.ownership.serverId !== fact.serverId))) {
      return yield* Effect.fail(new BindingFailure("not_admitted"));
    }
    return fact as OwnershipAdmission;
  }).pipe(Effect.tapError(() => Effect.gen(function* () {
    // Revoked/unknown authority never comes back by reusing the same old TURN.
    const memory = yield* InferenceMemory;
    yield* SynchronizedRef.update(memory.ref, state => {
      const turn = state.turns.get(turnKey(request));
      if (turn) turn.poisoned = true;
      return state;
    });
  })));
}

function dispatchFence(request: RunStepRequest, lease: AuthLease) {
  return Effect.gen(function* () {
    yield* readAuthority(request);
    const memory = yield* InferenceMemory;
    const cancelled = (yield* SynchronizedRef.get(memory.ref)).ledger.get(ledgerKey(request))?.status === "cancelled";
    if (cancelled) return yield* Effect.fail(new BindingFailure("cancelled"));
    const auth = yield* BackendAuth;
    yield* auth.verify(lease).pipe(Effect.mapError(() => new BindingFailure("auth_mismatch")));
    yield* readAuthority(request);
    const after = (yield* SynchronizedRef.get(memory.ref)).ledger.get(ledgerKey(request))?.status === "cancelled";
    if (after) return yield* Effect.fail(new BindingFailure("cancelled"));
  });
}

function pinOnTurn(request: RunStepRequest, apiKeyRef: string) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const key = bindingStoreKey(request);
    let scope = memory.turnScopes.get(key);
    if (!scope) {
      scope = Scope.makeUnsafe();
      memory.turnScopes.set(key, scope);
    }
    const auth = yield* BackendAuth;
    return yield* auth.pin({ apiKeyRef }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(asBindingOrBackend),
    );
  });
}

function haltProducer(cancels: Map<string, Deferred.Deferred<void>>, key: string) {
  const halt = cancels.get(key);
  if (!halt) return Effect.void;
  return Deferred.succeed(halt, undefined).pipe(Effect.ignore);
}

function recoverOverflowStream(
  request: RunStepRequest,
  lease: AuthLease,
  error: BackendFailure,
  released: { text: number; reasoning: number; tools: number },
  cancelled: Effect.Effect<boolean>,
) {
  return Stream.unwrap(Effect.gen(function* () {
    const ctx = yield* Effect.context<never>();
    const compact = Context.getOption(ctx as Context.Context<HostCompact>, HostCompact);
    if (Option.isNone(compact)) return Stream.fail(error);
    const memory = yield* InferenceMemory;
    const binding = (yield* SynchronizedRef.get(memory.ref)).bindings.get(bindingStoreKey(request));
    if (!binding) return Stream.fail(error);
    const identity = {
      agentId: request.agentId,
      turnId: request.turnId,
      stepId: request.stepId,
      bindingId: binding.bindingId,
      selectionRevision: request.selection.selectionRevision,
    };
    const key = ledgerKey(request);
    let ledger = memory.recoveries.get(key);
    if (!ledger) {
      ledger = emptyRecoveryLedger(identity, request.stepId);
      memory.recoveries.set(key, ledger);
    }
    yield* readAuthority(request);
    const recovered = yield* Effect.result(runOverflowRecovery({
      ledger,
      evidence: {
        ...error.overflowEvidence,
        releasedText: released.text,
        releasedReasoning: released.reasoning,
        releasedTools: released.tools,
      },
      identity,
      recoveryNonce: request.stepId,
    }));
    if (recovered._tag === "Failure") return Stream.fail(error);
    const fenced = yield* Effect.result(dispatchFence(request, lease));
    if (fenced._tag === "Failure") return Stream.fail(fenced.failure);
    const backend = yield* ModelBackend;
    const resumed = yield* Effect.try({
      try: () => {
        const compacted = parseContextSnapshot(recovered.success.snapshot);
        if (compacted.profileId !== request.snapshot.profileId || compacted.abiIdentity !== request.snapshot.abiIdentity) {
          throw new BackendFailure("invalid_prepared_call");
        }
        // Host Compact owns replacement messages, not the STEP's admitted tool
        // capability or generation options. It must not remove or inject either.
        const body = contextSnapshotBody({ ...compacted, tools: request.snapshot.tools, options: request.snapshot.options });
        return parseContextSnapshot({ ...body, snapshotDigest: computeSnapshotDigest(body) });
      },
      catch: () => new BackendFailure("invalid_prepared_call"),
    });
    const prepared = yield* backend.prepare(binding.model, resumed).pipe(Effect.mapError(asBindingOrBackend));
    // prepare may suspend: the earlier fence cannot authorize an effect after
    // an ownership/credential change during that suspension. Match attempt0.
    yield* dispatchFence(request, lease);
    return Stream.tap(fenceStream(backend.infer({}, prepared, lease), cancelled), event =>
      event.type === "tool_start" || event.type === "tool_complete" || event.type === "backend_finish"
        ? readAuthority(request).pipe(Effect.asVoid) : Effect.void);
  }));
}

function ownedInfer(request: RunStepRequest, prepared: PreparedCall, lease: AuthLease, halt: Deferred.Deferred<void>) {
  const key = ledgerKey(request);
  return Stream.ensuring(
    Stream.interruptWhen(
      Stream.unwrap(Effect.gen(function* () {
        const memory = yield* InferenceMemory;
        memory.started.add(key);
        yield* dispatchFence(request, lease);
        const backend = yield* ModelBackend;
        const cancelled = SynchronizedRef.get(memory.ref).pipe(
          Effect.map((current) => current.ledger.get(key)?.status === "cancelled"),
        );
        const released = { text: 0, reasoning: 0, tools: 0 };
        const counted = Stream.tap(fenceStream(backend.infer({}, prepared, lease), cancelled), (event) => Effect.gen(function* () {
          // Check again before exposing an executable tool or successful completion.
          // This is not per-token polling, nor a distributed ownership lease.
          if (event.type === "tool_start" || event.type === "tool_complete" || event.type === "backend_finish") yield* readAuthority(request);
          if (event.type === "text_delta" && event.text.length > 0) released.text += 1;
          if (event.type === "reasoning_delta" && event.text.length > 0) released.reasoning += 1;
          if (event.type === "tool_start") released.tools += 1;
        }));
        return counted.pipe(Stream.catchIf(
          (error): error is BackendFailure => error instanceof BackendFailure,
          (error) => recoverOverflowStream(request, lease, error, released, cancelled),
        ));
      })),
      Deferred.await(halt).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled")))),
    ),
    Effect.gen(function* () {
      const memory = yield* InferenceMemory;
      const done = memory.quiesce.get(key);
      if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
    }),
  );
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

    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      yield* haltProducer(memory.cancels, ledgerKey(request));
      yield* SynchronizedRef.update(memory.ref, (state) => {
        const entry = state.ledger.get(ledgerKey(request));
        if (entry?.status !== "active") return state;
        const turn = state.turns.get(turnKey(request));
        if (turn && !turn.bindingId) {
          const cancelled = applyCancel(state, request);
          return cancelled.ok ? cancelled.state : releaseOccupancy(state, request, "cancelled");
        }
        return releaseOccupancy(state, request, "rejected");
      });
    }));

    return yield* admitLive(request, now).pipe(
      Effect.matchEffect({
        onFailure: (error) => release("rejected").pipe(Effect.andThen(Effect.fail(asBindingOrBackend(error)))),
        onSuccess: (live) => Effect.succeed({
          ...live,
          stream: Stream.tap(live.stream, (event) => event.type === "backend_finish" ? release("terminal") : Effect.void),
        }),
      }),
    );
  });
}

function admitLive(request: RunStepRequest, now: number) {
  return Effect.gen(function* () {
    const ownership = yield* readAuthority(request);
    const memory = yield* InferenceMemory;
    const backend = yield* ModelBackend;
    const storeKey = bindingStoreKey(request);
    const existing = (yield* SynchronizedRef.get(memory.ref)).bindings.get(storeKey);

    let bindingId: string;
    let lease: AuthLease;
    let prepared: PreparedCall;
    if (existing) {
      if (!request.bindingId) return yield* Effect.fail(new BindingFailure("binding_missing"));
      if (request.bindingId !== existing.bindingId) return yield* Effect.fail(new BindingFailure("binding_mismatch"));
      if (request.selection.modelId !== existing.selection.modelId) {
        return yield* Effect.fail(new BindingFailure("binding_mismatch"));
      }
      if (request.selection.selectionRevision !== existing.selection.selectionRevision) {
        return yield* Effect.fail(new BindingFailure("selection_mismatch"));
      }
      if (existing.serviceEpoch.incarnationId !== request.serviceEpoch.incarnationId) {
        return yield* Effect.fail(new BindingFailure("service_epoch_mismatch"));
      }
      if (existing.model.id !== STUB_ECHO_MODEL_ID && qualifiedContextWindowTokens(existing.model) === undefined) {
        return yield* Effect.fail(new BindingFailure("not_admitted"));
      }
      prepared = yield* backend.prepare(existing.model, request.snapshot).pipe(Effect.mapError(asBindingOrBackend));
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
      const config = yield* ConfigurationRead;
      const snapshot = yield* config.snapshot();
      // Host capture throws BoxRuntimeError for assigned-but-unresolved models.
      // That is an expected STEP admission failure here, not an Effect defect.
      const captured = yield* Effect.try({
        try: () => captureManagedSelection(snapshot.models, request.agentId),
        catch: asBindingOrBackend,
      });
      if (captured.kind !== "managed") return yield* Effect.fail(new BindingFailure("not_admitted"));
      if (captured.modelId !== request.selection.modelId || captured.selectionRevision !== request.selection.selectionRevision) {
        return yield* Effect.fail(new BindingFailure("selection_mismatch"));
      }
      const resolved = yield* Effect.try({
        try: () => modelForAgent(snapshot.models, request.agentId),
        catch: asBindingOrBackend,
      });
      if (!resolved) return yield* Effect.fail(new BindingFailure("not_admitted"));
      if (resolved.id !== STUB_ECHO_MODEL_ID && qualifiedContextWindowTokens(resolved) === undefined) {
        return yield* Effect.fail(new BindingFailure("not_admitted"));
      }
      prepared = yield* backend.prepare(resolved, request.snapshot).pipe(Effect.mapError(asBindingOrBackend));
      const pinned = yield* pinOnTurn(request, resolved.apiKeyRef);
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
        model: resolved,
        fingerprint: pinned.fingerprint,
        ownership,
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
    const key = ledgerKey(request);
    const halt = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    memory.cancels.set(key, halt);
    memory.quiesce.set(key, done);
    return {
      kind: "live" as const,
      bindingId,
      stream: Stream.ensuring(
        ownedInfer(request, prepared, lease, halt),
        Effect.sync(() => {
          memory.cancels.delete(key);
          memory.quiesce.delete(key);
          memory.started.delete(key);
        }),
      ),
    };
  });
}

export function cancelStep(request: CancelStepRequest): Effect.Effect<void, BindingFailure, InferenceMemory> {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const key = ledgerKey(request);
    const current = yield* SynchronizedRef.get(memory.ref);
    if (request.serviceEpoch.incarnationId !== current.serviceEpoch) {
      return yield* Effect.fail(new BindingFailure("service_epoch_mismatch"));
    }
    yield* haltProducer(memory.cancels, key);
    const done = memory.quiesce.get(key);
    if (done && memory.started.has(key)) yield* Deferred.await(done);
    const applied = yield* SynchronizedRef.modify(memory.ref, (state): readonly [ReturnType<typeof applyCancel>, InferenceState] => {
      const result = applyCancel(state, request);
      if (!result.ok) return [result, state];
      return [result, result.state];
    });
    if (!applied.ok) return yield* Effect.fail(applied.error);
  });
}
