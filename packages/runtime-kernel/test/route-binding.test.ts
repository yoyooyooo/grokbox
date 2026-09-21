import { describe, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Latch, Layer, Stream } from "effect";
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
    version: 3,
    models: {
      [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" },
      "openai/gpt": {
        provider: "openai",
        model: "gpt",
        endpoint: extra.endpoint ?? "https://api.example.test/v1",
        apiKeyRef: extra.apiKeyRef ?? "env:KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
        ...(extra.noWindow === true ? {} : { contextWindowTokens: extra.contextWindowTokens ?? 200000 }),
      },
    },
    assignments: { main: null, agents: Object.fromEntries(Object.entries(agents).map(([id, modelId]) => [id, { modelId }])) },
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
  afterMaterialize?: Effect.Effect<void>;
  beforeVerify?: Effect.Effect<void>;
  afterStream?: Effect.Effect<void>;
  evidence?: () => unknown;
  verifyOk?: () => boolean;
  failAfterFirst?: boolean;
  clock?: boolean;
  memory?: { serviceEpoch?: string; resourceIdleMs?: number; hotTurnsTarget?: number };
  events?: InferenceEvent[];
}) {
  const counts = input.counts ?? createCountedSeams();
  let layer = fakeBackendAuthLayer("secret", counts, {
    afterMaterialize: input.afterMaterialize,
    beforeVerify: input.beforeVerify,
    verifyOk: input.verifyOk,
  }).pipe(
    Layer.merge(fakeModelBackendLayer(input.events ?? EVENTS, counts, {
      beforeInfer: input.beforeInfer,
      failAfterFirst: input.failAfterFirst,
      afterStream: input.afterStream,
    })),
    Layer.merge(fakeConfigurationReadLayer({ models: input.file, beforeRead: input.beforeRead })),
    Layer.merge(fakeAdmissionAuthorityLayer(input.evidence ?? (() => ({ admitted: true })), counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "svc-1", ...input.memory })),
  );
  if (input.clock) layer = layer.pipe(Layer.merge(TestClock.layer()));
  return layer;
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

    let live = models({ "agent-a": "openai/gpt" });
    const captured = request(live);
    const saveCounts = createCountedSeams();
    const saveLayer = graph({ file: () => live, counts: saveCounts });
    const afterSave = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(captured);
      if (first.kind !== "live") throw new Error("expected live");
      live = models({ "agent-a": "openai/gpt" }, { endpoint: "https://other.test/v1" });
      return yield* collect({ ...request(live, { stepId: "step-2", selection: captured.selection }), bindingId: first.bindingId });
    }).pipe(Effect.provide(saveLayer))));
    expect(afterSave.kind).toBe("live");
    expect(saveCounts.credential).toBe(1);
  });

  test("idle resources cool without expiring a TURN; restart still fences the old ServiceEpoch", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const layer = graph({ file: () => file, clock: true, memory: { resourceIdleMs: 1_000 } });
    await expect(run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(request(file));
      if (first.kind !== "live") throw new Error("expected live");
      yield* TestClock.adjust("2 seconds");
      return yield* collect({ ...request(file, { stepId: "step-2" }), bindingId: first.bindingId });
    }).pipe(Effect.provide(layer))))).resolves.toMatchObject({ kind: "live" });

    const restarted = graph({ file: () => file, memory: { serviceEpoch: "svc-2" } });
    await expect(run(Effect.scoped(
      collect(request(file)).pipe(Effect.provide(restarted)),
    ))).rejects.toMatchObject({ code: "service_epoch_mismatch" });
  });

  test("interrupt before pin absorbs the STEP without rerun", async () => {
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
    const retry = await run(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collect(request(file)));
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* gate.open;
      expect(counts.credential).toBe(0);
      expect(counts.network).toBe(0);
      return yield* Effect.result(collect(request(file)));
    }).pipe(Effect.provide(layer))));
    if (retry._tag === "Failure") {
      expect(retry.failure).toMatchObject({ code: "cancelled" });
    } else {
      expect(retry.success).toMatchObject({ kind: "duplicate" });
    }
    expect(counts.network).toBe(0);
  }, 8_000);

  test("cancel interrupts producer and drops later success", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
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
    });
    const collected: InferenceEvent[] = [];
    const joined = await run(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.gen(function* () {
        const admitted = yield* runStep(request(file, { turnId: "turn-cancel" }));
        if (!("stream" in admitted)) throw new Error("expected live");
        yield* Stream.runForEach(admitted.stream, (event) => Effect.sync(() => collected.push(event as InferenceEvent)));
      }));
      yield* Deferred.await(seen);
      yield* cancelStep({ hostEpoch: HOST, serviceEpoch: { incarnationId: "svc-1" }, agentId: "agent-a", turnId: "turn-cancel", stepId: "step-1" });
      yield* between.open;
      return yield* Effect.result(Fiber.join(fiber));
    }).pipe(Effect.provide(cancelLayer))));
    expect(joined._tag).toBe("Failure");
    expect(joined._tag === "Failure" ? joined.failure : undefined).toMatchObject({ code: "cancelled" });
    expect(collected.some((event) => event.type === "backend_finish")).toBe(false);
  }, 8_000);

  test("prepare happens before pin; authority evidence and dispatch fence are consumed", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    expect(captureManagedSelection(file, "nobody").kind).toBe("official");
    const counts = createCountedSeams();
    await run(Effect.scoped(collect(request(file)).pipe(Effect.provide(graph({ file: () => file, counts })))));
    expect(counts.order.indexOf("prepare")).toBeGreaterThan(-1);
    expect(counts.order.indexOf("prepare")).toBeLessThan(counts.order.indexOf("pin"));
    expect(counts.network).toBe(1);

    const denied = createCountedSeams();
    await expect(run(Effect.scoped(collect(request(file)).pipe(Effect.provide(graph({
      file: () => file,
      counts: denied,
      evidence: () => ({ admitted: false }),
    })))))).rejects.toMatchObject({ code: "not_admitted" });
    expect(denied.credential).toBe(0);
    expect(denied.network).toBe(0);
    expect(denied.prepare).toBe(0);

    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    let admitted = true;
    const late = createCountedSeams();
    const lateLayer = graph({
      file: () => file,
      counts: late,
      evidence: () => ({ admitted }),
      afterMaterialize: Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* gate.await;
      }),
    });
    const fiber = fork(Effect.scoped(collect(request(file, { turnId: "turn-late" })).pipe(Effect.provide(lateLayer))));
    await Effect.runPromise(Deferred.await(entered));
    admitted = false;
    await Effect.runPromise(gate.open);
    await expect(Effect.runPromise(Fiber.join(fiber))).rejects.toMatchObject({ code: "not_admitted" });
    expect(late.network).toBe(0);
  });

  test("nested STEP scopes keep TURN lease; unconsumed admission clears busy", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const counts = createCountedSeams();
    const layer = graph({ file: () => file, counts });
    const nested = await run(Effect.scoped(Effect.gen(function* () {
      const firstReq = request(file, { turnId: "turn-scope" });
      const first = yield* Effect.scoped(collect(firstReq));
      if (first.kind !== "live") throw new Error("expected live");
      const second = yield* Effect.scoped(collect({
        ...request(file, { turnId: "turn-scope", stepId: "step-2" }),
        bindingId: first.bindingId,
      }));
      return { first, second };
    }).pipe(Effect.provide(layer))));
    expect(nested.first.kind).toBe("live");
    expect(nested.second.kind).toBe("live");
    expect(counts.credential).toBe(1);
    expect(counts.network).toBe(2);
    expect(counts.order.filter((step) => step === "prepare").length).toBe(2);
    const prepareAt = counts.order.lastIndexOf("prepare");
    const verifyAt = counts.order.lastIndexOf("verify");
    expect(prepareAt).toBeLessThan(verifyAt);

    const busyCounts = createCountedSeams();
    const busyLayer = graph({ file: () => file, counts: busyCounts });
    const afterDrop = await run(Effect.scoped(Effect.gen(function* () {
      yield* Effect.scoped(runStep(request(file, { turnId: "turn-drop" })));
      return yield* Effect.result(collect(request(file, { turnId: "turn-drop", stepId: "step-2" })));
    }).pipe(Effect.provide(busyLayer))));
    expect(afterDrop._tag).toBe("Failure");
    expect(afterDrop._tag === "Failure" ? afterDrop.failure : undefined).not.toMatchObject({ code: "turn_busy" });
    expect(busyCounts.network).toBe(0);
    expect(counts.leasesAlive).toBe(0);
  });

  test("authority revoked during final verify does not dispatch", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    let admitted = true;
    const counts = createCountedSeams();
    const layer = graph({
      file: () => file,
      counts,
      evidence: () => ({ admitted }),
      beforeVerify: Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* gate.await;
      }),
    });
    const fiber = fork(Effect.scoped(collect(request(file, { turnId: "turn-verify" })).pipe(Effect.provide(layer))));
    await Effect.runPromise(Deferred.await(entered));
    admitted = false;
    await Effect.runPromise(gate.open);
    const outcome = await Effect.runPromise(Effect.result(Fiber.join(fiber)) as Effect.Effect<{ _tag: string; failure?: { code: string } }, unknown>);
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" ? outcome.failure : undefined).toMatchObject({ code: "not_admitted" });
    expect(counts.network).toBe(0);
  }, 8_000);

  test("cancel waits for producer cleanup before clearing busy", async () => {
    const file = models({ "agent-a": STUB_ECHO_MODEL_ID });
    const between = await Effect.runPromise(Latch.make(false));
    const seen = await Effect.runPromise(Deferred.make<void>());
    const cleanupHold = await Effect.runPromise(Latch.make(false));
    const cleanupStarted = await Effect.runPromise(Deferred.make<void>());
    const counts = createCountedSeams();
    const layer = graph({
      file: () => file,
      counts,
      beforeInfer: Effect.gen(function* () {
        yield* Deferred.succeed(seen, undefined);
        yield* between.await;
      }),
      afterStream: Effect.gen(function* () {
        yield* Deferred.succeed(cleanupStarted, undefined);
        yield* cleanupHold.await;
      }),
    });
    const firstReq = request(file, { turnId: "turn-quiet" });
    const next = await run(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collect(firstReq));
      yield* Deferred.await(seen);
      const cancelling = yield* Effect.forkChild(cancelStep({
        hostEpoch: HOST,
        serviceEpoch: { incarnationId: "svc-1" },
        agentId: "agent-a",
        turnId: "turn-quiet",
        stepId: "step-1",
      }));
      yield* Deferred.await(cleanupStarted);
      const busy = yield* Effect.result(collect(request(file, { turnId: "turn-quiet", stepId: "step-2" })));
      yield* cleanupHold.open;
      yield* Fiber.join(cancelling);
      yield* Effect.result(Fiber.join(fiber));
      return busy;
    }).pipe(Effect.provide(layer))));
    expect(next._tag).toBe("Failure");
    expect(next._tag === "Failure" ? next.failure : undefined).toMatchObject({ code: "turn_busy" });
    expect(counts.network).toBeLessThanOrEqual(1);
  }, 8_000);

  test("unknown provider capacity still uses the explicit default local working budget", async () => {
    const file = models({ "agent-a": "openai/gpt" }, { noWindow: true });
    const counts = createCountedSeams();
    const layer = graph({ file: () => file, counts });
    const result = await run(Effect.scoped(collect(request(file)).pipe(Effect.provide(layer))));
    expect(result.kind).toBe("live");
    expect(counts.credential).toBe(1);
    expect(counts.network).toBe(1);
    expect(counts.prepare).toBe(1);
    expect(file.models["openai/gpt"]?.contextWindowTokens).toBeUndefined();
  });

  test("existing TURN rejects a different selectionRevision before prepare", async () => {
    const wide = models({ "agent-a": "openai/gpt" }, { contextWindowTokens: 200000 });
    const narrow = models({ "agent-a": "openai/gpt" }, { contextWindowTokens: 32000 });
    const counts = createCountedSeams();
    const layer = graph({ file: () => wide, counts });
    const firstReq = request(wide);
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const first = yield* collect(firstReq);
      if (first.kind !== "live") throw new Error("expected live");
      const original = yield* collect({ ...request(wide, { stepId: "step-2" }), bindingId: first.bindingId });
      const changed = yield* Effect.result(collect({
        ...request(narrow, { stepId: "step-3" }),
        bindingId: first.bindingId,
      }));
      return { first, original, changed };
    }).pipe(Effect.provide(layer))));
    expect(result.original.kind).toBe("live");
    expect(result.changed._tag).toBe("Failure");
    expect(result.changed._tag === "Failure" ? result.changed.failure : undefined).toMatchObject({ code: "selection_mismatch" });
    expect(counts.credential).toBe(1);
    expect(counts.network).toBe(2);
    expect(counts.prepare).toBe(2);
  });

  test("assigned model missing from modeld catalog fails as not_admitted, not a die", async () => {
    const file = parseModelsFile({
      version: 3,
      models: {},
      assignments: { main: null, agents: { "agent-a": { modelId: "sub2api-xai/grok-4.6" } } },
    });
    const counts = createCountedSeams();
    const layer = graph({ file: () => file, counts });
    const req: RunStepRequest = {
      hostEpoch: HOST,
      serviceEpoch: { incarnationId: "svc-1" },
      agentId: "agent-a",
      turnId: "turn-1",
      stepId: "step-1",
      selection: {
        agentId: "agent-a",
        modelId: "sub2api-xai/grok-4.6",
        selectionRevision: "a".repeat(64),
      },
      snapshot: snapshot(),
    };
    const exit = await Effect.runPromise(Effect.exit(
      Effect.scoped(runStep(req)).pipe(Effect.provide(layer)) as Effect.Effect<unknown>,
    ));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected failure");
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(Cause.squash(exit.cause)).toMatchObject({ name: "BindingFailure", code: "not_admitted" });
    expect(counts.credential).toBe(0);
    expect(counts.network).toBe(0);
    expect(counts.prepare).toBe(0);
  });
});
