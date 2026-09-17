import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Layer, Stream, SynchronizedRef } from "effect";
import { TestClock } from "effect/testing";
import { AdmissionAuthority, RuntimeEvents } from "../src/ports.ts";
import { contextSnapshotBody, type RunStepRequest, type AdmissionAuthorityResult, type AuthorityProgress, streamFailureDiagnostic, projectAuthorityProgress } from "../src/contract.ts";
import { computeSnapshotDigest } from "../src/hash.ts";
import { runStep, cancelStep, inferenceMemoryLayer, InferenceMemory, inferenceCapacity } from "../src/inference.ts";
import { turnKey, ledgerKey } from "../src/internal/inference/route-binding.ts";
import { readAuthority, validateAuthorityPermit, type AuthorityPermit } from "../src/internal/inference/authority-gate.ts";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "../src/selection.ts";
import { createCountedSeams, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "../src/testing.ts";

const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { fixture: STUB_ECHO_MODEL_ID } } });
const selected = captureManagedSelection(models, "fixture");
if (selected.kind !== "managed") throw Error("fixture");
const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [], messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
const request: RunStepRequest = { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v6" },
  serviceEpoch: { incarnationId: "gate-fixture" }, agentId: "fixture", turnId: "turn", stepId: "step",
  selection: { agentId: "fixture", modelId: selected.modelId, selectionRevision: selected.selectionRevision }, snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
const permitted = Effect.map(Clock.currentTimeMillis, observedAtMs => ({ admitted: true as const, ownership: { scopeId: "a".repeat(64), serverId: "server", observedAtMs } }));
const consume = (req = request) => Effect.scoped(Effect.gen(function* () {
  const step = yield* runStep(req);
  if (step.kind === "duplicate") return { kind: step.kind, events: [], bindingId: step.bindingId };
  const events = yield* Stream.runCollect(step.stream);
  return { kind: step.kind, events, bindingId: step.bindingId };
}));
function graph(authority: () => Effect.Effect<AdmissionAuthorityResult, unknown>, counts: ReturnType<typeof createCountedSeams>, progress: AuthorityProgress[] = [], observer?: (event: unknown) => Effect.Effect<void, unknown>, authOptions?: Parameters<typeof fakeBackendAuthLayer>[2]) {
  return fakeConfigurationReadLayer({ models: () => models }).pipe(
    Layer.merge(fakeBackendAuthLayer("synthetic", counts, authOptions)),
    Layer.merge(fakeModelBackendLayer([{ type: "text_delta", text: "one output" }, { type: "backend_finish", finishReason: "stop" }], counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "gate-fixture" })),
    Layer.merge(Layer.succeed(AdmissionAuthority, { current: authority })),
    Layer.merge(Layer.succeed(RuntimeEvents, { append: observer ?? (event => Effect.sync(() => {
      const projected = projectAuthorityProgress((event as { authority?: unknown }).authority); if (projected) progress.push(projected);
    })) })),
  );
}

test("the gate accounts for ingress time before runStep instead of renewing the total deadline", async () => {
  const counts = createCountedSeams();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const startedTick = yield* Clock.monotonicTimeNanos;
    const worker = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
      yield* Effect.sleep("175 seconds");
      return yield* Effect.result(runStep(request, { startedTick }));
    })));
    yield* TestClock.adjust("181 seconds");
    return yield* Fiber.join(worker);
  }).pipe(Effect.provide(graph(() => Effect.never, counts)), Effect.provide(TestClock.layer()))));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(streamFailureDiagnostic(result.failure)?.authority).toMatchObject({
    reason: "ownership_read_timeout", waitBudgetMs: 5000,
  });
  expect(counts.network).toBe(0);
});

test("a future process-local ingress origin is rejected before claiming the STEP", async () => {
  const counts = createCountedSeams();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const startedTick = (yield* Clock.monotonicTimeNanos) + 1n;
    const outcome = yield* Effect.result(runStep(request, { startedTick }));
    return { outcome, capacity: yield* inferenceCapacity };
  }).pipe(Effect.provide(graph(() => permitted, counts)), Effect.provide(TestClock.layer()))));
  expect(result.outcome).toMatchObject({ _tag: "Failure", failure: { code: "step_invalid" } });
  expect(result.capacity.counters.accepted).toBe(0); expect(counts.network).toBe(0);
});

test("all checkpoints share one cumulative authority allowance instead of resetting a ten-second timeout", async () => {
  const counts = createCountedSeams(), progress: AuthorityProgress[] = [];
  let calls = 0;
  const authority = () => Effect.gen(function* () { calls++; yield* Effect.sleep("4 seconds"); return yield* permitted; });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.result(consume()));
    yield* TestClock.adjust("11 seconds");
    const outcome = yield* Fiber.join(fiber);
    const memory = yield* InferenceMemory;
    return { outcome, turn: (yield* SynchronizedRef.get(memory.ref)).turns.get(turnKey(request)), resources: memory.authoritySteps.size };
  }).pipe(Effect.provide(graph(authority, counts, progress)), Effect.provide(TestClock.layer()))));
  expect(result.outcome._tag).toBe("Failure");
  expect(counts.network).toBe(0); expect(calls).toBe(3);
  expect(result.turn?.lifecycle).toBe("closed"); expect(result.resources).toBe(0);
  expect(progress.at(-1)?.phase).toBe("denied");
  expect(progress.some(p => p.cumulativeMs >= 10000)).toBe(true);
});

test("cancel while initial authority is waiting interrupts it and leaves no provider attempt or live budget", async () => {
  const counts = createCountedSeams(), progress: AuthorityProgress[] = [];
  const entered = Deferred.makeUnsafe<void>();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(Effect.result(consume()));
    yield* Deferred.await(entered);
    expect((yield* inferenceCapacity).authority).toMatchObject({ active: 1, waiting: 1, readRetries: 0 });
    yield* cancelStep(request);
    const outcome = yield* Fiber.join(worker);
    return { outcome, capacity: yield* inferenceCapacity, retained: (yield* InferenceMemory).authoritySteps.size };
  }).pipe(Effect.provide(graph(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)), counts, progress)))));
  expect(result.outcome).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } });
  expect(counts.network).toBe(0); expect(result.retained).toBe(0); expect(result.capacity.activeSteps).toBe(0);
  expect(result.capacity.authority).toMatchObject({ active: 0, waiting: 0 });
  expect(progress.at(-1)?.phase).toBe("cancelled");
});

test("same STEP arriving while authority waits is absorbed without another authority call or inference", async () => {
  const counts = createCountedSeams(), entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  let calls = 0;
  const authority = () => Effect.gen(function* () { if (++calls === 1) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); } return yield* permitted; });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(consume());
    yield* Deferred.await(entered);
    const duplicate = yield* consume();
    const before = calls;
    yield* Deferred.succeed(release, undefined);
    return { duplicate, before, original: yield* Fiber.join(worker) };
  }).pipe(Effect.provide(graph(authority, counts)))));
  expect(result.duplicate.kind).toBe("duplicate"); expect(result.before).toBe(1);
  expect(result.original.kind).toBe("live"); expect(counts.network).toBe(1);
});

test("waiting at finish preserves an already produced result without reinference", async () => {
  const counts = createCountedSeams(), entered = Deferred.makeUnsafe<void>(), release = Deferred.makeUnsafe<void>();
  const progress: AuthorityProgress[] = [];
  const authority = () => Effect.gen(function* () {
    if (counts.network === 1) { yield* Deferred.succeed(entered, undefined); yield* Deferred.await(release); }
    return yield* permitted;
  });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(consume());
    yield* Deferred.await(entered);
    expect(counts.network).toBe(1);
    yield* Deferred.succeed(release, undefined);
    return yield* Fiber.join(worker);
  }).pipe(Effect.provide(graph(authority, counts, progress)))));
  expect(counts.network).toBe(1);
  expect(result.events).toEqual([{ type: "text_delta", text: "one output" }, { type: "backend_finish", finishReason: "stop" }]);
  expect(progress.some(p => p.phase === "waiting" && p.checkpoint === "finish")).toBe(true);
});

for (const reason of ["ownership_read_unavailable", "confirmed_temporal"] as const) test(`terminal ${reason} cannot revive the TURN when later evidence becomes box`, async () => {
  const counts = createCountedSeams(); let refused = true;
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* Effect.result(consume());
    const memory = yield* InferenceMemory;
    const lifecycle = (yield* SynchronizedRef.get(memory.ref)).turns.get(turnKey(request))?.lifecycle;
    refused = false;
    const next = yield* Effect.result(consume({ ...request, stepId: "step2" }));
    return { first, next, lifecycle };
  }).pipe(Effect.provide(graph(() => refused ? Effect.succeed({ admitted: false, reason }) : permitted, counts)))));
  expect(result.first._tag).toBe("Failure"); expect(result.next._tag).toBe("Failure"); expect(counts.network).toBe(0);
  expect(result.lifecycle).toBe(reason === "confirmed_temporal" ? "revoked" : "closed");
});

test("a broken progress observer cannot fail inference or grant permission", async () => {
  const counts = createCountedSeams();
  let observed = 0;
  const result = await Effect.runPromise(consume().pipe(Effect.provide(graph(() => permitted, counts, [],
    () => Effect.sync(() => { observed++; }).pipe(Effect.andThen(Effect.die("synthetic observer defect")))))));
  expect(observed).toBeGreaterThan(0);
  expect(result.kind).toBe("live"); expect(counts.network).toBe(1);
});

test("credential rotation during the final authority wait is caught before dispatch", async () => {
  const counts = createCountedSeams();
  let checks = 0, valid = true;
  const authority = () => Effect.gen(function* () {
    if (++checks === 3) valid = false;
    return yield* permitted;
  });
  const result = await Effect.runPromise(Effect.result(consume().pipe(Effect.provide(graph(authority, counts, [], undefined, { verifyOk: () => valid })))));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "auth_mismatch" } });
  expect(counts.network).toBe(0); expect(checks).toBe(3);
});

test("a slow final credential verification cannot consume an expired authority permit", async () => {
  const counts = createCountedSeams();
  let checks = 0;
  const authority = () => Effect.gen(function* () { checks++; return yield* permitted; });
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.forkChild(Effect.result(consume()));
    yield* TestClock.adjust("6 seconds");
    return yield* Fiber.join(worker);
  }).pipe(Effect.provide(graph(authority, counts, [], undefined, {
    beforeVerify: Effect.suspend(() => checks === 3 ? Effect.sleep("6 seconds") : Effect.void),
  })), Effect.provide(TestClock.layer()))));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(streamFailureDiagnostic(result.failure)?.authority?.reason).toBe("ownership_evidence_stale");
  expect(counts.network).toBe(0);
});

test("a permit is valid only for its exact live STEP owner, not a copy, closed STEP or another runtime", async () => {
  const counts = createCountedSeams();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let permit!: AuthorityPermit;
    yield* Effect.scoped(Effect.gen(function* () {
      const step = yield* runStep(request); if (step.kind !== "live") throw Error("fixture");
      permit = yield* readAuthority(request);
      yield* validateAuthorityPermit(request, permit);
      const unrelated = yield* Effect.result(validateAuthorityPermit({ ...request, serviceEpoch: { incarnationId: "another" } }, permit));
      expect(unrelated._tag).toBe("Failure");
    }));
    const closed = yield* Effect.result(validateAuthorityPermit(request, permit));
    const copied = yield* Effect.result(validateAuthorityPermit(request, { ...permit }));
    const otherRuntime = yield* Effect.result(validateAuthorityPermit(request, permit).pipe(
      Effect.provide(inferenceMemoryLayer({ serviceEpoch: "gate-fixture" }))));
    return { closed, copied, otherRuntime, retained: (yield* InferenceMemory).authoritySteps.size };
  }).pipe(Effect.provide(graph(() => permitted, counts)))));
  expect(result.closed._tag).toBe("Failure"); expect(result.copied._tag).toBe("Failure");
  expect(result.otherRuntime._tag).toBe("Failure"); expect(result.retained).toBe(0); expect(counts.network).toBe(0);
});

test("a permit cannot be consumed once its durable STEP has settled, even before Scope cleanup", async () => {
  const counts = createCountedSeams();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const step = yield* runStep(request); if (step.kind !== "live") throw Error("fixture");
    const permit = yield* readAuthority(request);
    yield* Stream.runDrain(step.stream);
    const memory = yield* InferenceMemory;
    expect((yield* SynchronizedRef.get(memory.ref)).ledger.has(ledgerKey(request))).toBe(false);
    expect((yield* Effect.result(validateAuthorityPermit(request, permit)))._tag).toBe("Failure");
  }).pipe(Effect.provide(graph(() => permitted, counts)))));
  expect(counts.network).toBe(1);
});

test("authority defects remain defects, never converted into recoverable source failures", async () => {
  const counts = createCountedSeams();
  const exit = await Effect.runPromise(Effect.exit(consume().pipe(Effect.provide(graph(() => Effect.die("synthetic gate defect"), counts)))));
  expect(exit._tag).toBe("Failure"); expect(counts.network).toBe(0);
});
