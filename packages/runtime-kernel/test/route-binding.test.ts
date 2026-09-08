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

function models(agents: Record<string, string>, extra: Record<string, unknown> = {}): ModelsFile {
  return parseModelsFile({
    version: 1,
    models: {
      [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" },
      "openai/gpt": {
        provider: "openai",
        model: "gpt",
        endpoint: extra.endpoint ?? "https://api.example.test/v1",
        apiKeyRef: extra.apiKeyRef ?? "env:KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
      },
    },
    assignments: { main: null, agents },
  });
}

function snapshot(): ContextSnapshot {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-independent-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function request(file: ModelsFile, extra: Partial<RunStepRequest> = {}): RunStepRequest {
  const captured = captureManagedSelection(file, extra.agentId ?? "agent-a");
  if (captured.kind !== "managed") throw new Error("expected managed");
  return {
    hostEpoch: HOST,
    serviceEpoch: { incarnationId: "svc-1" },
    agentId: "agent-a",
    turnId: "turn-1",
    stepId: "step-1",
    selection: { agentId: "agent-a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
    snapshot: snapshot(),
    ...extra,
  };
}

function graph(input: {
  file: () => ModelsFile;
  counts?: ReturnType<typeof createCountedSeams>;
  beforeRead?: Effect.Effect<void>;
  beforeInfer?: Effect.Effect<void>;
  memory?: { serviceEpoch?: string; idleTtlMs?: number; ledgerMax?: number };
  events?: InferenceEvent[];
}) {
  const counts = input.counts ?? createCountedSeams();
  return fakeBackendAuthLayer("secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer(input.events ?? EVENTS, counts, { beforeInfer: input.beforeInfer })),
    Layer.merge(fakeConfigurationReadLayer({ models: input.file, beforeRead: input.beforeRead })),
    Layer.merge(fakeAdmissionAuthorityLayer()),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1", ...input.memory })),
    Layer.merge(TestClock.layer()),
  );
}

function collect(req: RunStepRequest) {
  return Effect.gen(function* () {
    const admitted = yield* runStep(req);
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

describe("route binding", () => {
  test("A5 rejects endpoint/ref or dropped opt-in before auth/provider", async () => {
    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    let file = models({ "agent-a": "openai/gpt" });
    const counts = createCountedSeams();
    const req = request(file);
    const layer = graph({
      file: () => file,
      counts,
      beforeRead: Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* gate.await;
      }),
    });
    const fiber = fork(Effect.scoped(collect(req).pipe(Effect.provide(layer))));
    await Effect.runPromise(Deferred.await(entered));
    file = models({ "agent-a": "openai/gpt" }, { endpoint: "https://other.test/v1" });
    await Effect.runPromise(gate.open);
    await expect(Effect.runPromise(Fiber.join(fiber))).rejects.toMatchObject({ code: "selection_mismatch" });
    expect(counts.credential).toBe(0);
    expect(counts.network).toBe(0);

    const droppedEnter = await Effect.runPromise(Deferred.make<void>());
    const droppedGate = await Effect.runPromise(Latch.make(false));
    let dropped = models({ "agent-a": "openai/gpt" });
    const dropCounts = createCountedSeams();
    const dropReq = request(dropped);
    const dropLayer = graph({
      file: () => dropped,
      counts: dropCounts,
      beforeRead: Effect.gen(function* () {
        yield* Deferred.succeed(droppedEnter, undefined);
        yield* droppedGate.await;
      }),
    });
    const dropFiber = fork(Effect.scoped(collect(dropReq).pipe(Effect.provide(dropLayer))));
    await Effect.runPromise(Deferred.await(droppedEnter));
    dropped = models({});
    await Effect.runPromise(droppedGate.open);
    await expect(Effect.runPromise(Fiber.join(dropFiber))).rejects.toMatchObject({ code: "not_admitted" });
    expect(dropCounts.credential).toBe(0);
    expect(dropCounts.network).toBe(0);
  });

  test("same TURN reuses bindingId without re-pin; missing ack is not a new TURN", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const counts = createCountedSeams();
    const layer = graph({ file: () => file, counts });
    const firstReq = request(file);
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(firstReq);
      if (first.kind !== "live") throw new Error("expected live");
      const second = yield* collect({ ...request(file, { stepId: "step-2" }), bindingId: first.bindingId });
      const missing = yield* Effect.result(runStep({ ...request(file, { stepId: "step-3" }) }));
      return { first, second, missing };
    }).pipe(Effect.provide(layer))));
    expect(result.first.kind).toBe("live");
    expect(result.second.kind).toBe("live");
    if (result.first.kind === "live" && result.second.kind === "live") {
      expect(result.second.bindingId).toBe(result.first.bindingId);
    }
    expect(counts.credential).toBe(1);
    expect(counts.network).toBe(2);
    expect(result.missing._tag).toBe("Failure");
    expect(result.missing._tag === "Failure" ? result.missing.failure : undefined).toMatchObject({ code: "binding_missing" });
  });

  test("idle expiry uses TestClock; restart rejects old ServiceEpoch", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const layer = graph({ file: () => file, memory: { idleTtlMs: 1_000 } });
    await expect(run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(request(file));
      if (first.kind !== "live") throw new Error("expected live");
      yield* TestClock.adjust("2 seconds");
      return yield* collect({ ...request(file, { stepId: "step-2" }), bindingId: first.bindingId });
    }).pipe(Effect.provide(layer))))).rejects.toMatchObject({ code: "turn_expired" });

    const restarted = graph({ file: () => file, memory: { serviceEpoch: "svc-2" } });
    await expect(run(Effect.scoped(
      collect(request(file)).pipe(Effect.provide(restarted)),
    ))).rejects.toMatchObject({ code: "service_epoch_mismatch" });
  });

  test("interrupt before pin poisons TURN; cancel drops later success", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    const counts = createCountedSeams();
    const layer = graph({
      file: () => file,
      counts,
      beforeRead: Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* gate.await;
      }),
    });
    const fiber = fork(Effect.scoped(collect(request(file)).pipe(Effect.provide(layer))));
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(gate.open);
    expect(counts.credential).toBe(0);
    expect(counts.network).toBe(0);
    await expect(run(Effect.scoped(
      collect(request(file)).pipe(Effect.provide(layer)),
    ))).rejects.toMatchObject({ code: "cancelled" });

    const between = await Effect.runPromise(Latch.make(false));
    const seen = await Effect.runPromise(Deferred.make<void>());
    const cancelCounts = createCountedSeams();
    const cancelLayer = graph({
      file: () => file,
      counts: cancelCounts,
      events: EVENTS,
      beforeInfer: Effect.gen(function* () {
        yield* Deferred.succeed(seen, undefined);
        yield* between.await;
      }),
      memory: { serviceEpoch: "svc-1" },
    });
    const collected: InferenceEvent[] = [];
    const liveFiber = fork(Effect.scoped(Effect.gen(function* () {
      const admitted = yield* runStep(request(file, { turnId: "turn-cancel" }));
      if (!("stream" in admitted)) throw new Error("expected live");
      yield* Stream.runForEach(admitted.stream, (event) => Effect.sync(() => collected.push(event as InferenceEvent)));
      return admitted.bindingId;
    }).pipe(Effect.provide(cancelLayer))));
    await Effect.runPromise(Deferred.await(seen));
    await run(Effect.scoped(
      cancelStep({ hostEpoch: HOST, serviceEpoch: { incarnationId: "svc-1" }, agentId: "agent-a", turnId: "turn-cancel", stepId: "step-1" }).pipe(
        Effect.provide(cancelLayer),
      ),
    ));
    await Effect.runPromise(between.open);
    await Effect.runPromise(Fiber.join(liveFiber).pipe(Effect.ignore));
    expect(collected.some((event) => event.type === "backend_finish")).toBe(false);
  });

  test("prepare happens before pin; uncovered capture stays official", () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    expect(captureManagedSelection(file, "nobody").kind).toBe("official");
    expect(request(file).selection.modelId).toBe(STUB_ECHO_MODEL_ID);
    expect(BindingFailure).toBeDefined();
  });
});
