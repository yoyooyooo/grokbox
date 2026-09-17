import { expect, test } from "bun:test";
import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { OWNERSHIP_LOCAL_SOURCE, OWNERSHIP_READ_SOURCE, streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { makeOwnershipCoordinator } from "../src/internal/io/ownership-coordinator.node.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const input = (agentId = A, hostGeneration = "fixture-generation") => ({ agentId, hostGeneration, gatewayPid: 77 });
const flushUntil = (condition: () => boolean) => Effect.gen(function* () {
  for (let n = 0; n < 200; n++) { if (condition()) return; yield* Effect.yieldNow; }
  throw new Error("fixture barrier did not settle");
});
const run = <A, E>(program: Effect.Effect<A, E, import("effect/Scope").Scope>) => Effect.runPromise(
  Effect.scoped(program).pipe(Effect.provide(TestClock.layer())),
);

const fixture = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const state = { scope: "a".repeat(64), allowed: true, bound: true, harness: "box", serverId: "server-1",
    gatewayStart: 1000, failSource: false, cooperative: true, localCalls: 0 };
  const calls: string[] = [], signals: AbortSignal[] = [];
  const holds = new Map<string, { promise: Promise<void>; release: () => void }>();
  const hold = (agentId = A) => {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    holds.set(agentId, { promise, release });
    return release;
  };
  const now = () => clock.currentTimeMillisUnsafe();
  const iso = (at: number) => new Date(at).toISOString();
  const identity = () => ({ harness: state.harness, serverId: state.serverId });
  const localFields = () => ({ localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } },
    localExecution: { before: { allowed: state.allowed, bound: state.bound }, after: { allowed: state.allowed, bound: state.bound } } });
  const reader: OwnershipReader = async (ids, signal) => {
    const agentId = ids[0]!;
    calls.push(agentId); signals.push(signal);
    const start = now(), scope = state.scope, before = identity(), gateway = { pid: 77, startedAt: state.gatewayStart };
    const blocked = holds.get(agentId)?.promise;
    if (blocked) {
      if (!state.cooperative) await blocked;
      else {
        let abort!: () => void;
        try {
          await Promise.race([blocked, new Promise<never>((_, reject) => {
            abort = () => reject(new Error("fixture transport cancelled"));
            if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
          })]);
        } finally { signal.removeEventListener("abort", abort); }
      }
    }
    const after = identity(), end = now();
    return { gateway, snapshot: { schemaVersion: 3, source: OWNERSHIP_READ_SOURCE,
      state: state.failSource ? "unavailable" : "observed", errorCode: state.failSource ? "server_read_failed" : null,
      observedAt: iso(start), completedAt: iso(end), serverObservedAt: iso(start), scope: { id: scope, stable: scope === state.scope },
      ...localFields(),
      readObservation: { version: 1, source: OWNERSHIP_READ_SOURCE, state: state.failSource ? "unavailable" : "observed",
        errorCode: state.failSource ? "server_read_failed" : undefined, phase: state.failSource ? "server" : "complete",
        serverRead: "request", durationMs: end - start, serverEvidenceAgeMs: state.failSource ? undefined : end - start },
      agents: [{ agentId, serverEvidence: "found", server: { agentId, serverId: before.serverId, harness: before.harness, viewerIsOwner: true },
        local: { before, after, stable: before.harness === after.harness && before.serverId === after.serverId } }],
    } };
  };
  reader.local = async ids => {
    state.localCalls++;
    const at = now(), local = identity();
    return { gateway: { pid: 77, startedAt: state.gatewayStart }, snapshot: { schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE,
      state: "observed", observedAt: iso(at), completedAt: iso(at), scope: { id: state.scope, stable: true }, ...localFields(),
      agents: ids.map(agentId => ({ agentId, local: { before: local, after: local, stable: true } })),
    } };
  };
  return { state, calls, signals, hold, reader };
});

for (const delay of [2500, 3000, 4000]) test(`same STEP reuses a ${delay}ms observation without renewing its age or another STEP's cache`, async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    const control = { evidenceOwner: {}, waitBudgetMs: 10000, takeRetry: () => Effect.succeed(false) };
    const first = yield* Effect.forkChild(service.current(input(), control));
    yield* flushUntil(() => f.calls.length === 1);
    yield* TestClock.adjust(`${delay} millis`); release();
    const original = yield* Fiber.join(first);
    for (let n = 0; n < 4; n++) {
      const reused = yield* service.current(input(), control);
      expect(reused.evidence.observedAtMs).toBe(original.evidence.observedAtMs);
      expect(reused.evidenceId).toBe(original.evidenceId);
      expect(reused.observation).toMatchObject({ evidenceUse: "step", sourceAgeMs: delay, policyId: "strict-observation-v2" });
    }
    expect(f.calls.length).toBe(1); expect(f.state.localCalls).toBe(10);
    // A copied/new owner cannot borrow the older source, even in the same Agent/TURN.
    const other = yield* service.current(input(), { ...control, evidenceOwner: { ...control.evidenceOwner } });
    expect(f.calls.length).toBe(2); expect(other.evidenceId).not.toBe(original.evidenceId);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, activeSources: 0, retainedEntries: 1 });
  }));
});

test("same-STEP evidence expires from its original start and eviction cannot resurrect it", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader, { maxEntries: 1 });
    const control = { evidenceOwner: {}, waitBudgetMs: 10000, takeRetry: () => Effect.succeed(false) };
    const first = yield* service.current(input(), control);
    yield* TestClock.adjust("4999 millis");
    const last = yield* service.current(input(), control);
    expect(last.evidenceId).toBe(first.evidenceId); expect(last.evidence.observedAtMs).toBe(first.evidence.observedAtMs);
    yield* TestClock.adjust("2 millis");
    const refreshed = yield* service.current(input(), control);
    expect(refreshed.evidenceId).not.toBe(first.evidenceId); expect(f.calls.length).toBe(2);
    yield* service.current(input(B));
    yield* service.current(input(), control);
    expect(f.calls).toEqual([A, A, B, A]);
    expect(service.snapshot().retainedEntries).toBe(1);
  }));
});

test("a fresh source expiring during local validation records evidence elapsed, not a slow source", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, original = f.reader.local!;
    let calls = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.reader.local = async (ids, signal) => { if (++calls === 2) await held; return original(ids, signal); };
    const service = yield* makeOwnershipCoordinator(f.reader);
    const pending = yield* Effect.forkChild(Effect.result(service.current(input(), {
      evidenceOwner: {}, waitBudgetMs: 10000, takeRetry: () => Effect.succeed(false),
    })));
    yield* flushUntil(() => calls === 2);
    yield* TestClock.adjust("5100 millis"); release();
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(streamFailureDiagnostic(result.failure)?.authority).toMatchObject({
      reason: "ownership_evidence_stale", availabilityCause: "evidence_elapsed", evidenceAgeMs: 5100,
    });
    expect(f.calls.length).toBe(1);
  }));
});

test("same-STEP reuse cannot survive invalidation observed during the final local witness", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader);
    const control = { evidenceOwner: {}, waitBudgetMs: 10000, takeRetry: () => Effect.succeed(false) };
    yield* service.current(input(), control);
    yield* TestClock.adjust("3000 millis");
    const original = f.reader.local!;
    let localCalls = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.reader.local = async (ids, signal) => {
      const result = await original(ids, signal);
      if (++localCalls === 2) await held;
      return result;
    };
    const pending = yield* Effect.forkChild(Effect.result(service.current(input(), control)));
    yield* flushUntil(() => localCalls === 2);
    f.state.allowed = false;
    expect((yield* Effect.result(service.current(input())))._tag).toBe("Failure");
    f.state.allowed = true; release();
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.failureCode).toBe("native_execution_not_ready");
    expect(f.calls.length).toBe(1);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, retainedEntries: 0 });
  }));
});

for (const delay of [5500, 7750, 9000]) test(`bounded recovery replaces a stale ${delay}ms read with a distinct fresh read without widening policy`, async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    let retries = 0;
    const worker = yield* Effect.forkChild(Effect.result(service.current(input(), {
      waitBudgetMs: 10000, takeRetry: () => Effect.sync(() => { retries++; return true; }),
    })));
    yield* flushUntil(() => f.calls.length === 1);
    yield* TestClock.adjust(`${delay} millis`); release();
    yield* flushUntil(() => retries === 1);
    yield* TestClock.adjust("250 millis");
    const result = yield* Fiber.join(worker);
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.success.evidence.observedAtMs).toBeGreaterThanOrEqual(delay);
      expect(result.success.recovery).toMatchObject({ attempts: 2 });
    }
    expect(f.calls.length).toBe(2); expect(retries).toBe(1);
    expect(service.snapshot().activeWaiters).toBe(0);
  }));
});

test("observed scope invalidation wakes an in-flight waiter without awaiting its uncooperative source", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture; f.state.cooperative = false;
    const release = f.hold(A), service = yield* makeOwnershipCoordinator(f.reader);
    const worker = yield* Effect.forkChild(Effect.result(service.current(input(A))));
    yield* flushUntil(() => f.calls.length === 1);
    f.state.scope = "b".repeat(64);
    yield* service.current(input(B));
    // No release and no TestClock advance: only the actual invalidation can
    // wake this waiter. Its still-running physical call remains accounted for.
    const result = yield* Fiber.join(worker);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.failureCode).toBe("ownership_identity_changed");
    expect(f.signals[0]?.aborted).toBe(true);
    expect(service.snapshot().unsettledSources).toBe(1);
    release();
    yield* flushUntil(() => service.snapshot().unsettledSources === 0);
  }));
});

test("an exhausted STEP retry allowance cannot create another source read", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture; f.state.failSource = true;
    const service = yield* makeOwnershipCoordinator(f.reader);
    const result = yield* Effect.result(service.current(input(), { waitBudgetMs: 10000, takeRetry: () => Effect.succeed(false) }));
    expect(result._tag).toBe("Failure"); expect(f.calls.length).toBe(1);
  }));
});

test("coordinator reuses remote facts but refreshes native local facts and never renews source age", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader);
    const first = yield* service.current(input());
    yield* TestClock.adjust("100 millis");
    const cached = yield* service.current(input());
    expect(f.calls.length).toBe(1);
    expect(f.state.localCalls).toBe(4);
    expect(cached.evidence.observedAtMs).toBe(first.evidence.observedAtMs);
    expect("localExecution" in cached.remote).toBe(false);
    expect("local" in cached.remote.agents[0]!).toBe(false);
    expect(service.snapshot()).toMatchObject({ cacheHits: 1, activeWaiters: 0, activeSources: 0 });
    f.state.allowed = false;
    const blocked = yield* Effect.result(service.current(input()));
    expect(blocked._tag).toBe("Failure");
    if (blocked._tag === "Failure") expect(blocked.failure.failureCode).toBe("native_execution_not_ready");
    expect(f.calls.length).toBe(1);
    f.state.allowed = true;
    yield* service.current(input());
    expect(f.calls.length).toBe(2);
  }));
});

test("different targets never borrow a row omitted from their source response", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader);
    yield* service.current(input(A)); yield* service.current(input(B));
    expect(f.calls).toEqual([A, B]);
    yield* service.current(input(A));
    expect(f.calls).toEqual([A, B]);
  }));
});

test("cancelling the first waiter leaves the service-owned source alive for the second waiter", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    const first = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => f.calls.length === 1);
    const second = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => service.snapshot().joined === 1);
    yield* Fiber.interrupt(first);
    expect(f.signals[0]!.aborted).toBe(false);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 1, joined: 1 });
    release();
    yield* Fiber.join(second);
    expect(f.calls.length).toBe(1);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, activeSources: 0, unsettledSources: 0 });
  }));
});

test("all waiters gone cancel the owned transport and release its slot after real settlement", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    const waiter = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => f.calls.length === 1);
    yield* Fiber.interrupt(waiter);
    expect(f.signals[0]!.aborted).toBe(true);
    yield* flushUntil(() => service.snapshot().unsettledSources === 0);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, activeSources: 0, retainedEntries: 0 });
    release();
  }));
});

test("an uncooperative cancelled source retains a bounded slot until its Promise settles", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture; f.state.cooperative = false;
    const release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader, { maxEntries: 1 });
    const first = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => f.calls.length === 1);
    yield* Fiber.interrupt(first);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, activeSources: 0, unsettledSources: 1, retainedEntries: 1 });
    const next = yield* Effect.forkChild(service.current(input(B)));
    yield* flushUntil(() => service.snapshot().queuedWaiters === 1);
    expect(f.calls).toEqual([A]);
    release();
    yield* Fiber.join(next);
    expect(f.calls).toEqual([A, B]);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, unsettledSources: 0 });
  }));
});

test("source capacity queues fairly and cancellation removes a queued waiter", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, releaseA = f.hold(A), releaseB = f.hold(B);
    const service = yield* makeOwnershipCoordinator(f.reader, { maxEntries: 1 });
    const a = yield* Effect.forkChild(service.current(input(A)));
    yield* flushUntil(() => f.calls.length === 1);
    const b = yield* Effect.forkChild(service.current(input(B)));
    yield* flushUntil(() => service.snapshot().queuedWaiters === 1);
    const c = yield* Effect.forkChild(service.current(input(C)));
    yield* flushUntil(() => service.snapshot().queuedWaiters === 2);
    releaseA(); yield* Fiber.join(a);
    yield* flushUntil(() => f.calls.length === 2);
    expect(f.calls).toEqual([A, B]);
    yield* Fiber.interrupt(c);
    releaseB(); yield* Fiber.join(b);
    expect(f.calls).toEqual([A, B]);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, queuedWaiters: 0 });
  }));
});

test("source failure has the same actual cause for early and late waiters", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    const a = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => f.calls.length === 1);
    yield* TestClock.adjust("100 millis");
    const b = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => service.snapshot().joined === 1);
    f.state.failSource = true; release();
    for (const result of [yield* Fiber.join(a), yield* Fiber.join(b)]) {
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(streamFailureDiagnostic(result.failure)?.authority?.ownershipRead).toMatchObject({ errorCode: "server_read_failed", phase: "server" });
        expect(streamFailureDiagnostic(result.failure)?.authority?.ownershipRead?.serverEvidenceAgeMs).toBeUndefined();
      }
    }
    expect(f.calls.length).toBe(1);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, retainedEntries: 0 });
  }));
});

for (const delay of [5500, 7750, 9000]) {
  test(`strict policy refuses a ${delay}ms source without completion-time renewal`, async () => {
    await run(Effect.gen(function* () {
      const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
      const waiter = yield* Effect.forkChild(Effect.result(service.current(input())));
      yield* flushUntil(() => f.calls.length === 1);
      yield* TestClock.adjust(`${delay} millis`);
      release();
      const result = yield* Fiber.join(waiter);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.failureCode).toBe("ownership_evidence_stale");
        expect(streamFailureDiagnostic(result.failure)?.authority).toMatchObject({ availabilityCause: "read_elapsed", evidenceAgeMs: delay });
      }
      expect(f.calls.length).toBe(1);
      expect(service.snapshot().cachedSources).toBe(0);
    }));
  });
}

test("old peers cannot return a full snapshot instead of the required local-only capability", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture;
    f.reader.local = f.reader;
    const service = yield* makeOwnershipCoordinator(f.reader);
    const result = yield* Effect.result(service.current(input()));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.failureCode).toBe("ownership_bridge_unavailable");
    expect(service.snapshot().created).toBe(0);
  }));
});

test("scope and Host generation changes cannot reuse a prior remote cache", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader);
    yield* service.current(input());
    f.state.scope = "b".repeat(64); yield* service.current(input());
    f.state.scope = "a".repeat(64); yield* service.current(input());
    yield* service.current(input(A, "new-host-generation"));
    expect(f.calls.length).toBe(4);
  }));
});

test("one source deadline has a shared operation ID and distinct per-waiter elapsed time", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader, { sourceWaitMs: 200, waiterWaitMs: 500 });
    const a = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => f.calls.length === 1);
    yield* TestClock.adjust("100 millis");
    const b = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => service.snapshot().joined === 1);
    yield* TestClock.adjust("101 millis");
    const ra = yield* Fiber.join(a), rb = yield* Fiber.join(b);
    expect(ra._tag).toBe("Failure"); expect(rb._tag).toBe("Failure");
    if (ra._tag !== "Failure" || rb._tag !== "Failure") throw new Error("fixture");
    const da = streamFailureDiagnostic(ra.failure)?.authority?.ownershipWait;
    const db = streamFailureDiagnostic(rb.failure)?.authority?.ownershipWait;
    expect(da).toMatchObject({ outcome: "source_deadline", sourceBudgetMs: 200, waitBudgetMs: 500, state: "source" });
    expect(db).toMatchObject({ outcome: "source_deadline", sourceBudgetMs: 200, waitBudgetMs: 500, state: "shared" });
    expect(da?.sourceOperationId === db?.sourceOperationId).toBe(true);
    expect(da?.waiterId === db?.waiterId).toBe(false);
    expect(da!.durationMs - db!.durationMs).toBe(100);
    expect(f.calls.length).toBe(1);
    expect(service.snapshot().activeWaiters).toBe(0);
    release();
  }));
});

test("waiter deadline does not inherit source timeout and does not cancel another waiter's source", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader, { sourceWaitMs: 500, waiterWaitMs: 200 });
    const a = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => f.calls.length === 1);
    yield* TestClock.adjust("100 millis");
    const b = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => service.snapshot().joined === 1);
    yield* TestClock.adjust("101 millis");
    const ra = yield* Fiber.join(a);
    expect(ra._tag).toBe("Failure");
    if (ra._tag === "Failure") expect(streamFailureDiagnostic(ra.failure)?.authority?.ownershipWait).toMatchObject({
      outcome: "waiter_deadline", sourceSettlement: "pending", waitBudgetMs: 200, sourceBudgetMs: 500,
    });
    expect(f.signals[0]!.aborted).toBe(false);
    release(); yield* Fiber.join(b);
    expect(f.calls.length).toBe(1);
  }));
});

test("a queued retired key cannot block another key when a separate source slot is free", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture; f.state.cooperative = false;
    const release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader, { maxEntries: 2 });
    const a = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => f.calls.length === 1);
    yield* Fiber.interrupt(a);
    const sameKey = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => service.snapshot().queuedWaiters === 1);
    yield* service.current(input(B));
    expect(f.calls).toEqual([A, B]);
    yield* Fiber.interrupt(sameKey); release();
    yield* flushUntil(() => service.snapshot().unsettledSources === 0);
  }));
});

test("capacity counts waiters before any local witness and does not start excess work", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader, { maxWaiters: 1 });
    const a = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => f.calls.length === 1);
    const localCalls = f.state.localCalls;
    const rejected = yield* Effect.result(service.current(input(B)));
    expect(rejected._tag).toBe("Failure");
    expect(f.state.localCalls).toBe(localCalls);
    expect(f.calls).toEqual([A]);
    release(); yield* Fiber.join(a);
  }));
});

test("a changed scope observed while a source is in flight prevents its late success from admission", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture, release = f.hold(), service = yield* makeOwnershipCoordinator(f.reader);
    const a = yield* Effect.forkChild(Effect.result(service.current(input())));
    yield* flushUntil(() => f.calls.length === 1);
    f.state.scope = "b".repeat(64);
    yield* service.current(input(B));
    f.state.scope = "a".repeat(64); release();
    const result = yield* Fiber.join(a);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.failureCode).toBe("ownership_identity_changed");
    expect(service.snapshot().activeWaiters).toBe(0);
    yield* service.current(input());
    expect(f.calls).toEqual([A, B, A]);
  }));
});

test("an uncooperative local witness also retains its physical bound after waiter cancellation", async () => {
  await run(Effect.gen(function* () {
    const f = yield* fixture;
    const original = f.reader.local!;
    let localCalls = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.reader.local = async (ids, signal) => { localCalls++; await held; return original(ids, signal); };
    const service = yield* makeOwnershipCoordinator(f.reader, { maxWaiters: 1 });
    const first = yield* Effect.forkChild(service.current(input()));
    yield* flushUntil(() => localCalls === 1);
    yield* Fiber.interrupt(first);
    expect(service.snapshot()).toMatchObject({ activeWaiters: 0, unsettledLocalReads: 1 });
    const blocked = yield* Effect.result(service.current(input(B)));
    expect(blocked._tag).toBe("Failure");
    expect(localCalls).toBe(1);
    expect(f.calls).toEqual([]);
    release(); yield* flushUntil(() => service.snapshot().unsettledLocalReads === 0);
    yield* service.current(input(B));
    expect(f.calls).toEqual([B]);
  }));
});

test("service Scope closure drops unused cache and never creates a background refresh", async () => {
  const final = await run(Effect.gen(function* () {
    const f = yield* fixture, service = yield* makeOwnershipCoordinator(f.reader);
    yield* service.current(input());
    yield* TestClock.adjust("1 minute");
    expect(f.calls).toEqual([A]);
    return service.snapshot;
  }));
  expect(final()).toMatchObject({ closed: true, activeWaiters: 0, queuedWaiters: 0,
    activeSources: 0, unsettledSources: 0, unsettledLocalReads: 0, retainedEntries: 0 });
});
