import { randomUUID } from "node:crypto";
import { Clock, Deferred, Effect, Fiber } from "effect";
import {
  BoxRuntimeError, STRICT_AUTHORITY_POLICY, decideOwnershipWithLocal, inspectNativeOwnershipLocal,
  annotateStreamFailure, streamFailureDiagnostic,
  type OwnershipAdmission, type RemoteOwnershipEvidence, type OwnershipWaitObservation,
} from "@grokbox/runtime-kernel/contract";
import { canonicalJson } from "@grokbox/runtime-kernel/hash";
import { ownershipUseError, readManagedOwnership, type OwnershipReader, type OwnershipReadReply } from "./ownership-admission.node.ts";

type Source = { evidence: OwnershipAdmission; gateway: OwnershipReadReply["gateway"]; remote: RemoteOwnershipEvidence };
type ReadInput = { agentId: string; gatewayPid?: number; hostGeneration: string };
type Entry = {
  key: string; operationId: string; agentId: string; hostKey: string;
  createdTick: bigint; receivedTick?: bigint; ageAtReceiptMs: number;
  done: Deferred.Deferred<Source, BoxRuntimeError>; fiber?: Fiber.Fiber<Source, BoxRuntimeError>;
  value?: Source; waiters: number; logicalPending: boolean; physicalPending: boolean; retired: boolean;
  retiredReason?: "ownership_identity_changed" | "native_execution_not_ready";
  failure?: BoxRuntimeError;
};
type Waiter = { id: number; observationId: string; startedTick: bigint; entry?: Entry; state: OwnershipWaitObservation["state"] };
type Options = { sourceWaitMs?: number; waiterWaitMs?: number; cacheMs?: number; maxEntries?: number; maxWaiters?: number };
const elapsed = (now: bigint, then: bigint) => Math.max(0, Number(now - then) / 1_000_000);
const bounded = (value: number | undefined, fallback: number, allowZero = false) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1) || n > fallback) throw new Error("invalid_authority_resource_bound");
  return n;
};
const sameGateway = (a: OwnershipReadReply["gateway"], b: OwnershipReadReply["gateway"]) => a.pid === b.pid && a.startedAt === b.startedAt;
const validGateway = (value: OwnershipReadReply["gateway"], expected?: number) => Number.isSafeInteger(value.pid) && value.pid > 0
  && Number.isSafeInteger(value.startedAt) && value.startedAt > 0 && (expected === undefined || value.pid === expected);

/** Service-owned source tasks; request-owned subscriptions. No cache contains
 * local pause/binding facts, and a physical Promise ignoring abort retains its
 * slot until it actually settles. This program has no provider or repair port. */
export function makeOwnershipCoordinator(read?: OwnershipReader, options: Options = {}) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sourceWaitMs = bounded(options.sourceWaitMs, STRICT_AUTHORITY_POLICY.sourceWaitMs);
    const waiterWaitMs = bounded(options.waiterWaitMs, STRICT_AUTHORITY_POLICY.waiterWaitMs);
    const cacheMs = bounded(options.cacheMs, STRICT_AUTHORITY_POLICY.cacheMs, true);
    const maxEntries = bounded(options.maxEntries, STRICT_AUTHORITY_POLICY.maxEntries);
    const maxWaiters = bounded(options.maxWaiters, STRICT_AUTHORITY_POLICY.maxWaiters);
    const entries = new Map<string, Entry>();
    const observedScopes = new Map<string, string>();
    const queued = new Map<number, { key: string; wake: Deferred.Deferred<void> }>();
    let nextWaiter = 0;
    let closed = false, waiters = 0, localPhysical = 0, created = 0, joined = 0, cacheHits = 0;
    const notify = () => { for (const slot of queued.values()) Deferred.doneUnsafe(slot.wake, Effect.void); };
    const busy = (agentId: string) => ownershipUseError("ownership_read_unavailable", "unavailable", agentId);
    const releaseRetired = (entry: Entry) => {
      if (entry.retired && !entry.logicalPending && !entry.physicalPending && entry.waiters === 0 && entries.get(entry.key) === entry) entries.delete(entry.key);
      notify();
    };
    const retireHost = (hostKey: string, reason: Entry["retiredReason"] = "ownership_identity_changed", agentId?: string) => {
      for (const entry of entries.values()) if (entry.hostKey === hostKey && (agentId === undefined || entry.agentId === agentId)) {
        entry.retired = true; entry.retiredReason = reason; entry.value = undefined; releaseRetired(entry);
      }
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      closed = true;
      for (const entry of entries.values()) { entry.retired = true; entry.value = undefined; releaseRetired(entry); }
      observedScopes.clear();
      notify();
    }));

    const localRead = (input: ReadInput) => Effect.gen(function* () {
      if (localPhysical >= maxWaiters) return yield* Effect.fail(busy(input.agentId));
      const result = yield* Effect.tryPromise({
        try: signal => {
          localPhysical++;
          return Promise.resolve().then(() => {
            if (signal.aborted) throw new Error("local_witness_cancelled_before_start");
            return read!.local!([input.agentId], signal);
          }).finally(() => { localPhysical--; });
        },
        catch: () => ownershipUseError("ownership_read_unavailable", "unavailable", input.agentId),
      });
      if (!validGateway(result.gateway, input.gatewayPid)) {
        return yield* Effect.fail(ownershipUseError("ownership_gateway_mismatch", "unavailable", input.agentId));
      }
      const witness = inspectNativeOwnershipLocal({ agentId: input.agentId, snapshot: result.snapshot, nowMs: yield* Clock.currentTimeMillis });
      if (!witness.valid) return yield* Effect.fail(ownershipUseError("ownership_bridge_unavailable", "unavailable", input.agentId));
      const hostKey = canonicalJson([input.hostGeneration, result.gateway.pid, result.gateway.startedAt]);
      const previous = observedScopes.get(hostKey);
      if (previous !== undefined && previous !== witness.scopeId) retireHost(hostKey);
      // A root serves one current Host generation. Bound obsolete scope metadata
      // as well as source payloads; the execution ledger owns old TURN fencing.
      if (!observedScopes.has(hostKey) && observedScopes.size >= maxEntries) {
        const oldest = observedScopes.keys().next().value;
        if (oldest !== undefined) { retireHost(oldest); observedScopes.delete(oldest); }
      }
      observedScopes.set(hostKey, witness.scopeId!);
      if (!witness.ready) {
        retireHost(hostKey, "native_execution_not_ready", input.agentId);
        return yield* Effect.fail(ownershipUseError("native_execution_not_ready", "unavailable", input.agentId));
      }
      return { result, witness, hostKey };
    });

    const acquire = (input: ReadInput, local: Effect.Success<ReturnType<typeof localRead>>, waiter: Waiter) => Effect.gen(function* () {
      const wait = () => {
        const wake = Deferred.makeUnsafe<void>();
        waiter.state = "queued";
        queued.set(waiter.id, { key, wake });
        return { kind: "waiting" as const, wake };
      };
      const now = yield* Clock.monotonicTimeNanos;
      const key = canonicalJson([local.hostKey, local.witness.scopeId, input.agentId]);
      let entry = entries.get(key);
      if (entry && !entry.logicalPending && !entry.physicalPending && entry.waiters === 0
        && (entry.retired || !entry.value || entry.receivedTick === undefined
          || entry.ageAtReceiptMs + elapsed(now, entry.receivedTick) >= cacheMs)) {
        entries.delete(key); entry = undefined;
      }
      if (closed) return yield* Effect.fail(busy(input.agentId));
      if (entry?.retired || entry && !entry.logicalPending && (!entry.value || entry.receivedTick === undefined
        || entry.ageAtReceiptMs + elapsed(now, entry.receivedTick) >= cacheMs)) return wait();
      if (!entry) {
        // Fairness applies to requests eligible for a free source slot. A
        // retired, physically stuck operation for A must not block B when a
        // different slot is available.
        const head = [...queued].find(([, slot]) => {
          const held = entries.get(slot.key);
          return !held || held.waiters === 0 && !held.logicalPending && !held.physicalPending
            && (held.retired || !held.value || held.receivedTick === undefined
              || held.ageAtReceiptMs + elapsed(now, held.receivedTick) >= cacheMs);
        })?.[0];
        if (head !== undefined && head !== waiter.id) return wait();
        // Eviction only discards an unused observation. It cannot discard a
        // pending operation, an execution claim or a TURN binding.
        for (const candidate of entries.values()) {
          if (entries.size < maxEntries) break;
          if (candidate.waiters === 0 && !candidate.logicalPending && !candidate.physicalPending) entries.delete(candidate.key);
        }
        if (entries.size >= maxEntries) return wait();
        const fresh: Entry = { key, operationId: randomUUID(), hostKey: local.hostKey, agentId: input.agentId, createdTick: now, ageAtReceiptMs: 0,
          done: Deferred.makeUnsafe<Source, BoxRuntimeError>(), waiters: 0, logicalPending: true, physicalPending: false, retired: false };
        entries.set(key, fresh); entry = fresh; created++;
        fresh.waiters++; waiter.entry = fresh; waiter.state = "source";
        queued.delete(waiter.id);
        const tracked: OwnershipReader = (ids, signal) => {
          fresh.physicalPending = true;
          // Promise settlement is a physical transport fact, independent of
          // Effect interruption. The callback only releases its owned slot.
          return Promise.resolve().then(() => {
            if (signal.aborted) throw new Error("source_cancelled_before_start");
            return read!(ids, signal);
          }).finally(() => {
            fresh.physicalPending = false; releaseRetired(fresh);
          });
        };
        const source = readManagedOwnership({ agentId: input.agentId, read: tracked, gatewayPid: input.gatewayPid }).pipe(
          Effect.timeout(`${sourceWaitMs} millis`),
          Effect.mapError(error => error instanceof BoxRuntimeError ? error : ownershipUseError("ownership_read_timeout", "unavailable", input.agentId)),
          Effect.tapError(error => Effect.sync(() => { fresh.failure = error; })),
          Effect.onExit(exit => Effect.gen(function* () {
            fresh.logicalPending = false;
            if (exit._tag === "Success" && !fresh.retired) {
              fresh.receivedTick = yield* Clock.monotonicTimeNanos;
              const wall = yield* Clock.currentTimeMillis;
              fresh.ageAtReceiptMs = Math.max(0, wall - exit.value.evidence.observedAtMs,
                exit.value.remote.readObservation?.serverEvidenceAgeMs ?? 0,
                elapsed(fresh.receivedTick, fresh.createdTick));
              fresh.value = exit.value;
            } else { fresh.retired = true; fresh.value = undefined; }
            yield* Deferred.done(fresh.done, exit);
            releaseRetired(fresh);
          })),
        );
        // Acquire runs masked until its release is registered, but the source
        // itself must remain interruptible and belong to the service Scope.
        fresh.fiber = yield* Effect.forkIn(source, scope, { uninterruptible: false });
      } else {
        waiter.state = entry.logicalPending ? "shared" : "cached";
        if (entry.logicalPending) joined++;
        else cacheHits++;
        entry.waiters++; waiter.entry = entry;
        queued.delete(waiter.id);
      }
      notify();
      return { kind: "acquired" as const, entry };
    }).pipe(Effect.uninterruptible);
    const reserveWaiter = (input: ReadInput) => Effect.gen(function* () {
      if (closed || waiters >= maxWaiters) return yield* Effect.fail(busy(input.agentId));
      waiters++;
      return { id: nextWaiter++, observationId: randomUUID(), startedTick: yield* Clock.monotonicTimeNanos,
        state: "local_witness" } as Waiter;
    });
    const release = (waiter: Waiter) => Effect.gen(function* () {
      queued.delete(waiter.id); waiters--;
      const entry = waiter.entry;
      if (entry) {
        entry.waiters--;
        if (entry.waiters === 0 && entry.logicalPending) {
          entry.retired = true; entry.value = undefined;
          if (entry.fiber) yield* Fiber.interrupt(entry.fiber);
        }
        releaseRetired(entry);
      }
      notify();
    });

    const current = (input: ReadInput): Effect.Effect<Source, BoxRuntimeError> => Effect.suspend(() => {
      if (closed) return Effect.fail(ownershipUseError("ownership_reader_unavailable", "unavailable", input.agentId));
      // Capability-limited injected readers retain the existing fresh full-read
      // path. A production reader advertises local(); a missing/old peer result
      // is rejected by localRead, never silently treated as ready.
      if (!read?.local) return readManagedOwnership({ agentId: input.agentId, read, gatewayPid: input.gatewayPid });
      let observedWaiter: Waiter | undefined;
      return Effect.scoped(Effect.gen(function* () {
        const waiter = yield* Effect.acquireRelease(reserveWaiter(input), release);
        observedWaiter = waiter;
        const before = yield* localRead(input);
        let entry: Entry;
        while (true) {
          const result = yield* acquire(input, before, waiter);
          if (result.kind === "acquired") { entry = result.entry; break; }
          yield* Deferred.await(result.wake);
        }
        const value = yield* Deferred.await(entry.done);
        if (entry.retired) return yield* Effect.fail(entry.retiredReason
          ? ownershipUseError(entry.retiredReason, "unavailable", input.agentId) : busy(input.agentId));
        waiter.state = "validating";
        const after = yield* localRead(input);
        if (!sameGateway(before.result.gateway, after.result.gateway) || !sameGateway(value.gateway, after.result.gateway)) {
          entry.retired = true;
          return yield* Effect.fail(ownershipUseError("ownership_gateway_mismatch", "unavailable", input.agentId));
        }
        if (before.witness.scopeId !== after.witness.scopeId || value.remote.scope?.id !== after.witness.scopeId) {
          entry.retired = true;
          return yield* Effect.fail(ownershipUseError("ownership_identity_changed", "unconfirmed", input.agentId));
        }
        const tick = yield* Clock.monotonicTimeNanos;
        if (entry.receivedTick === undefined || tick < entry.receivedTick
          || entry.ageAtReceiptMs + elapsed(tick, entry.receivedTick) > STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs) {
          entry.retired = true;
          return yield* Effect.fail(ownershipUseError("ownership_evidence_stale", "unconfirmed", input.agentId));
        }
        const decision = decideOwnershipWithLocal({ agentId: input.agentId, remote: value.remote,
          localSnapshot: after.result.snapshot, nowMs: yield* Clock.currentTimeMillis });
        if (!decision.ok) {
          entry.retired = true;
          return yield* Effect.fail(ownershipUseError(decision.reason, decision.class, input.agentId, decision.ownershipRead));
        }
        return { ...value, gateway: after.result.gateway, evidence: decision.evidence };
      })).pipe(
        Effect.timeout(`${waiterWaitMs} millis`),
        Effect.catch(error => Effect.gen(function* () {
          const actual = error instanceof BoxRuntimeError ? error : ownershipUseError("ownership_read_timeout", "unavailable", input.agentId);
          const waiter = observedWaiter;
          if (!waiter) return yield* Effect.fail(actual);
          const tick = yield* Clock.monotonicTimeNanos;
          const entry = waiter.entry;
          const fromSource = entry?.failure === error;
          const outcome: OwnershipWaitObservation["outcome"] = !(error instanceof BoxRuntimeError) ? "waiter_deadline"
            : fromSource ? actual.failureCode === "ownership_read_timeout" ? "source_deadline" : "source_failure" : "local_refusal";
          const prior = streamFailureDiagnostic(actual);
          // Each waiter owns its diagnostic. Never mutate the shared source
          // error, which may be delivered to another waiter at another time.
          const copy = new BoxRuntimeError(actual.code, actual.message, actual);
          return yield* Effect.fail(annotateStreamFailure(copy, { ...prior, rejectSite: "authority_check",
            authority: { ...prior?.authority, reason: prior?.authority?.reason ?? "ownership_read_unavailable", waitBudgetMs: waiterWaitMs,
              ownershipWait: { version: 1, policyId: STRICT_AUTHORITY_POLICY.id, waiterId: waiter.observationId,
                state: waiter.state, outcome, durationMs: Math.ceil(elapsed(tick, waiter.startedTick)), waitBudgetMs: waiterWaitMs,
                ...(entry ? { sourceOperationId: entry.operationId, sourceBudgetMs: sourceWaitMs,
                  sourceAgeMs: Math.ceil(elapsed(tick, entry.createdTick)), sourceSettlement: entry.physicalPending ? "pending" : "settled" } : {}) } },
          }));
        })),
      );
    });
    return {
      current,
      snapshot: () => ({ version: 1 as const, policyId: STRICT_AUTHORITY_POLICY.id, closed,
        activeWaiters: waiters, queuedWaiters: queued.size, unsettledLocalReads: localPhysical, retainedEntries: entries.size,
        activeSources: [...entries.values()].filter(entry => entry.logicalPending).length,
        unsettledSources: [...entries.values()].filter(entry => entry.physicalPending).length,
        cachedSources: [...entries.values()].filter(entry => entry.value && !entry.retired).length,
        created, joined, cacheHits, localWitness: read?.local ? "configured" as const : "not_provided" as const }),
    };
  });
}
