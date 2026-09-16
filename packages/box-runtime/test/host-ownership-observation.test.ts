import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { streamFailureDiagnostic } from "@grokbox/runtime-kernel/contract";
import { bindHostOwnershipRead } from "../src/internal/host/ownership-read.ts";
import { readManagedOwnership } from "../src/internal/io/ownership-admission.node.ts";
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { backend: "https://fixture.invalid", account: "a".repeat(64), machine: "synthetic", team: null };
const ports = { agentIds: [agentId], readScope: () => scope, readWindow: () => ({ kind: "inactive" }),
  readExecution: () => ({ allowed: true, bound: true }), readLocal: () => ({ harness: "box", serverId: "s1" }) };

test("request, shared wait and cache retain distinct timing and original evidence age", async () => {
  let now = 1000, calls = 0;
  let finish!: (value: unknown) => void, started!: () => void;
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const read = bindHostOwnershipRead({ now: () => now, cacheMs: 2000 });
  const listServer = async () => { calls++; started(); return pending; };
  const first = read({ ...ports, listServer }); await entered;
  now = 1010; const shared = read({ ...ports, listServer });
  // Let the shared caller enter its existing native pending read.
  await Promise.resolve(); await Promise.resolve();
  now = 1020; finish({ agents: [{ agentId, id: "s1", harness: "box" }] });
  const [a, b] = await Promise.all([first, shared]);
  expect(a.readObservation).toMatchObject({ state: "observed", phase: "complete", serverRead: "request", durationMs: 20, serverEvidenceAgeMs: 20 });
  expect(b.readObservation).toMatchObject({ serverRead: "shared", durationMs: 10, serverEvidenceAgeMs: 20 });
  now = 1050; const cached = await read({ ...ports, listServer });
  expect(cached.readObservation).toMatchObject({ serverRead: "cache", durationMs: 0, serverEvidenceAgeMs: 50 });
  expect(cached.readObservation?.serverWaitMs).toBeUndefined(); expect(calls).toBe(1);
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
