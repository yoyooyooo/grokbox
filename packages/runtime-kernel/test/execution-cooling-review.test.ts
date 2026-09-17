import { expect, test } from "bun:test";
import { Clock, Effect, Layer, Stream, SynchronizedRef } from "effect";
import { BindingFailure, contextSnapshotBody, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { InferenceMemory, coolInactiveTurns, inferenceCapacity, inferenceMemoryLayer, memoryExecutionHistory, runStep, type ExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";
import { ledgerKey, turnKey } from "../src/internal/inference/route-binding.ts";

const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { "agent-review": STUB_ECHO_MODEL_ID, "new-agent": STUB_ECHO_MODEL_ID } } });
const body = contextSnapshotBody({ version: 1, profileId: "review", abiIdentity: "review", systemMessages: [], messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
function request(stepId: string, turnId = "turn-review", agentId = "agent-review"): RunStepRequest {
  const selection = captureManagedSelection(models, agentId);
  if (selection.kind !== "managed") throw new Error("fixture needs managed selection");
  return { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
    serviceEpoch: { incarnationId: "review-epoch" }, agentId, turnId, stepId,
    selection: { agentId, modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot };
}
function graph(history: ExecutionHistory, counts = createCountedSeams(), hotTurnsTarget = 1, authority: () => unknown = () => ({ admitted: true })) {
  return fakeBackendAuthLayer("synthetic-secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer([{ type: "text_delta", text: "ok" }, { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }], counts)),
    Layer.merge(fakeConfigurationReadLayer({ models: () => models })),
    Layer.merge(fakeAdmissionAuthorityLayer(authority, counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "review-epoch", hotTurnsTarget, history })),
  );
}
const collect = (req: RunStepRequest) => Effect.scoped(Effect.gen(function* () {
  const result = yield* runStep(req);
  if (result.kind === "duplicate") return result;
  yield* Stream.runDrain(result.stream);
  return { kind: "live" as const, bindingId: result.bindingId };
}));

test("cleanup read failure must not erase a cold immutable binding", async () => {
  const backing = memoryExecutionHistory();
  let read = 0, inject = false;
  const history: ExecutionHistory = { ...backing, getTurn: key => Effect.suspend(() => {
    if (inject && ++read === 3) return Effect.fail(new BindingFailure("ledger_unavailable"));
    return backing.getTurn(key);
  }) };
  const first = request("one"), counts = createCountedSeams();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const initial = yield* collect(first);
    const memory = yield* InferenceMemory;
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    inject = true;
    const refused = yield* Effect.result(collect(request("bad-missing-binding")));
    inject = false;
    const cold = yield* backing.getTurn(turnKey(first));
    const resumed = yield* Effect.result(collect({ ...request("two"), bindingId: initial.bindingId }));
    return { initial, refused, cold, resumed };
  }).pipe(Effect.provide(graph(history, counts)))));
  expect(result.refused).toMatchObject({ _tag: "Failure", failure: { code: "binding_missing" } });
  expect(result.cold?.binding?.bindingId).toBe(result.initial.bindingId);
  expect(result.resumed).toMatchObject({ _tag: "Success", success: { kind: "live", bindingId: result.initial.bindingId } });
  expect(counts.network).toBe(2);
});

test("an atomically persisted identity with an unknown acknowledgement cannot dispatch or be retried", async () => {
  const backing = memoryExecutionHistory(), counts = createCountedSeams();
  let fail = true;
  const history: ExecutionHistory = { ...backing, putIdentity: input => backing.putIdentity(input).pipe(Effect.andThen(Effect.suspend(() => {
    if (fail) { fail = false; return Effect.fail(new BindingFailure("ledger_unavailable")); }
    return Effect.void;
  }))) };
  const req = request("uncertain-claim");
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* Effect.result(collect(req));
    const again = yield* collect(req);
    const memory = yield* InferenceMemory;
    return { first, again, retained: (yield* SynchronizedRef.get(memory.ref)).ledger.size, cold: yield* backing.getStep(ledgerKey(req)) };
  }).pipe(Effect.provide(graph(history, counts)))));
  expect(result.first).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
  expect(result.again.kind).toBe("duplicate");
  expect(result.cold?.status).toBe("active");
  expect(result.retained).toBe(0);
  expect(counts.network).toBe(0);
});

test("storage lookup error cannot be treated as unseen STEP", async () => {
  const backing = memoryExecutionHistory(), counts = createCountedSeams();
  const history: ExecutionHistory = { ...backing, getStep: () => Effect.fail(new BindingFailure("ledger_unavailable")) };
  const result = await Effect.runPromise(Effect.scoped(Effect.result(collect(request("read-failed"))).pipe(Effect.provide(graph(history, counts)))));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
  expect(counts.network).toBe(0);
});

test("failure to cool an inactive TURN cannot become a quota on unrelated work", async () => {
  const backing = memoryExecutionHistory(), counts = createCountedSeams();
  const old = request("old", "old-turn");
  let injected = false;
  const history: ExecutionHistory = { ...backing, putTurn: (key, value) => Effect.suspend(() =>
    injected && key === turnKey(old) ? Effect.fail(new BindingFailure("ledger_unavailable")) : backing.putTurn(key, value)) };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* collect(old);
    injected = true;
    yield* collect(request("second", "second-turn"));
    const third = yield* Effect.result(collect(request("third", "third-turn")));
    injected = false;
    const duplicate = yield* collect(old);
    return { third, duplicate };
  }).pipe(Effect.provide(graph(history, counts)))));
  expect(result.third).toMatchObject({ _tag: "Success", success: { kind: "live" } });
  expect(result.duplicate.kind).toBe("duplicate");
  expect(counts.network).toBe(3);
});

test("partially committed cooling keeps every remaining binding attached to its live owner", async () => {
  const backing = memoryExecutionHistory(), counts = createCountedSeams();
  const one = request("one", "one"), two = request("two", "two");
  let injecting = false, writes = 0;
  const history: ExecutionHistory = { ...backing, putTurn: (key, value) => Effect.suspend(() =>
    injecting && ++writes === 2 ? Effect.fail(new BindingFailure("ledger_unavailable")) : backing.putTurn(key, value)) };
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* collect(one); yield* collect(two);
    const memory = yield* InferenceMemory;
    injecting = true;
    const cooled = yield* Effect.result(coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true));
    const state = yield* SynchronizedRef.get(memory.ref);
    const retainedOwners = [...state.bindings.keys()].every(key => memory.turnScopes.has(key));
    injecting = false;
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    return { cooled, retainedOwners, after: yield* inferenceCapacity };
  }).pipe(Effect.provide(graph(history, counts, 2)))));
  expect(result.cooled._tag).toBe("Failure");
  expect(result.retainedOwners).toBe(true);
  expect(result.after.hotTurns).toBe(0);
  expect(result.after.pinnedTurns).toBe(0);
});

test("a revoked cold TURN cannot revive when ownership changes back", async () => {
  const history = memoryExecutionHistory(), counts = createCountedSeams();
  let scope = "a".repeat(64);
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* collect(request("first"));
    const memory = yield* InferenceMemory;
    yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
    scope = "b".repeat(64);
    const revoked = yield* Effect.result(collect({ ...request("revoked"), bindingId: first.bindingId }));
    scope = "a".repeat(64);
    const back = yield* Effect.result(collect({ ...request("back"), bindingId: first.bindingId }));
    return { revoked, back };
  }).pipe(Effect.provide(graph(history, counts, 1, () => ({ admitted: true, ownership: {
    scopeId: scope, serverId: "owned-server-agent", observedAtMs: Date.now(),
  } }))))));
  expect(result.revoked).toMatchObject({ _tag: "Failure", failure: { code: "not_admitted" } });
  expect(result.back._tag).toBe("Failure");
  expect(counts.network).toBe(1);
});

test("4096 completed STEPs are reclaimed without a lifetime quota or duplicate replay", async () => {
  const history = memoryExecutionHistory(), counts = createCountedSeams();
  const first = request("s0", "t0");
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    for (let n = 0; n < 4096; n++) yield* collect(request(`s${n}`, `t${n}`));
    const duplicate = yield* collect(first);
    const newcomer = yield* collect(request("new", "new-turn", "new-agent"));
    return { duplicate, newcomer, capacity: yield* inferenceCapacity };
  }).pipe(Effect.provide(graph(history, counts)))));
  expect(result.duplicate.kind).toBe("duplicate");
  expect(result.newcomer.kind).toBe("live");
  expect(result.capacity).toMatchObject({ lifetimeStepLimit: null, activeSteps: 0, hotStepRecords: 0 });
  expect(result.capacity.hotTurns).toBeLessThanOrEqual(1);
  expect(result.capacity.pinnedTurns).toBeLessThanOrEqual(1);
  expect(counts.network).toBe(4097);
}, 60_000);
