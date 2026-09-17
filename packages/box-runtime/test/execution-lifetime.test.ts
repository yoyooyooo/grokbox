import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Clock, Deferred, Effect, Fiber, Latch, Layer, Stream, SynchronizedRef } from "effect";
import { BindingFailure, contextSnapshotBody, type HostEpoch, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { runStep, cancelStep, inferenceMemoryLayer, inferenceCapacity, InferenceMemory, coolInactiveTurns, memoryExecutionHistory,
  type ExecutionHistory, type RunStepRequest } from "@grokbox/runtime-kernel/inference";
import { STUB_ECHO_MODEL_ID, captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeBackendAuthLayer, fakeAdmissionAuthorityLayer, fakeModelBackendLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { openExecutionHistory } from "../src/internal/io/execution-history.node.ts";

const HOST: HostEpoch = { compile: "fixture-compile", source: "fixture-source", profile: "fixture-profile", hostIdentity: "fixture-host", bridgeDigest: "fixture-bridge", wireVersion: "v4" };
const EVENTS: InferenceEvent[] = [{ type: "text_delta", text: "done" }, { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }];
const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`agent-${i}`, STUB_ECHO_MODEL_ID])) } });
function request(stepId: string, turnId = "turn-0", agentId = "agent-0", epoch = "fixture-epoch", text = "PAYLOAD_MUST_NOT_ENTER_HISTORY"): RunStepRequest {
  const selected = captureManagedSelection(models, agentId);
  if (selected.kind !== "managed") throw new Error("fixture selection");
  const body = contextSnapshotBody({ version: 1, profileId: "fixture-root", abiIdentity: "fixture-abi",
    systemMessages: [{ role: "system", content: "PRIVATE_ROOT_SENTINEL" }], messages: [{ role: "user", content: text }], tools: [], options: {} });
  return { hostEpoch: HOST, serviceEpoch: { incarnationId: epoch }, agentId, turnId, stepId,
    selection: { agentId, modelId: selected.modelId, selectionRevision: selected.selectionRevision },
    snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
}
function graph(history: ExecutionHistory, counts: ReturnType<typeof createCountedSeams>, epoch = "fixture-epoch", cache = 3) {
  return fakeBackendAuthLayer("SYNTHETIC_SECRET_NEVER_ARCHIVED", counts).pipe(
    Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
    Layer.merge(fakeConfigurationReadLayer({ models: () => models })),
    Layer.merge(fakeModelBackendLayer(EVENTS, counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch, history, hotTurnsTarget: cache })),
  );
}
function collect(req: RunStepRequest) {
  return Effect.scoped(Effect.gen(function* () {
    const result = yield* runStep(req);
    if (!("stream" in result)) return result;
    yield* Stream.runDrain(result.stream);
    return { kind: "live" as const, bindingId: result.bindingId };
  }));
}
const run = <A>(effect: Effect.Effect<A, unknown, unknown>) => Effect.runPromise(effect as Effect.Effect<A, unknown>);
async function diskRun<A>(body: (history: ExecutionHistory, counts: ReturnType<typeof createCountedSeams>) => Effect.Effect<A, unknown, unknown>, cache = 3) {
  const root = await mkdtemp(join(tmpdir(), "execution-history-proof-"));
  const counts = createCountedSeams();
  try {
    return await run(Effect.scoped(Effect.gen(function* () {
      const history = yield* openExecutionHistory(root, "fixture-epoch");
      return yield* body(history, counts).pipe(Effect.provide(graph(history, counts, "fixture-epoch", cache)));
    })));
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("continuous modeld execution with exact disk deduplication", () => {
  test("12000 STEPs in one TURN: no lifetime cap, constant hot ledger, old IDs remain absorbed", async () => {
    await diskRun((_history, counts) => Effect.gen(function* () {
      let bindingId: string | undefined;
      for (let i = 0; i < 12_000; i++) {
        const result = yield* collect({ ...request(`step-${i}`), ...(bindingId ? { bindingId } : {}) });
        if (result.kind !== "live") throw new Error("new STEP was not live");
        bindingId = result.bindingId;
        if (i % 1000 === 0) {
          const snapshot = yield* inferenceCapacity;
          expect(snapshot.activeSteps).toBe(0); expect(snapshot.hotStepRecords).toBe(0);
          expect(snapshot.lifetimeStepLimit).toBeNull(); expect(snapshot.accepting).toBe(true);
        }
      }
      expect((yield* collect(request("step-0"))).kind).toBe("duplicate");
      const changed = yield* Effect.result(collect(request("step-0", "turn-0", "agent-0", "fixture-epoch", "different")));
      expect(changed).toMatchObject({ _tag: "Failure", failure: { code: "step_conflict" } });
      const snapshot = yield* inferenceCapacity;
      expect(snapshot.counters.accepted).toBe(12000); expect(snapshot.hotStepRecords).toBe(0);
      expect(counts.network).toBe(12000); expect(counts.leasesAlive).toBe(1);
    }));
  }, 180_000);

  test("4096 TURNs across 8 Bots cool automatically without retiring old execution identities", async () => {
    await diskRun((history, counts) => Effect.gen(function* () {
      let firstBinding = "";
      for (let i = 0; i < 4096; i++) {
        const result = yield* collect(request("step-1", `turn-${i}`, `agent-${i % 8}`));
        if (result.kind !== "live") throw new Error("new TURN did not run");
        if (i === 0) firstBinding = result.bindingId;
      }
      // Foreground settlement signals the service-owned maintenance worker;
      // it no longer waits for an unrelated cold write. Require bounded real
      // convergence, not eager foreground eviction or a relaxed cache target.
      const snapshot = yield* Effect.gen(function* () {
        for (;;) {
          const current = yield* inferenceCapacity;
          if (current.hotTurns <= 3 && current.pinnedTurns <= 3 && current.pendingScopeReleases === 0) return current;
          yield* Effect.sleep("5 millis");
        }
      }).pipe(Effect.timeout("2 seconds"));
      expect(snapshot.hotTurns).toBeLessThanOrEqual(3); expect(snapshot.pinnedTurns).toBeLessThanOrEqual(3);
      expect(snapshot.hotStepRecords).toBe(0); expect(counts.leasesAlive).toBeLessThanOrEqual(3);
      expect((yield* collect(request("step-1"))).kind).toBe("duplicate");
      const next = yield* collect({ ...request("step-2"), bindingId: firstBinding });
      expect(next).toEqual({ kind: "live", bindingId: firstBinding });
      expect((yield* inferenceCapacity).counters.coldRestores).toBeGreaterThan(0);
      // The execution store is metadata-only, not a second transcript.
      const archived = yield* history.getTurn(canonicalJson({ host: canonicalJson(HOST), agentId: "agent-0", turnId: "turn-0" }));
      expect(archived?.binding).toBeDefined();
      const encoded = JSON.stringify(archived);
      expect(encoded).not.toContain("PRIVATE_ROOT_SENTINEL");
      expect(encoded).not.toContain("PAYLOAD_MUST_NOT_ENTER_HISTORY");
      expect(encoded).not.toContain("SYNTHETIC_SECRET_NEVER_ARCHIVED");
      expect(archived?.binding).not.toHaveProperty("lease");
      expect(counts.network).toBe(4097);
    }));
  }, 180_000);

  test("a long tool/approval gap can resume the original binding; missing acknowledgement remains refused", async () => {
    await diskRun((_history, counts) => Effect.gen(function* () {
      const first = yield* collect(request("one"));
      if (first.kind !== "live") throw new Error("fixture");
      const memory = yield* InferenceMemory;
      const now = yield* Clock.currentTimeMillis;
      yield* coolInactiveTurns(memory, now + 7 * 24 * 60 * 60_000);
      expect(counts.leasesAlive).toBe(0);
      const missing = yield* Effect.result(collect(request("without-ack")));
      expect(missing).toMatchObject({ _tag: "Failure", failure: { code: "binding_missing" } });
      const resumed = yield* collect({ ...request("with-ack"), bindingId: first.bindingId });
      expect(resumed).toEqual({ kind: "live", bindingId: first.bindingId });
      expect(counts.network).toBe(2);
    }));
  });

  test("cold reactivation cannot silently accept a changed credential fingerprint", async () => {
    await diskRun((history, counts) => Effect.gen(function* () {
      const first = yield* collect(request("one"));
      if (first.kind !== "live") throw new Error("fixture");
      const memory = yield* InferenceMemory;
      const now = yield* Clock.currentTimeMillis;
      yield* coolInactiveTurns(memory, now, true);
      // A capability reports the rotated secret only on the cold pin.
      const changed = yield* Effect.result(collect({ ...request("two"), bindingId: first.bindingId }).pipe(
        Effect.provide(fakeBackendAuthLayer("ROTATED_SYNTHETIC_SECRET", counts)),
      ));
      expect(changed).toMatchObject({ _tag: "Failure", failure: { code: "auth_mismatch" } });
      expect(counts.network).toBe(1);
      expect(history.health().available).toBe(true);
    }));
  });

  test("claim write failure prevents dispatch, with no memory fallback", async () => {
    const base = memoryExecutionHistory(), counts = createCountedSeams();
    const history: ExecutionHistory = { ...base, putIdentity: () => Effect.fail(new BindingFailure("ledger_unavailable")) };
    const result = await run(Effect.scoped(Effect.result(collect(request("one"))).pipe(Effect.provide(graph(history, counts)))));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
    expect(counts.network).toBe(0); expect(counts.credential).toBe(0);
  });

  test("interruption between persistent claim and acknowledgement has a registered cleanup owner", async () => {
    const base = memoryExecutionHistory(), counts = createCountedSeams();
    const claimed = await Effect.runPromise(Deferred.make<void>());
    const finishWrite = await Effect.runPromise(Latch.make(false));
    let held = false;
    const history: ExecutionHistory = { ...base, putIdentity: input => base.putIdentity(input).pipe(Effect.andThen(Effect.gen(function* () {
      if (!held) { held = true; yield* Deferred.succeed(claimed, undefined); yield* finishWrite.await; }
    }))) };
    await run(Effect.scoped(Effect.gen(function* () {
      const worker = yield* Effect.forkChild(collect(request("one")));
      yield* Deferred.await(claimed);
      const interrupter = yield* Effect.forkChild(Fiber.interrupt(worker));
      yield* finishWrite.open;
      yield* Fiber.join(interrupter);
      const state = yield* inferenceCapacity;
      expect(state.activeSteps).toBe(0); expect(state.hotStepRecords).toBe(0);
      const again = yield* Effect.result(collect(request("one")));
      expect(again._tag === "Failure" || again.success.kind === "duplicate").toBe(true);
      expect(counts.network).toBe(0);
    }).pipe(Effect.provide(graph(history, counts)))));
  });

  test("thousands of unknown cancellation tombstones do not consume hot execution slots", async () => {
    await diskRun((_history, counts) => Effect.gen(function* () {
      for (let i = 0; i < 2048; i++) yield* cancelStep(request(`cancel-${i}`));
      expect((yield* inferenceCapacity).hotStepRecords).toBe(0);
      const refused = yield* Effect.result(collect(request("cancel-0")));
      expect(refused._tag).toBe("Failure");
      expect((yield* collect(request("new"))).kind).toBe("live");
      expect(counts.network).toBe(1);
    }));
  }, 60_000);

  test("exclusive storage ownership fences a second process; a new epoch safely retires old index data", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-generation-"));
    const value = { snapshotDigest: "a".repeat(64), selectionRevision: "b".repeat(64), status: "terminal" as const };
    try {
      await run(Effect.scoped(Effect.gen(function* () {
        const one = yield* openExecutionHistory(root, "epoch-a");
        yield* one.putStep("test", value);
        expect(yield* Effect.result(Effect.scoped(openExecutionHistory(root, "epoch-b")))).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
        expect(yield* one.getStep("test")).toEqual(value);
      })));
      await run(Effect.scoped(Effect.gen(function* () {
        const two = yield* openExecutionHistory(root, "epoch-b");
        expect(yield* two.getStep("test")).toBeUndefined();
        const counts = createCountedSeams();
        const old = yield* Effect.result(collect(request("old", "turn-0", "agent-0", "epoch-a")).pipe(Effect.provide(graph(two, counts, "epoch-b"))));
        expect(old).toMatchObject({ _tag: "Failure", failure: { code: "service_epoch_mismatch" } });
        expect(counts.network).toBe(0);
      })));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
