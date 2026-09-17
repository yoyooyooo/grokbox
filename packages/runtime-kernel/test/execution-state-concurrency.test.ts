import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Layer, Stream, SynchronizedRef } from "effect";
import { BindingFailure, contextSnapshotBody, type RunStepRequest } from "../src/contract.ts";
import { computeSnapshotDigest } from "../src/hash.ts";
import { InferenceMemory, cancelStep, coolInactiveTurns, inferenceCapacity, inferenceMemoryLayer,
  memoryExecutionHistory, runStep, type ExecutionHistory } from "../src/inference.ts";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "../src/selection.ts";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "../src/testing.ts";
import { ledgerKey, turnKey } from "../src/internal/inference/route-binding.ts";

const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { a: STUB_ECHO_MODEL_ID, b: STUB_ECHO_MODEL_ID } } });
const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [],
  messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
const request = (stepId: string, agentId = "a", turnId = stepId): RunStepRequest => {
  const selection = captureManagedSelection(models, agentId);
  if (selection.kind !== "managed") throw new Error("fixture");
  return { agentId, turnId, stepId, hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
    serviceEpoch: { incarnationId: "identity-fixture" }, selection: { agentId, modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot };
};
const collect = (req: RunStepRequest) => Effect.scoped(Effect.gen(function* () {
  const live = yield* runStep(req);
  if (live.kind === "live") yield* Stream.runDrain(live.stream);
  return { kind: live.kind, bindingId: live.bindingId };
}));
const graph = (history: ExecutionHistory, counts = createCountedSeams(), target = 200) => fakeBackendAuthLayer("fixture", counts).pipe(
  Layer.merge(fakeConfigurationReadLayer({ models: () => models })),
  Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
  Layer.merge(fakeModelBackendLayer([{ type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }], counts)),
  Layer.merge(inferenceMemoryLayer({ serviceEpoch: "identity-fixture", history, hotTurnsTarget: target })),
);
const until = <R>(condition: Effect.Effect<boolean, never, R>) => Effect.gen(function* () {
  for (let n = 0; n < 300; n++) { if (yield* condition) return; yield* Effect.yieldNow; }
  throw new Error("independent progress barrier did not settle");
});

function slowClaim(backing: ExecutionHistory, target: RunStepRequest) {
  const entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  let claims = 0;
  const history: ExecutionHistory = { ...backing, putIdentity: value => Effect.gen(function* () {
    if (value.stepKey === ledgerKey(target) && !value.step.bindingId) {
      claims++;
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release).pipe(Effect.timeout("2 seconds"), Effect.mapError(() => new BindingFailure("ledger_unavailable")));
    }
    yield* backing.putIdentity(value);
  }) };
  return { history, entered, release, claims: () => claims };
}

test("a blocked Bot claim does not hold the global state lock or prevent another Bot's complete STEP", async () => {
  const a = request("a"), counts = createCountedSeams();
  const blocked = slowClaim(memoryExecutionHistory(), a);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* Effect.forkChild(collect(a));
    yield* Deferred.await(blocked.entered);
    const second = yield* Effect.forkChild(collect(request("b", "b")));
    yield* until(Effect.sync(() => counts.network === 1));
    expect((yield* Fiber.join(second)).kind).toBe("live");
    expect(blocked.claims()).toBe(1);
    yield* Deferred.succeed(blocked.release, undefined);
    expect((yield* Fiber.join(first)).kind).toBe("live");
    expect(counts.network).toBe(2);
    const memory = yield* InferenceMemory;
    expect(memory.stateLocks.size).toBe(0);
    expect((yield* inferenceCapacity).activeSteps).toBe(0);
  }).pipe(Effect.ensuring(Deferred.succeed(blocked.release, undefined)), Effect.provide(graph(blocked.history, counts)))));
});

test("pressure maintenance with blocked cold storage never becomes a foreground wait for another Bot", async () => {
  const backing = memoryExecutionHistory(), counts = createCountedSeams();
  const entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  const old = request("old"); let injecting = false;
  const history: ExecutionHistory = { ...backing, putTurn: (key, value) => Effect.gen(function* () {
    if (injecting && key === turnKey(old)) {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release).pipe(Effect.timeout("2 seconds"), Effect.mapError(() => new BindingFailure("ledger_unavailable")));
    }
    yield* backing.putTurn(key, value);
  }) };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* collect(old); injecting = true;
    const second = yield* Effect.forkChild(collect(request("second", "b")));
    yield* Deferred.await(entered);
    const third = yield* Effect.forkChild(collect(request("third", "b")));
    yield* until(Effect.sync(() => counts.network === 3));
    expect((yield* Fiber.join(third)).kind).toBe("live");
    expect((yield* Fiber.join(second)).kind).toBe("live");
    yield* Deferred.succeed(release, undefined);
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)), Effect.provide(graph(history, counts, 1)))));
});

test("same-STEP contenders serialize by identity and cannot publish two claims or dispatch twice", async () => {
  const req = request("same"), counts = createCountedSeams();
  const blocked = slowClaim(memoryExecutionHistory(), req);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* Effect.forkChild(collect(req));
    yield* Deferred.await(blocked.entered);
    const second = yield* Effect.forkChild(collect(req));
    const memory = yield* InferenceMemory;
    yield* until(Effect.sync(() => memory.stateLocks.get(turnKey(req))?.users === 2));
    expect(blocked.claims()).toBe(1); expect(counts.network).toBe(0);
    yield* Deferred.succeed(blocked.release, undefined);
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
    expect(results.map(value => value.kind).sort()).toEqual(["duplicate", "live"]);
    expect(counts.network).toBe(1); expect(blocked.claims()).toBe(1);
    expect(memory.stateLocks.size).toBe(0);
  }).pipe(Effect.ensuring(Deferred.succeed(blocked.release, undefined)), Effect.provide(graph(blocked.history, counts)))));
});

test("cancel intent fences dispatch before its identity's blocked persistence can acknowledge cancellation", async () => {
  const req = request("cancel"), counts = createCountedSeams();
  const blocked = slowClaim(memoryExecutionHistory(), req);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(Effect.result(collect(req)));
    yield* Deferred.await(blocked.entered);
    const memory = yield* InferenceMemory;
    const stopping = yield* Effect.forkChild(cancelStep(req));
    yield* until(SynchronizedRef.get(memory.ref).pipe(Effect.map(state => state.cancelled.has(ledgerKey(req)))));
    yield* collect(request("other", "b"));
    expect(counts.network).toBe(1);
    yield* Deferred.succeed(blocked.release, undefined);
    yield* Fiber.join(stopping);
    const result = yield* Fiber.join(worker);
    expect(result._tag).toBe("Failure");
    expect(counts.network).toBe(1);
    expect((yield* SynchronizedRef.get(memory.ref)).cancelled.size).toBe(0);
    expect(memory.stateLocks.size).toBe(0);
  }).pipe(Effect.ensuring(Deferred.succeed(blocked.release, undefined)), Effect.provide(graph(blocked.history, counts)))));
});

test("a writer bypassing the identity owner during I/O is rejected instead of being overwritten", async () => {
  const req = request("raced"), counts = createCountedSeams();
  const backing = memoryExecutionHistory(), blocked = slowClaim(backing, req);
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(Effect.result(collect(req)));
    yield* Deferred.await(blocked.entered);
    const memory = yield* InferenceMemory;
    yield* SynchronizedRef.update(memory.ref, state => {
      const turns = new Map(state.turns);
      turns.set(turnKey(req), { serviceEpoch: "identity-fixture", lifecycle: "revoked", expired: false, lastActivityMs: 0 });
      return { ...state, turns };
    });
    yield* Deferred.succeed(blocked.release, undefined);
    const result = yield* Fiber.join(worker);
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
    expect((yield* SynchronizedRef.get(memory.ref)).turns.get(turnKey(req))?.lifecycle).toBe("revoked");
    expect((yield* backing.getStep(ledgerKey(req)))?.status).toBe("active");
    expect(counts.network).toBe(0);
  }).pipe(Effect.ensuring(Deferred.succeed(blocked.release, undefined)), Effect.provide(graph(blocked.history, counts)))));
});

test("forced maintenance is bounded per pass and preserves the remaining live owners", async () => {
  const history = memoryExecutionHistory();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    for (let i = 0; i < 70; i++) yield* collect(request(`step-${i}`));
    const memory = yield* InferenceMemory;
    expect((yield* inferenceCapacity).hotTurns).toBe(70);
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    expect((yield* inferenceCapacity).hotTurns).toBe(38);
    expect(memory.turnScopes.size).toBe(38);
    expect(memory.coolingQueue.size).toBe(38);
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    expect((yield* inferenceCapacity).hotTurns).toBe(6);
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    expect((yield* inferenceCapacity).hotTurns).toBe(0);
    expect(memory.stateLocks.size).toBe(0); expect(memory.retiringScopes.size).toBe(0);
    expect((yield* collect(request("step-0"))).kind).toBe("duplicate");
  }).pipe(Effect.provide(graph(history)))));
});

test("partial maintenance reports its actual per-identity commits, not a fictitious global rollback", async () => {
  const backing = memoryExecutionHistory(); let inject = false, writes = 0;
  const history: ExecutionHistory = { ...backing, putTurn: (key, value) => Effect.suspend(() =>
    inject && ++writes === 2 ? Effect.fail(new BindingFailure("ledger_unavailable")) : backing.putTurn(key, value)) };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* collect(request("one")); yield* collect(request("two"));
    const memory = yield* InferenceMemory; inject = true;
    const result = yield* Effect.result(coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true));
    expect(result._tag).toBe("Failure");
    expect((yield* inferenceCapacity).hotTurns).toBe(1); expect(memory.turnScopes.size).toBe(1);
    expect(memory.retiringScopes.size).toBe(0);
    inject = false;
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    expect(memory.turnScopes.size).toBe(0); expect(memory.coolingQueue.size).toBe(0);
  }).pipe(Effect.provide(graph(history)))));
});
