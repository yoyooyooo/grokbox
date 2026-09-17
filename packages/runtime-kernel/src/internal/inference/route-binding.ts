import { Clock, Context, Deferred, Effect, Exit, Layer, Semaphore, SynchronizedRef } from "effect";
import * as Scope from "effect/Scope";
import { canonicalJson, sha256Text } from "../../hash.ts";
import { SERVER_ACTIVE_STEPS_MAX, TURN_RESOURCE_IDLE_MS } from "../contract/limits.ts";
import { memoryExecutionHistory, type ColdTurn, type ExecutionHistory } from "./execution-history.ts";
import type { AuthLease } from "../../ports.ts";
import type { HostEpoch, SelectionIdentity, ServiceEpoch } from "../contract/identity.ts";
import type { ResolvedModelSelection } from "../../selection.ts";
import { BindingFailure, type RunStepRequest } from "../contract/binding.ts";
import type { RecoveryLedger } from "../contract/overflow.ts";
import type { OwnershipAdmission } from "../contract/ownership.ts";
import { NO_PROVIDER_RECOVERY, projectProviderRecoveryPolicy, type ProviderRecoveryPolicy, type ProviderRecoveryState } from "../contract/provider-recovery.ts";
import type { RecoveryProgress } from "./provider-recovery.ts";
import type { AuthorityProgress } from "../contract/authority-progress.ts";
import { STRICT_AUTHORITY_POLICY } from "../contract/authority-policy.ts";

export type LedgerStatus = "active" | "terminal" | "rejected" | "cancelled";

export type LedgerRecord = {
  snapshotDigest: string;
  selectionRevision: string;
  bindingId?: string;
  status: LedgerStatus;
  recovery?: ProviderRecoveryState;
};

export type RouteBindingRecord = {
  bindingId: string;
  hostEpoch: HostEpoch;
  serviceEpoch: ServiceEpoch;
  agentId: string;
  turnId: string;
  selection: SelectionIdentity;
  model: ResolvedModelSelection;
  fingerprint: string;
  ownership: OwnershipAdmission;
  lease: AuthLease;
  lastActivityMs: number;
};

export type TurnRecord = {
  serviceEpoch: string;
  bindingId?: string;
  lifecycle: "open" | "revoked" | "closed";
  expired: boolean;
  lastActivityMs: number;
};

export type InferenceState = {
  serviceEpoch: string;
  /** Soft resource-cache settings, never admission quotas. */
  hotTurnsTarget: number;
  resourceIdleMs: number;
  bindings: Map<string, RouteBindingRecord>;
  turns: Map<string, TurnRecord>;
  ledger: Map<string, LedgerRecord>;
  turnActive: Map<string, string>;
  cancelled: Set<string>;
};

export type InferenceMemoryOptions = {
  serviceEpoch?: string;
  hotTurnsTarget?: number;
  resourceIdleMs?: number;
  /** Production must supply the durable exact-match index. */
  history?: ExecutionHistory;
  providerRecovery?: ProviderRecoveryPolicy;
};

export function emptyInferenceState(options: InferenceMemoryOptions = {}): InferenceState {
  return {
    serviceEpoch: options.serviceEpoch ?? "svc-1",
    hotTurnsTarget: options.hotTurnsTarget ?? SERVER_ACTIVE_STEPS_MAX,
    resourceIdleMs: options.resourceIdleMs ?? TURN_RESOURCE_IDLE_MS,
    bindings: new Map(),
    turns: new Map(),
    ledger: new Map(),
    turnActive: new Map(),
    cancelled: new Set(),
  };
}

export function hostKey(epoch: HostEpoch): string {
  return canonicalJson(epoch);
}

export function turnKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId">): string {
  return canonicalJson({ host: hostKey(request.hostEpoch), agentId: request.agentId, turnId: request.turnId });
}

export function ledgerKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId" | "stepId">): string {
  return canonicalJson({
    host: hostKey(request.hostEpoch),
    agentId: request.agentId,
    turnId: request.turnId,
    stepId: request.stepId,
  });
}

export function bindingStoreKey(request: Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId">): string {
  return turnKey(request);
}

export function makeBindingId(input: {
  hostEpoch: HostEpoch;
  agentId: string;
  turnId: string;
  serviceEpoch: string;
  selectionRevision: string;
}): string {
  return sha256Text(canonicalJson(input));
}

export function cloneState(state: InferenceState): InferenceState {
  return {
    ...state,
    bindings: new Map(state.bindings),
    turns: new Map(state.turns),
    ledger: new Map(state.ledger),
    turnActive: new Map(state.turnActive),
    cancelled: new Set(state.cancelled),
  };
}

export type InferenceCounters = { accepted: number; duplicate: number; completed: number; reclaimedSteps: number; coldRestores: number; coldStores: number; cleanupFailures: number };
export type InferenceMemoryValue = {
  readonly history: ExecutionHistory;
  readonly providerRecovery: ProviderRecoveryPolicy;
  readonly recoveryProgress: Map<string, RecoveryProgress>;
  readonly authoritySteps: Map<string, { startedTick: bigint; spentMs: number; retries: number; check: number; progress?: AuthorityProgress }>;
  readonly counters: InferenceCounters;
  readonly ref: SynchronizedRef.SynchronizedRef<InferenceState>;
  readonly stateLocks: Map<string, { semaphore: Semaphore.Semaphore; users: number }>;
  /** Advisory inactive-key queue, never an authority or durable identity index. */
  readonly coolingQueue: Set<string>;
  readonly maintenance: { wake: Deferred.Deferred<void>; active: boolean };
  readonly timing: { identityLockWaitMs: number; identityWorkMs: number };
  readonly cancels: Map<string, Deferred.Deferred<void>>;
  readonly quiesce: Map<string, Deferred.Deferred<void>>;
  readonly started: Set<string>;
  readonly turnScopes: Map<string, Scope.Closeable>;
  /** Detached cache owners remain service-owned until release actually ends. */
  readonly retiringScopes: Set<Scope.Closeable>;
  readonly recoveries: Map<string, RecoveryLedger>;
};
export class InferenceMemory extends Context.Service<InferenceMemory, InferenceMemoryValue>()("grokbox/InferenceMemory") {}

type ExecutionIdentity = Pick<RunStepRequest, "hostEpoch" | "agentId" | "turnId" | "stepId">;

/** One identity owns its mutations while storage is awaited. The global ref is
 * held only to read/commit a small delta, never across external I/O. A view can
 * mutate only its TURN and requested STEP; unrelated updates cannot be lost by
 * writing an old whole-state snapshot back after an asynchronous operation. */
export function modifyExecutionState<A, E, R>(memory: InferenceMemoryValue, identity: ExecutionIdentity | string,
  operation: (view: InferenceState) => Effect.Effect<readonly [A, InferenceState], E, R>,
  onCommitted?: (result: A) => void) {
  const key = typeof identity === "string" ? identity : turnKey(identity);
  const step = typeof identity === "string" ? undefined : ledgerKey(identity);
  return Effect.scoped(Effect.gen(function* () {
    const lock = yield* Effect.acquireRelease(Effect.sync(() => {
      let entry = memory.stateLocks.get(key);
      if (!entry) { entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }; memory.stateLocks.set(key, entry); }
      entry.users++;
      return entry;
    }), entry => Effect.sync(() => {
      entry.users--;
      if (entry.users === 0 && memory.stateLocks.get(key) === entry) memory.stateLocks.delete(key);
    }));
    const queuedAt = yield* Clock.monotonicTimeNanos;
    let acquiredAt: bigint | undefined;
    return yield* lock.semaphore.withPermit(Effect.gen(function* () {
      acquiredAt = yield* Clock.monotonicTimeNanos;
      memory.timing.identityLockWaitMs += Math.max(0, Number(acquiredAt - queuedAt) / 1_000_000);
      const before = yield* SynchronizedRef.get(memory.ref);
      const binding = before.bindings.get(key), turn = before.turns.get(key), active = before.turnActive.get(key);
      const ledger = step ? before.ledger.get(step) : undefined;
      const cancelledBefore = step !== undefined && before.cancelled.has(step);
      const view: InferenceState = { ...before,
        bindings: new Map(binding ? [[key, { ...binding }]] : []),
        turns: new Map(turn ? [[key, { ...turn }]] : []),
        turnActive: new Map(active ? [[key, active]] : []),
        ledger: new Map(step && ledger ? [[step, { ...ledger }]] : []),
        cancelled: new Set(step && cancelledBefore ? [step] : []),
      };
      const [result, next] = yield* operation(view);
      const validKeys = <T>(map: Map<string, T>, allowed: string | undefined) => [...map.keys()].every(k => k === allowed);
      if (!validKeys(next.bindings, key) || !validKeys(next.turns, key) || !validKeys(next.turnActive, key)
        || !validKeys(next.ledger, step) || [...next.cancelled].some(k => k !== step)) {
        return yield* Effect.fail(new BindingFailure("ledger_unavailable"));
      }
      yield* Effect.uninterruptible(Effect.gen(function* () {
      yield* SynchronizedRef.updateEffect(memory.ref, current => {
        // This rejects any writer that bypassed the identity owner during I/O.
        // Cancellation intent is deliberately separate and may arrive at once.
        if (current.serviceEpoch !== before.serviceEpoch || current.bindings.get(key) !== binding
          || current.turns.get(key) !== turn || current.turnActive.get(key) !== active
          || step !== undefined && current.ledger.get(step) !== ledger) {
          return Effect.fail(new BindingFailure("ledger_unavailable"));
        }
        const merged = cloneState(current);
        const install = <T>(target: Map<string, T>, source: Map<string, T>, k: string) => {
          if (source.has(k)) target.set(k, source.get(k)!); else target.delete(k);
        };
        install(merged.bindings, next.bindings, key); install(merged.turns, next.turns, key);
        install(merged.turnActive, next.turnActive, key);
        if (step !== undefined) {
          install(merged.ledger, next.ledger, step);
          if (next.cancelled.has(step) !== cancelledBefore) {
            if (next.cancelled.has(step)) merged.cancelled.add(step); else merged.cancelled.delete(step);
          }
        }
        if (merged.turns.has(key) && !merged.turnActive.has(key)) memory.coolingQueue.add(key);
        else memory.coolingQueue.delete(key);
        return Effect.succeed(merged);
      });
      if (onCommitted) yield* Effect.sync(() => onCommitted(result));
      }));
      return result;
    }).pipe(Effect.ensuring(Effect.gen(function* () {
      if (acquiredAt !== undefined) memory.timing.identityWorkMs += Math.max(0, Number((yield* Clock.monotonicTimeNanos) - acquiredAt) / 1_000_000);
    }))));
  }));
}

export function updateExecutionState<E, R>(memory: InferenceMemoryValue, identity: ExecutionIdentity | string,
  operation: (view: InferenceState) => Effect.Effect<InferenceState, E, R>) {
  return modifyExecutionState(memory, identity, view => operation(view).pipe(Effect.map(next => [undefined, next] as const)));
}

export function updateExecutionStateSync(memory: InferenceMemoryValue, identity: ExecutionIdentity | string,
  operation: (view: InferenceState) => InferenceState) {
  return updateExecutionState(memory, identity, view => Effect.sync(() => operation(view)));
}

export function coldTurn(state: InferenceState, key: string): ColdTurn | undefined {
  const turn = state.turns.get(key);
  if (!turn) return undefined;
  const binding = state.bindings.get(key);
  if (!binding) return { version: 1, turn: { ...turn } };
  const { lease: _lease, ...metadata } = binding;
  return { version: 1, turn: { ...turn }, binding: metadata };
}

/** Evict only inactive resource owners, after a durable cold record exists.
 * The same binding/fingerprint is checked on reactivation. No history is lost. */
export function coolInactiveTurns(memory: InferenceMemoryValue, now: number, force = false, limit = 32) {
  return Effect.gen(function* () {
    const budget = Math.max(1, Math.min(32, Math.floor(limit)));
    const close = (scope: Scope.Closeable) => Scope.close(scope, Exit.void).pipe(
      Effect.tap(() => Effect.sync(() => { memory.retiringScopes.delete(scope); })),
      Effect.catchCause(() => Effect.sync(() => { memory.counters.cleanupFailures++; })),
    );
    let released = 0;
    for (const scope of memory.retiringScopes) {
      if (released++ >= budget) break;
      yield* close(scope);
    }
    // Bounded key selection: no full-map scan/sort on every STEP. The queue is
    // maintained by committed identity transitions and carries no authority.
    const keys: string[] = [];
    for (const key of memory.coolingQueue) { if (keys.length >= budget) break; keys.push(key); }
    for (const key of keys) {
      memory.coolingQueue.delete(key);
      const global = yield* SynchronizedRef.get(memory.ref);
      const pressure = global.turns.size > global.hotTurnsTarget;
      const detached = yield* modifyExecutionState(memory, key,
        (next): Effect.Effect<readonly [Scope.Closeable | null | undefined, InferenceState], BindingFailure> => Effect.gen(function* () {
          const turn = next.turns.get(key);
          if (!turn || next.turnActive.has(key)
            || !force && !pressure && now - turn.lastActivityMs < next.resourceIdleMs) return [undefined, next] as const;
          const archived = coldTurn(next, key)!;
          const previous = archived.binding ? undefined : yield* memory.history.getTurn(key);
          yield* memory.history.putTurn(key, archived.binding || !previous?.binding ? archived : { ...archived, binding: previous.binding });
          next.turns.delete(key); next.bindings.delete(key);
          return [memory.turnScopes.get(key) ?? null, next] as const;
        }), scope => {
          if (scope === undefined) return;
          memory.counters.coldStores++;
          if (scope) { memory.retiringScopes.add(scope); memory.turnScopes.delete(key); }
        }).pipe(Effect.tapError(() => Effect.sync(() => { memory.coolingQueue.add(key); })));
      // Every identity is an independent committed maintenance unit. A later
      // identity's I/O failure cannot undo one already stored and released.
      if (detached) yield* close(detached);
    }
  });
}

export function coolUnderPressure(memory: InferenceMemoryValue, now: number) {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.get(memory.ref);
    // Pressure is a coalesced signal, not an obligation for this unrelated
    // request to wait for cold-storage I/O or another TURN's finalizer.
    if (state.turns.size > state.hotTurnsTarget) yield* Deferred.succeed(memory.maintenance.wake, undefined);
    void now;
  });
}

export const inferenceCapacity = Effect.gen(function* () {
  const memory = yield* InferenceMemory;
  const state = yield* SynchronizedRef.get(memory.ref);
  const store = memory.history.health();
  return { version: 1 as const, accepting: store.available, lifetimeStepLimit: null,
    activeSteps: state.turnActive.size, hotStepRecords: state.ledger.size,
    hotTurns: state.turns.size, pinnedTurns: memory.turnScopes.size, pendingScopeReleases: memory.retiringScopes.size,
    history: store, counters: { ...memory.counters },
    authority: { policyId: STRICT_AUTHORITY_POLICY.id, active: memory.authoritySteps.size,
      waiting: [...memory.authoritySteps.values()].filter(step => step.progress?.phase === "waiting").length,
      readRetries: [...memory.authoritySteps.values()].reduce((sum, step) => sum + step.retries, 0) },
    timing: { identityLockWaitMs: memory.timing.identityLockWaitMs, identityWorkMs: memory.timing.identityWorkMs,
      ...(store.ioTiming ? { storageReadMs: store.ioTiming.readMs, storageWriteMs: store.ioTiming.writeMs } : {}) },
    providerRecovery: { policy: { ...memory.providerRecovery }, active: memory.recoveryProgress.size,
      waiting: [...memory.recoveryProgress.values()].filter(p => p.current?.phase === "waiting").length } };
});

export function inferenceMemoryLayer(options: InferenceMemoryOptions = {}) {
  return Layer.effect(InferenceMemory, Effect.gen(function* () {
    const memory: InferenceMemoryValue = {
      history: options.history ?? memoryExecutionHistory(),
      providerRecovery: projectProviderRecoveryPolicy(options.providerRecovery ?? NO_PROVIDER_RECOVERY) ?? NO_PROVIDER_RECOVERY,
      recoveryProgress: new Map(),
      authoritySteps: new Map(),
      counters: { accepted: 0, duplicate: 0, completed: 0, reclaimedSteps: 0, coldRestores: 0, coldStores: 0, cleanupFailures: 0 },
      ref: SynchronizedRef.makeUnsafe(emptyInferenceState(options)),
      stateLocks: new Map(),
      coolingQueue: new Set(),
      maintenance: { wake: Deferred.makeUnsafe<void>(), active: false },
      timing: { identityLockWaitMs: 0, identityWorkMs: 0 },
      cancels: new Map<string, Deferred.Deferred<void>>(),
      quiesce: new Map<string, Deferred.Deferred<void>>(),
      started: new Set<string>(),
      turnScopes: new Map<string, Scope.Closeable>(),
      retiringScopes: new Set<Scope.Closeable>(),
      recoveries: new Map<string, RecoveryLedger>(),
    };
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      for (const halt of memory.cancels.values()) {
        yield* Deferred.succeed(halt, undefined).pipe(Effect.ignore);
      }
      for (const done of memory.quiesce.values()) {
        yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      }
      for (const scope of new Set([...memory.turnScopes.values(), ...memory.retiringScopes])) {
        yield* Scope.close(scope, Exit.void);
      }
    }));
    // Structured service-owned maintenance, not a detached timer or new Runtime.
    // Future input also performs pressure-based cooling, so maintenance cadence
    // is not an execution timeout and never makes a long tool expire.
    const maintain = Effect.gen(function* () {
      const wake = memory.maintenance.wake;
      yield* Effect.raceFirst(Deferred.await(wake), Effect.sleep("1 minute"));
      if (memory.maintenance.wake === wake) memory.maintenance.wake = Deferred.makeUnsafe<void>();
      memory.maintenance.active = true;
      let failed = false;
      const now = yield* Clock.currentTimeMillis;
      yield* coolInactiveTurns(memory, now).pipe(
        Effect.catchCause(() => Effect.sync(() => { failed = true; memory.counters.cleanupFailures++; })),
        Effect.ensuring(Effect.sync(() => { memory.maintenance.active = false; })),
      );
      const state = yield* SynchronizedRef.get(memory.ref);
      // A finite successful batch can yield to other work, then continue pressure
      // relief. Failure waits for new demand or the normal maintenance interval.
      if (!failed && memory.coolingQueue.size > 0 && state.turns.size > state.hotTurnsTarget) {
        yield* Effect.yieldNow;
        yield* Deferred.succeed(memory.maintenance.wake, undefined);
      }
    });
    yield* Effect.forkScoped(Effect.forever(maintain));
    return memory;
  }));
}
