import { Clock, Context, Deferred, Effect, Exit, Layer, SynchronizedRef } from "effect";
import * as Scope from "effect/Scope";
import { canonicalJson, sha256Text } from "../../hash.ts";
import { SERVER_ACTIVE_STEPS_MAX, TURN_RESOURCE_IDLE_MS } from "../contract/limits.ts";
import { memoryExecutionHistory, type ColdTurn, type ExecutionHistory } from "./execution-history.ts";
import type { AuthLease } from "../../ports.ts";
import type { HostEpoch, SelectionIdentity, ServiceEpoch } from "../contract/identity.ts";
import type { ModelRecord } from "../../selection.ts";
import type { RunStepRequest } from "../contract/binding.ts";
import type { RecoveryLedger } from "../contract/overflow.ts";
import type { OwnershipAdmission } from "../contract/ownership.ts";
import { NO_PROVIDER_RECOVERY, projectProviderRecoveryPolicy, type ProviderRecoveryPolicy, type ProviderRecoveryState } from "../contract/provider-recovery.ts";
import type { RecoveryProgress } from "./provider-recovery.ts";

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
  model: ModelRecord;
  fingerprint: string;
  ownership: OwnershipAdmission;
  lease: AuthLease;
  lastActivityMs: number;
};

export type TurnRecord = {
  serviceEpoch: string;
  bindingId?: string;
  poisoned: boolean;
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
  readonly counters: InferenceCounters;
  readonly ref: SynchronizedRef.SynchronizedRef<InferenceState>;
  readonly cancels: Map<string, Deferred.Deferred<void>>;
  readonly quiesce: Map<string, Deferred.Deferred<void>>;
  readonly started: Set<string>;
  readonly turnScopes: Map<string, Scope.Closeable>;
  /** Detached cache owners remain service-owned until release actually ends. */
  readonly retiringScopes: Set<Scope.Closeable>;
  readonly recoveries: Map<string, RecoveryLedger>;
};
export class InferenceMemory extends Context.Service<InferenceMemory, InferenceMemoryValue>()("grokbox/InferenceMemory") {}

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
export function coolInactiveTurns(memory: InferenceMemoryValue, now: number, force = false) {
  return Effect.gen(function* () {
    const scopes = yield* SynchronizedRef.modifyEffect(memory.ref, state => Effect.gen(function* () {
      const next = cloneState(state);
      const detached: Array<{ key: string; scope: Scope.Closeable }> = [];
      let cooled = 0;
      const eligible = [...next.turns].filter(([key]) => !next.turnActive.has(key))
        .sort((a, b) => a[1].lastActivityMs - b[1].lastActivityMs);
      for (const [key, turn] of eligible) {
        if (!force && now - turn.lastActivityMs < next.resourceIdleMs && next.turns.size <= next.hotTurnsTarget) continue;
        const archived = coldTurn(next, key)!;
        // An inactive rejected/no-binding TURN may already have cold metadata.
        // Do not overwrite its original binding with a cache miss.
        const previous = archived.binding ? undefined : yield* memory.history.getTurn(key);
        yield* memory.history.putTurn(key, archived.binding || !previous?.binding ? archived : { ...archived, binding: previous.binding });
        next.turns.delete(key); next.bindings.delete(key);
        const scope = memory.turnScopes.get(key);
        if (scope) detached.push({ key, scope });
        cooled++;
      }
      // Do not mutate nontransactional resource ownership before the entire
      // persistence batch succeeds. A later IO failure must leave all hot
      // bindings attached to their original live scopes.
      for (const { key, scope } of detached) {
        memory.retiringScopes.add(scope);
        memory.turnScopes.delete(key);
      }
      memory.counters.coldStores += cooled;
      return [[...memory.retiringScopes], next] as const;
    }));
    for (const scope of scopes) yield* Scope.close(scope, Exit.void).pipe(
      Effect.tap(() => Effect.sync(() => { memory.retiringScopes.delete(scope); })),
      Effect.catchCause(() => Effect.sync(() => { memory.counters.cleanupFailures++; })),
    );
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
    providerRecovery: { policy: { ...memory.providerRecovery }, active: memory.recoveryProgress.size,
      waiting: [...memory.recoveryProgress.values()].filter(p => p.current?.phase === "waiting").length } };
});

export function inferenceMemoryLayer(options: InferenceMemoryOptions = {}) {
  return Layer.effect(InferenceMemory, Effect.gen(function* () {
    const memory: InferenceMemoryValue = {
      history: options.history ?? memoryExecutionHistory(),
      providerRecovery: projectProviderRecoveryPolicy(options.providerRecovery ?? NO_PROVIDER_RECOVERY) ?? NO_PROVIDER_RECOVERY,
      recoveryProgress: new Map(),
      counters: { accepted: 0, duplicate: 0, completed: 0, reclaimedSteps: 0, coldRestores: 0, coldStores: 0, cleanupFailures: 0 },
      ref: SynchronizedRef.makeUnsafe(emptyInferenceState(options)),
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
      yield* Effect.sleep("1 minute");
      const now = yield* Clock.currentTimeMillis;
      yield* coolInactiveTurns(memory, now).pipe(Effect.catchCause(() => Effect.sync(() => { memory.counters.cleanupFailures++; })));
    });
    yield* Effect.forkScoped(Effect.forever(maintain));
    return memory;
  }));
}
