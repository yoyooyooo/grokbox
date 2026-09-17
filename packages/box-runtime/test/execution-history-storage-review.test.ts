import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer, Stream } from "effect";
import { contextSnapshotBody, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceCapacity, inferenceMemoryLayer, runStep, type LedgerRecord } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";
import { openExecutionHistory } from "../src/internal/io/execution-history.node.ts";

const record: LedgerRecord = { snapshotDigest: "a".repeat(64), selectionRevision: "b".repeat(64), bindingId: "c".repeat(64), status: "terminal" };
const root = () => mkdtemp(join(tmpdir(), "execution-store-review-"));

test("identity publication validates both rows before one durable atomic batch", async () => {
  const dir = await root();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "batch-epoch");
      const turn = { version: 1 as const, turn: { serviceEpoch: "batch-epoch", lifecycle: "open" as const, expired: false, lastActivityMs: 1000 } };
      const malformed = { ...turn, version: 2 } as unknown as typeof turn;
      const refused = yield* Effect.result(store.putIdentity({ stepKey: "step", step: record, turnKey: "turn", turn: malformed }));
      expect(refused._tag).toBe("Failure");
      expect(yield* store.getStep("step")).toBeUndefined();
      expect(yield* store.getTurn("turn")).toBeUndefined();
      yield* store.putIdentity({ stepKey: "step", step: record, turnKey: "turn", turn });
      expect(yield* store.getStep("step")).toEqual(record);
      expect(yield* store.getTurn("turn")).toEqual(turn);
      expect(store.health()).toMatchObject({ available: true, writes: 2 });
    })));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real disk index has exclusive ownership and service incarnation retirement", async () => {
  const dir = await root();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "epoch-one");
      yield* store.putStep("old-id", record);
      const contender = yield* Effect.result(Effect.scoped(openExecutionHistory(dir, "epoch-contender")));
      expect(contender).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
      expect(yield* store.getStep("old-id")).toEqual(record);
    })));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "epoch-two");
      expect(yield* store.getStep("old-id")).toBeUndefined();
      yield* store.putStep("new-id", record);
      expect(yield* store.getStep("new-id")).toEqual(record);
    })));
    const sameEpoch = await Effect.runPromise(Effect.result(Effect.scoped(openExecutionHistory(dir, "epoch-two"))));
    expect(sameEpoch).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real disk history lookup does not require loading a full retained history into JS", async () => {
  const dir = await root();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "many-steps");
      for (let i = 0; i < 12_000; i++) yield* store.putStep(`identity-${i}`, record);
      expect(yield* store.getStep("identity-0")).toEqual(record);
      expect(yield* store.getStep("identity-11999")).toEqual(record);
      expect(yield* store.getStep("unseen")).toBeUndefined();
      expect(store.health()).toMatchObject({ kind: "leveldb", available: true, writes: 12_000 });
    })));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

test("the real kernel completes 2048 STEPs backed by disk without accepting an old identity again", async () => {
  const dir = await root(), counts = createCountedSeams();
  const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { review: STUB_ECHO_MODEL_ID } } });
  const selection = captureManagedSelection(models, "review");
  if (selection.kind !== "managed") throw new Error("invalid fixture");
  const body = contextSnapshotBody({ version: 1, profileId: "review", abiIdentity: "review", systemMessages: [], messages: [{ role: "user", content: "local" }], tools: [], options: {} });
  const request = (i: number): RunStepRequest => ({ hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
    serviceEpoch: { incarnationId: "kernel-disk" }, agentId: "review", turnId: `turn-${i}`, stepId: `step-${i}`,
    selection: { agentId: "review", modelId: selection.modelId, selectionRevision: selection.selectionRevision },
    snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } });
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "kernel-disk");
      const layer = fakeBackendAuthLayer("synthetic-key", counts).pipe(
        Layer.merge(fakeModelBackendLayer([{ type: "text_delta", text: "ok" }, { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } }], counts)),
        Layer.merge(fakeConfigurationReadLayer({ models: () => models })),
        Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
        Layer.merge(inferenceMemoryLayer({ serviceEpoch: "kernel-disk", hotTurnsTarget: 2, history: store })),
      );
      yield* Effect.gen(function* () {
        for (let i = 0; i < 2048; i++) yield* Effect.scoped(Effect.gen(function* () {
          const step = yield* runStep(request(i));
          if (step.kind !== "live") throw new Error("a fresh identity was rejected");
          yield* Stream.runDrain(step.stream);
        }));
        const duplicate = yield* Effect.scoped(runStep(request(0)));
        expect(duplicate.kind).toBe("duplicate");
        // hotTurnsTarget is an asynchronous pressure target, not an admission
        // quota. Observe the service-owned cooler settle; do not force cooling
        // from the test or require the last STEP to await unrelated storage IO.
        const capacity = yield* Effect.gen(function* () {
          for (;;) {
            const observed = yield* inferenceCapacity;
            expect(observed).toMatchObject({ lifetimeStepLimit: null, accepting: true, activeSteps: 0, hotStepRecords: 0 });
            if (observed.hotTurns <= 2 && observed.pinnedTurns <= 2 && observed.pendingScopeReleases === 0) return observed;
            yield* Effect.sleep("10 millis");
          }
        }).pipe(Effect.timeout("5 seconds"));
        expect(capacity.hotTurns).toBeLessThanOrEqual(2);
        expect(capacity.pinnedTurns).toBeLessThanOrEqual(2);
        expect(capacity.pendingScopeReleases).toBe(0);
        expect(counts.network).toBe(2048);
        const stale = yield* Effect.result(Effect.scoped(runStep({ ...request(3000), serviceEpoch: { incarnationId: "retired-epoch" } })));
        expect(stale).toMatchObject({ _tag: "Failure", failure: { code: "service_epoch_mismatch" } });
      }).pipe(Effect.provide(layer));
    })));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);

test("a successful read cannot hide a failed durable write", async () => {
  const dir = await root();
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* openExecutionHistory(dir, "write-health");
      const rejected = yield* Effect.result(store.putStep("invalid-record", { ...record, status: "invalid" as never }));
      expect(rejected._tag).toBe("Failure");
      expect(store.health().available).toBe(false);
      expect(yield* store.getStep("missing")).toBeUndefined();
      expect(store.health().available).toBe(false);
      yield* store.putStep("valid-record", record);
      expect(store.health().available).toBe(true);
    })));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("execution history refuses a symlinked root instead of writing through it", async () => {
  const dir = await root(), other = await root();
  try {
    const link = join(dir, "redirect");
    await symlink(other, link);
    const result = await Effect.runPromise(Effect.result(Effect.scoped(openExecutionHistory(link, "redirected"))));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
  } finally { await Promise.all([rm(dir, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]); }
});
