import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Latch, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { BindingFailure, contextSnapshotBody, type ContextSnapshot, type HostEpoch, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { cancelStep, inferenceMemoryLayer, runStep, type RunStepRequest } from "@grokbox/runtime-kernel/inference";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, parseModelsFile, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeModelBackendLayer,
} from "@grokbox/runtime-kernel/testing";
import { emptyInferenceState } from "../src/internal/inference/route-binding.ts";
import { occupy } from "../src/internal/inference/step-ledger.ts";

const HOST: HostEpoch = {
  compile: "compile",
  source: "source",
  profile: "profile",
  hostIdentity: "host",
  bridgeDigest: "bridge",
  wireVersion: "v3",
};

const EVENTS: InferenceEvent[] = [
  { type: "text_delta", text: "ok" },
  { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
];

function file(): ModelsFile {
  return parseModelsFile({
    version: 1,
    models: {},
    assignments: { main: null, agents: { "agent-a": STUB_ECHO_MODEL_ID, "agent-b": STUB_ECHO_MODEL_ID } },
  });
}

function snap(text = "hi"): ContextSnapshot {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }],
    messages: [{ role: "user", content: text }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function req(extra: Partial<RunStepRequest> = {}): RunStepRequest {
  const models = file();
  const captured = captureManagedSelection(models, extra.agentId ?? "agent-a");
  if (captured.kind !== "managed") throw new Error("expected managed");
  return {
    hostEpoch: HOST,
    serviceEpoch: { incarnationId: "svc-1" },
    agentId: "agent-a",
    turnId: "turn-1",
    stepId: "step-1",
    selection: { agentId: extra.agentId ?? "agent-a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
    snapshot: snap(),
    ...extra,
  };
}

function graph(input: {
  counts?: ReturnType<typeof createCountedSeams>;
  beforeRead?: Effect.Effect<void>;
  ledgerMax?: number;
} = {}) {
  const counts = input.counts ?? createCountedSeams();
  return fakeBackendAuthLayer("secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer(EVENTS, counts)),
    Layer.merge(fakeConfigurationReadLayer({ models: file, beforeRead: input.beforeRead })),
    Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1", ledgerMax: input.ledgerMax })),
    Layer.merge(TestClock.layer()),
  );
}

function collect(request: RunStepRequest) {
  return Effect.gen(function* () {
    const admitted = yield* runStep(request);
    if (!("stream" in admitted)) return admitted;
    const events = yield* Stream.runCollect(admitted.stream);
    return { kind: "live" as const, bindingId: admitted.bindingId, events: [...events] as InferenceEvent[] };
  });
}

function run<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>);
}

function fork<A>(effect: Effect.Effect<A, unknown, unknown>) {
  return Effect.runFork(effect as Effect.Effect<A, unknown>);
}

describe("step ledger", () => {
  test("missing/bad STEP reject; duplicate vs conflict; no replay", async () => {
    expect(occupy(emptyInferenceState({ serviceEpoch: "svc-1" }), req({ stepId: "" }), 0)).toMatchObject({
      ok: false,
      error: { code: "step_missing" },
    });
    expect(occupy(emptyInferenceState({ serviceEpoch: "svc-1" }), req({ stepId: "bad id" }), 0)).toMatchObject({
      ok: false,
      error: { code: "step_invalid" },
    });

    const layer = graph();
    const firstReq = req();
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(firstReq);
      const dup = yield* collect(firstReq);
      const conflict = yield* Effect.result(runStep({ ...firstReq, snapshot: snap("other") }));
      return { first, dup, conflict };
    }).pipe(Effect.provide(layer))));
    expect(result.first.kind).toBe("live");
    expect(result.dup).toMatchObject({ kind: "duplicate", snapshotDigest: firstReq.snapshot.snapshotDigest });
    expect(result.dup.kind === "duplicate").toBe(true);
    expect(result.conflict._tag).toBe("Failure");
    expect(result.conflict._tag === "Failure" ? result.conflict.failure : undefined).toMatchObject({ code: "step_conflict" });
  });

  test("concurrent STEP is turn_busy; other TURN proceeds; barriers not sleep", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    const counts = createCountedSeams();
    const layer = graph({
      counts,
      beforeRead: Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
        yield* gate.await;
      }),
    });
    const first = req({ stepId: "step-a" });
    const busy = req({ stepId: "step-b" });
    const other = req({ agentId: "agent-b", turnId: "turn-other", stepId: "step-a" });
    const fiberA = fork(Effect.scoped(collect(first).pipe(Effect.provide(layer))));
    await Effect.runPromise(Deferred.await(entered));
    await expect(run(Effect.scoped(collect(busy).pipe(Effect.provide(layer))))).rejects.toMatchObject({
      code: "turn_busy",
    });
    const otherFiber = fork(Effect.scoped(collect(other).pipe(Effect.provide(layer))));
    await Effect.runPromise(gate.open);
    const a = await Effect.runPromise(Fiber.join(fiberA));
    const o = await Effect.runPromise(Fiber.join(otherFiber));
    expect(a.kind).toBe("live");
    expect(o.kind).toBe("live");
  });

  test("capacity does not LRU-evict old ids", async () => {
    const counts = createCountedSeams();
    const layer = graph({ counts, ledgerMax: 2 });
    const one = req({ stepId: "s1" });
    const two = req({ turnId: "turn-2", stepId: "s1" });
    const three = req({ turnId: "turn-3", stepId: "s1" });
    const result = await run(Effect.scoped(Effect.gen(function* () {
      yield* collect(one);
      yield* collect(two);
      const full = yield* Effect.result(runStep(three));
      const again = yield* collect(one);
      return { full, again };
    }).pipe(Effect.provide(layer))));
    expect(result.full).toMatchObject({ _tag: "Failure", failure: { code: "capacity" } });
    expect(result.again.kind).toBe("duplicate");
    expect(counts.network).toBe(2);
  });

  test("BindingFailure codes stay explicit", () => {
    expect(new BindingFailure("turn_busy").code).toBe("turn_busy");
    expect(TestClock.layer).toBeDefined();
  });

  test("canonical digest is recomputed; absorbed IDs do not rerun", async () => {
    const forged = req();
    forged.snapshot = { ...forged.snapshot, snapshotDigest: "0".repeat(64) };
    expect(occupy(emptyInferenceState({ serviceEpoch: "svc-1" }), forged, 0)).toMatchObject({
      ok: false,
      error: { code: "step_invalid" },
    });

    const counts = createCountedSeams();
    const failLayer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failAfterFirst: true })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1" })),
      Layer.merge(TestClock.layer()),
    );
    const firstReq = req({ turnId: "turn-fail" });
    const outcome = await run(Effect.scoped(Effect.gen(function* () {
      const failed = yield* Effect.result(collect(firstReq));
      const retry = yield* collect(firstReq);
      return { failed, retry };
    }).pipe(Effect.provide(failLayer))));
    expect(outcome.failed._tag).toBe("Failure");
    expect(outcome.retry.kind).toBe("duplicate");
    expect(counts.network).toBe(1);

    const lateCounts = createCountedSeams();
    const lateLayer = graph({ counts: lateCounts });
    const step1 = req({ turnId: "turn-late", stepId: "s1" });
    const step2 = req({ turnId: "turn-late", stepId: "s2" });
    const late = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(step1);
      if (first.kind !== "live") throw new Error("expected live");
      const second = yield* collect({ ...step2, bindingId: first.bindingId });
      yield* cancelStep({
        hostEpoch: HOST,
        serviceEpoch: { incarnationId: "svc-1" },
        agentId: "agent-a",
        turnId: "turn-late",
        stepId: "s1",
      });
      const again = yield* collect({ ...step1, bindingId: first.bindingId });
      return { second, again };
    }).pipe(Effect.provide(lateLayer))));
    expect(late.again.kind).toBe("duplicate");
    expect(lateCounts.network).toBe(2);
  });

  test("unknown cancel is bounded; wrong ServiceEpoch is rejected", async () => {
    const counts = createCountedSeams();
    const layer = graph({ counts, ledgerMax: 2 });
    await expect(run(Effect.scoped(Effect.gen(function* () {
      yield* collect(req({ stepId: "keep-1" }));
      yield* collect(req({ turnId: "turn-2", stepId: "keep-2" }));
      for (let i = 0; i < 20; i += 1) {
        yield* cancelStep({
          hostEpoch: HOST,
          serviceEpoch: { incarnationId: "svc-1" },
          agentId: "agent-a",
          turnId: "ghost",
          stepId: `ghost-${i}`,
        });
      }
    }).pipe(Effect.provide(layer))))).rejects.toMatchObject({ code: "capacity" });

    await expect(run(Effect.scoped(
      cancelStep({
        hostEpoch: HOST,
        serviceEpoch: { incarnationId: "other" },
        agentId: "agent-a",
        turnId: "turn-1",
        stepId: "step-1",
      }).pipe(Effect.provide(graph())),
    ))).rejects.toMatchObject({ code: "service_epoch_mismatch" });
  });
});
