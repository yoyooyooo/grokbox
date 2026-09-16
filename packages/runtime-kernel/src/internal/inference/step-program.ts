import { Clock, Context, Deferred, Effect, Exit, Option, Stream, SynchronizedRef } from "effect";
import * as Scope from "effect/Scope";
import { BackendFailure, type InferenceEvent } from "../contract/events.ts";
import { AUTHORITY_REASONS, annotateStreamFailure, streamFailureDiagnostic, type AuthorityDiagnostic } from "../contract/stream-diagnostic.ts";
import { BindingFailure, type CancelStepRequest, type DuplicateStep, type RunStepRequest } from "../contract/binding.ts";
import { emptyRecoveryLedger } from "../contract/overflow.ts";
import { AdmissionAuthority, BackendAuth, ConfigurationRead, HostCompact, ModelBackend, type AuthLease, type PreparedCall } from "../../ports.ts";
import { runOverflowRecovery } from "./overflow-recovery.ts";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, modelForAgent, qualifiedContextWindowTokens } from "../../selection.ts";
import {
  InferenceMemory,
  coldTurn,
  coolInactiveTurns,
  bindingStoreKey,
  ledgerKey,
  makeBindingId,
  turnKey,
  type RouteBindingRecord,
  type InferenceMemoryValue,
  type LedgerStatus,
} from "./route-binding.ts";
import { applyCancel, assertStepIdentity, occupy, releaseOccupancy, type OccupyResult } from "./step-ledger.ts";
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

function authorityDenied(reason: unknown, checkpoint: AuthorityDiagnostic["checkpoint"], extra: { durationMs?: number; evidenceAgeMs?: number } = {}) {
  const safe = typeof reason === "string" && (AUTHORITY_REASONS as readonly string[]).includes(reason) ? reason as AuthorityDiagnostic["reason"] : "unknown";
  return annotateStreamFailure(new BindingFailure("not_admitted"), { rejectSite: "authority_check", authority: { reason: safe, checkpoint, ...extra } });
}
function readAuthority(request: RunStepRequest, checkpoint: AuthorityDiagnostic["checkpoint"] = "admission") {
  return Effect.gen(function* () {
    const authority = yield* AdmissionAuthority;
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* Effect.result(authority.current(request));
    const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
    if (result._tag === "Failure") return yield* Effect.fail(authorityDenied("authority_unavailable", checkpoint, { durationMs }));
    const evidence = result.success;
    if (!evidence || typeof evidence !== "object" || !("admitted" in evidence) || evidence.admitted !== true) {
      return yield* Effect.fail(authorityDenied(evidence && typeof evidence === "object" && "reason" in evidence ? evidence.reason : "unknown", checkpoint, { durationMs }));
    }
    const fact = evidence && typeof evidence === "object" && "ownership" in evidence ? evidence.ownership : undefined;
    const now = yield* Clock.currentTimeMillis;
    if (!fact || typeof fact !== "object" || !("scopeId" in fact) || !("serverId" in fact) || !("observedAtMs" in fact)
      || typeof fact.scopeId !== "string" || !/^[a-f0-9]{64}$/.test(fact.scopeId)
      || typeof fact.serverId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(fact.serverId)
      || typeof fact.observedAtMs !== "number" || !Number.isFinite(fact.observedAtMs)
      || fact.observedAtMs > now || now - fact.observedAtMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS) {
      const evidenceAgeMs = fact && typeof fact === "object" && "observedAtMs" in fact && typeof fact.observedAtMs === "number" && Number.isFinite(fact.observedAtMs) ? Math.max(0, now - fact.observedAtMs) : undefined;
      return yield* Effect.fail(authorityDenied(evidenceAgeMs !== undefined && evidenceAgeMs > OWNERSHIP_EVIDENCE_MAX_AGE_MS ? "ownership_evidence_stale" : "ownership_evidence_invalid", checkpoint, { durationMs, evidenceAgeMs }));
    }
    const memory = yield* InferenceMemory;
    const state = yield* SynchronizedRef.get(memory.ref);
    const bound = state.bindings.get(bindingStoreKey(request));
    if (state.turns.get(turnKey(request))?.poisoned || (bound && (bound.ownership.scopeId !== fact.scopeId || bound.ownership.serverId !== fact.serverId))) {
      return yield* Effect.fail(authorityDenied(state.turns.get(turnKey(request))?.poisoned ? "turn_revoked" : "ownership_identity_changed", checkpoint, { durationMs }));
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
    yield* readAuthority(request, "before_dispatch");
    const memory = yield* InferenceMemory;
    const cancelled = (yield* SynchronizedRef.get(memory.ref)).ledger.get(ledgerKey(request))?.status === "cancelled";
    if (cancelled) return yield* Effect.fail(new BindingFailure("cancelled"));
    const auth = yield* BackendAuth;
    yield* auth.verify(lease).pipe(Effect.mapError(() => new BindingFailure("auth_mismatch")));
    yield* readAuthority(request, "after_auth");
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
    yield* readAuthority(request, "recovery");
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
        ? readAuthority(request, event.type === "backend_finish" ? "finish" : event.type).pipe(Effect.asVoid) : Effect.void);
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
          if (event.type === "tool_start" || event.type === "tool_complete" || event.type === "backend_finish") {
            yield* readAuthority(request, event.type === "backend_finish" ? "finish" : event.type).pipe(Effect.tapError(error => Effect.sync(() => {
              // If the gate holds a valid backend terminal, retain its provider
              // summary rather than misreporting the gate as a provider failure.
              if (event.type === "backend_finish" && event.stream) annotateStreamFailure(error, { stream: event.stream });
            })));
          }
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

/** Atomic admission: persist the identity before any auth/provider effect. A
 * timeout after the write but before its acknowledgement absorbs this STEP; it
 * cannot turn an uncertain submission into permission to run it a second time. */
function reserveStep(memory: InferenceMemoryValue, request: RunStepRequest, now: number) {
  return SynchronizedRef.modifyEffect(memory.ref, state => Effect.gen(function* () {
    const invalid = assertStepIdentity(request);
    if (invalid) return [{ ok: false, error: invalid } as OccupyResult, state] as const;
    if (request.serviceEpoch.incarnationId !== state.serviceEpoch) return [{ ok: false, error: new BindingFailure("service_epoch_mismatch") } as OccupyResult, state] as const;
    const key = ledgerKey(request), tk = turnKey(request);
    const archivedStep = state.ledger.has(key) ? undefined : yield* memory.history.getStep(key);
    const archivedTurn = state.bindings.has(tk) ? undefined : yield* memory.history.getTurn(tk);
    const working: InferenceState = { ...state, ledger: new Map(state.ledger), turns: new Map(state.turns) };
    if (archivedStep) working.ledger.set(key, archivedStep);
    if (archivedTurn && !working.turns.has(tk)) working.turns.set(tk, { ...archivedTurn.turn });
    const result = occupy(working, request, now);
    if (!result.ok) return [result, state] as const;
    if (result.kind === "duplicate") {
      memory.counters.duplicate++;
      return [{ ...result, state }, state] as const;
    }
    yield* memory.history.putStep(key, result.state.ledger.get(key)!);
    const turn = coldTurn(result.state, tk)!;
    yield* memory.history.putTurn(tk, archivedTurn?.binding ? { ...turn, binding: archivedTurn.binding } : turn);
    memory.counters.accepted++;
    return [result, result.state] as const;
  }));
}

/** Historical records leave RAM after settlement. Their durable identity claim
 * remains even if writing the descriptive final status fails. Such a failure
 * degrades storage health, never rolls back a tool or permits a replay. */
function settleStep(memory: InferenceMemoryValue, request: RunStepRequest, status: LedgerStatus) {
  return SynchronizedRef.updateEffect(memory.ref, state => Effect.gen(function* () {
    const key = ledgerKey(request), tk = turnKey(request), entry = state.ledger.get(key);
    if (!entry) return state;
    const next = releaseOccupancy(state, request, status);
    const settled = next.ledger.get(key)!;
    yield* memory.history.putStep(key, settled).pipe(Effect.catch(() => Effect.sync(() => { memory.counters.cleanupFailures++; })));
    const turn = coldTurn(next, tk);
    if (turn) {
      // A failed cold read is not proof that the old binding is absent. Keep
      // the original durable record rather than overwriting it with a cache
      // miss during cleanup. That would revoke a valid long-running TURN (or
      // let it silently select a new model on a later unbound request).
      yield* Effect.gen(function* () {
        const previous = turn.binding ? undefined : yield* memory.history.getTurn(tk);
        const merged = turn.binding || !previous?.binding ? turn : { ...turn, binding: previous.binding };
        if (merged.turn.bindingId && !merged.binding) return yield* Effect.fail(new BindingFailure("ledger_unavailable"));
        yield* memory.history.putTurn(tk, merged);
      }).pipe(Effect.catch(() => Effect.sync(() => { memory.counters.cleanupFailures++; })));
    }
    next.ledger.delete(key);
    memory.counters.reclaimedSteps++;
    if (status === "terminal") memory.counters.completed++;
    return next;
  }));
}

export function runStep(request: RunStepRequest) {
  return Effect.gen(function* () {
    const memory = yield* InferenceMemory;
    const now = yield* Clock.currentTimeMillis;
    // Cache maintenance has no authority to reject unrelated work. Failed
    // cooling retains the hot owner; the actual identity claim below still
    // must commit successfully before this request may dispatch.
    yield* coolInactiveTurns(memory, now).pipe(Effect.catch(() => Effect.sync(() => { memory.counters.cleanupFailures++; })));
    const release = (status: "rejected" | "terminal" | "cancelled") => settleStep(memory, request, status);
    // Acquisition and finalizer registration are one interrupt-safe boundary.
    // It must not be possible to commit an active slot and cancel before its owner exists.
    const occupied = yield* Effect.acquireRelease(reserveStep(memory, request, now), result =>
      !result.ok || result.kind === "duplicate" ? Effect.void : Effect.gen(function* () {
      yield* haltProducer(memory.cancels, ledgerKey(request));
      yield* SynchronizedRef.update(memory.ref, state => {
        const entry = state.ledger.get(ledgerKey(request));
        if (entry?.status === "active") {
          const turn = state.turns.get(turnKey(request));
          if (turn && !turn.bindingId) turn.poisoned = true;
        }
        return state;
      });
      yield* release("rejected");
      memory.recoveries.delete(ledgerKey(request));
      const at = yield* Clock.currentTimeMillis;
      yield* coolInactiveTurns(memory, at).pipe(Effect.catch(() => Effect.sync(() => { memory.counters.cleanupFailures++; })));
    }));
    if (!occupied.ok) return yield* Effect.fail(occupied.error);
    if (occupied.kind === "duplicate") return { kind: "duplicate" as const, bindingId: occupied.bindingId, snapshotDigest: occupied.snapshotDigest };

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
    const cached = (yield* SynchronizedRef.get(memory.ref)).bindings.get(storeKey);
    const archived = cached ? undefined : yield* memory.history.getTurn(storeKey);
    const existing = cached ?? archived?.binding;

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
      if (cached) lease = cached.lease;
      else {
        // Resource reacquisition is NOT credential rotation or model selection.
        // Verify the original immutable fingerprint and ownership before use.
        if (existing.ownership.scopeId !== ownership.scopeId || existing.ownership.serverId !== ownership.serverId) {
          // Match the hot-binding authority fence: a revoked TURN stays
          // poisoned even if ownership later changes back. Cache residency
          // must never weaken the authorization lifetime.
          yield* SynchronizedRef.update(memory.ref, current => {
            const turn = current.turns.get(turnKey(request));
            if (turn) turn.poisoned = true;
            return current;
          });
          return yield* Effect.fail(new BindingFailure("not_admitted"));
        }
        const pinned = yield* pinOnTurn(request, existing.model.apiKeyRef);
        if (pinned.fingerprint !== existing.fingerprint) {
          const rejectedScope = memory.turnScopes.get(storeKey);
          memory.turnScopes.delete(storeKey);
          if (rejectedScope) yield* Scope.close(rejectedScope, Exit.void);
          return yield* Effect.fail(new BindingFailure("auth_mismatch"));
        }
        lease = pinned.lease;
        memory.counters.coldRestores++;
        yield* SynchronizedRef.update(memory.ref, current => {
          current.bindings.set(storeKey, { ...existing, lease, lastActivityMs: now });
          return current;
        });
      }
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
    // Binding acknowledgement is published only after its durable metadata is
    // available; the initial claimed identity already prevents re-execution.
    yield* SynchronizedRef.updateEffect(memory.ref, current => Effect.gen(function* () {
      const entry = current.ledger.get(ledgerKey(request));
      if (entry) yield* memory.history.putStep(ledgerKey(request), entry);
      const turn = coldTurn(current, storeKey);
      if (turn) yield* memory.history.putTurn(storeKey, turn);
      return current;
    }));
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
    const applied = yield* SynchronizedRef.modifyEffect(memory.ref, (state): Effect.Effect<readonly [ReturnType<typeof applyCancel>, InferenceState], BindingFailure> => Effect.gen(function* () {
      const active = state.ledger.has(key);
      const archived = active ? undefined : yield* memory.history.getStep(key);
      const working = { ...state, ledger: new Map(state.ledger) };
      if (archived) working.ledger.set(key, archived);
      const result = applyCancel(working, request);
      if (!result.ok) return [result, state] as const;
      const entry = result.state.ledger.get(key);
      if (entry) yield* memory.history.putStep(key, entry);
      if (!active) result.state.ledger.delete(key);
      return [result, result.state] as const;
    }));
    if (!applied.ok) return yield* Effect.fail(applied.error);
  });
}
