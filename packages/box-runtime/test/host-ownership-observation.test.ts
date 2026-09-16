import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { readManagedOwnership } from "../src/internal/io/ownership-admission.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { backend: "https://fixture.invalid", account: "a".repeat(64), machine: "synthetic", team: null };
const ports = { agentIds: [agentId], readScope: () => scope, readWindow: () => ({ kind: "inactive" }),
  readExecution: () => ({ allowed: true, bound: true }), readLocal: () => ({ harness: "box", serverId: "s1" }) };

test("native request and shared wait retain original age; completed reuse belongs to modeld", async () => {
  let now = 1000, calls = 0;
  let finish!: (value: unknown) => void, started!: () => void;
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const read = bindHostOwnershipRead({ now: () => now });
  const listServer = async () => { calls++; started(); return pending; };
  const first = read({ ...ports, listServer }); await entered;
  now = 1010; const shared = read({ ...ports, listServer });
  // Let the shared caller enter its existing native pending read.
  await Promise.resolve(); await Promise.resolve();
  now = 1020; finish({ agents: [{ agentId, id: "s1", harness: "box" }] });
  const [a, b] = await Promise.all([first, shared]);
  expect(a.readObservation).toMatchObject({ state: "observed", phase: "complete", serverRead: "request", durationMs: 20, serverEvidenceAgeMs: 20 });
  expect(b.readObservation).toMatchObject({ serverRead: "shared", durationMs: 10, serverEvidenceAgeMs: 20 });
  now = 1050; const fresh = await read({ ...ports, listServer });
  expect(fresh.readObservation).toMatchObject({ serverRead: "request", durationMs: 0, serverEvidenceAgeMs: 0 });
  expect(calls).toBe(2);
  expect(fresh.readObservation?.sourceReadId === a.readObservation?.sourceReadId).toBe(false);
});

test("invalid input and a timed-out still-pending read expose refusal without another RPC", async () => {
  let calls = 0;
  const read = bindHostOwnershipRead({ timeoutMs: 10 });
  const listServer = async () => { calls++; return new Promise(() => undefined); };
  expect((await read({ ...ports, agentIds: ["bad"], listServer })).readObservation).toMatchObject({ errorCode: "invalid_request", phase: "input", serverRead: "not_started" });
  expect(calls).toBe(0);
  expect((await read({ ...ports, listServer })).readObservation).toMatchObject({ errorCode: "timeout", phase: "server" });
  expect((await read({ ...ports, listServer })).readObservation).toMatchObject({ errorCode: "busy", phase: "server", serverRead: "not_started" });
  expect(calls).toBe(1);
});

test("outer Effect ownership deadline is observed independently from any unreturned native RPC", async () => {
  let signal: AbortSignal | undefined;
  const program = Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(Effect.result(readManagedOwnership({ agentId, read: async (_ids, abort) => {
      signal = abort; Effect.runSync(Deferred.succeed(entered, undefined)); return new Promise(() => undefined);
    } })));
    yield* Deferred.await(entered);
    yield* TestClock.adjust("10001 millis");
    return yield* Fiber.join(fiber);
  })).pipe(Effect.provide(TestClock.layer()));
  const result = await Effect.runPromise(program);
  expect(result._tag).toBe("Failure"); if (result._tag !== "Failure") throw Error("fixture");
  expect(streamFailureDiagnostic(result.failure)?.authority).toMatchObject({ reason: "ownership_read_timeout", waitBudgetMs: 10000 });
  expect(streamFailureDiagnostic(result.failure)?.authority?.ownershipRead).toBeUndefined();
  expect(signal?.aborted).toBe(true);
});

test("direct managed selection cannot renew slow source evidence when wall time fails to advance", async () => {
  const program = Effect.scoped(Effect.gen(function* () {
    const underlying = yield* Clock.Clock;
    const fixedWall: Clock.Clock = {
      currentTimeMillis: Effect.succeed(1000), currentTimeMillisUnsafe: () => 1000,
      currentTimeNanos: Effect.succeed(1_000_000_000n), currentTimeNanosUnsafe: () => 1_000_000_000n,
      monotonicTimeNanos: underlying.monotonicTimeNanos,
      monotonicTimeNanosUnsafe: () => underlying.monotonicTimeNanosUnsafe(),
      sleep: duration => underlying.sleep(duration),
    };
    const entered = yield* Deferred.make<void>();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reader = async () => {
      Deferred.doneUnsafe(entered, Effect.void);
      await held;
      return { snapshot: ownedOwnershipSnapshot([agentId], { nowMs: 1000 }), gateway: { pid: 77, startedAt: 1 } };
    };
    const pending = yield* Effect.forkChild(Effect.result(readManagedOwnership({ agentId, read: reader })
      .pipe(Effect.provideService(Clock.Clock, fixedWall))));
    yield* Deferred.await(entered);
    yield* TestClock.adjust("5500 millis"); release();
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.failureCode).toBe("ownership_evidence_stale");
  })).pipe(Effect.provide(TestClock.layer()));
  await Effect.runPromise(program);
});
