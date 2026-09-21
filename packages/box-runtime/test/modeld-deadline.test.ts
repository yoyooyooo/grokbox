import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Clock, Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AdmissionAuthority, ModelBackend, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { contextSnapshotBody, WIRE_VERSION, OWNERSHIP_READ_SOURCE, type AdmissionAuthorityResult, type InferenceEvent, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer, memoryExecutionHistory, type ExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeBackendAuthLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import type { ModeldStepOutcome } from "../src/internal/modeld/step-outcome.ts";

const permit = Effect.map(Clock.currentTimeMillis, observedAtMs => ({ admitted: true as const,
  ownership: { scopeId: "a".repeat(64), serverId: "fixture-server", observedAtMs } }));
const finish: InferenceEvent = { type: "backend_finish", finishReason: "stop" };

type Scenario = {
  claimMs?: number;
  prepareMs?: number;
  streamMs?: number;
  advanceMs: number;
  authority?: () => Effect.Effect<AdmissionAuthorityResult>;
};

/** Production server/kernel, real Unix framing, controlled capability delays.
 * All execution time advances through the same injected monotonic clock. The
 * real client timeout detects a stuck test; no live Host/provider is involved. */
async function scenario(input: Scenario) {
  const root = await mkdtemp(join(tmpdir(), "modeld-deadline-")), epoch = randomUUID();
  const counts = createCountedSeams(), resources = emptyResourceCounts();
  const entered = Deferred.makeUnsafe<void>();
  const history = memoryExecutionHistory();
  const store: ExecutionHistory = { ...history, putIdentity: value => Effect.gen(function* () {
    yield* Deferred.succeed(entered, undefined);
    if (input.claimMs) yield* Effect.sleep(`${input.claimMs} millis`);
    yield* history.putIdentity(value);
  }) };
  const models = parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: { fixture: { modelId: STUB_ECHO_MODEL_ID } } } });
  const selection = captureManagedSelection(models, "fixture"); if (selection.kind !== "managed") throw Error("fixture");
  const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [], messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
  const request: RunStepRequest = { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v6" },
    serviceEpoch: { incarnationId: epoch }, agentId: "fixture", turnId: "turn", stepId: "step",
    selection: { agentId: "fixture", modelId: selection.modelId, selectionRevision: selection.selectionRevision },
    snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
  let sourceInterrupted = false, providerReleased = false;
  const outcomes: ModeldStepOutcome[] = [];
  const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: epoch, history: store })),
    Layer.merge(fakeBackendAuthLayer("fixture-secret", counts)),
    Layer.merge(Layer.succeed(AdmissionAuthority, { current: () => (input.authority?.() ?? permit).pipe(
      Effect.onInterrupt(() => Effect.sync(() => { sourceInterrupted = true; }))) })),
    Layer.merge(Layer.succeed(ModelBackend, {
      prepare: () => Effect.gen(function* () {
        counts.prepare++;
        if (input.prepareMs) yield* Effect.sleep(`${input.prepareMs} millis`);
        return Object.freeze({}) as PreparedCall;
      }),
      infer: () => Stream.unwrap(Effect.gen(function* () {
        counts.network++;
        if (input.streamMs) yield* Effect.sleep(`${input.streamMs} millis`);
        return Stream.fromArray([finish]);
      })).pipe(Stream.ensuring(Effect.sync(() => { providerReleased = true; }))),
    })),
  );
  try {
    const frames = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* serveModeld({ path: join(root, "modeld.sock"), generation: epoch, counts: resources,
        observeStep: (_req, outcome) => Effect.sync(() => { outcomes.push(outcome); }) });
      const reader = yield* Effect.forkChild(Effect.tryPromise(() => requestModeld(root,
        { version: WIRE_VERSION, method: "run-step", ...request }, 3000)));
      yield* Deferred.await(entered);
      yield* TestClock.adjust(`${input.advanceMs} millis`);
      return yield* Fiber.join(reader);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))));
    expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
    expect(counts.leasesAlive).toBe(0);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.execution?.activeSteps).toBe(0);
    return { frames, counts, outcome: outcomes[0]!, sourceInterrupted, providerReleased };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("claim delay cannot let the retired 10.5s outer cap mask a returned source failure", async () => {
  const result = await scenario({ claimMs: 2000, advanceMs: 12000, authority: () => Effect.sleep("9900 millis").pipe(
    Effect.as({ admitted: false as const, reason: "server_read_unavailable" as const, diagnostic: { authority: {
      reason: "server_read_unavailable" as const, ownershipRead: { version: 1 as const, source: OWNERSHIP_READ_SOURCE,
        state: "unavailable" as const, errorCode: "server_read_failed" as const, rpcCode: 14, serverWaitMs: 9900 },
    } } })) });
  expect(result.frames.at(-1)).toMatchObject({ ok: false, error: { code: "not_admitted", failure: {
    diagnostic: { authority: { reason: "server_read_unavailable", checkpoint: "admission", ownershipRead: { rpcCode: 14 } } },
  } } });
  expect(result.counts.network).toBe(0);
  expect(result.outcome.durationMs).toBe(11900);
});

test("after a slow claim, the inner cumulative authority timeout retains its own cause", async () => {
  const result = await scenario({ claimMs: 2000, advanceMs: 12001, authority: () => Effect.never });
  expect(result.frames.at(-1)).toMatchObject({ ok: false, error: { code: "not_admitted", failure: {
    diagnostic: { authority: { reason: "ownership_read_timeout", checkpoint: "admission" } },
  } } });
  expect(result.counts.network).toBe(0); expect(result.sourceInterrupted).toBe(true);
  expect(result.outcome.durationMs).toBe(12000);
});

test("prepare may outlast the old admission timer without receiving a new STEP deadline", async () => {
  const result = await scenario({ prepareMs: 12000, advanceMs: 13000 });
  expect(result.frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "ok" });
  expect(result.counts.network).toBe(1); expect(result.providerReleased).toBe(true);
  // Real socket delivery may resume after TestClock reaches its final tick.
  expect(result.outcome.durationMs).toBeGreaterThanOrEqual(12000);
  expect(result.outcome.durationMs).toBeLessThanOrEqual(13000);
});

test("admission and streaming share the ingress deadline; accepted never renews 180 seconds", async () => {
  const result = await scenario({ prepareMs: 100000, streamMs: 100000, advanceMs: 181000 });
  expect(result.frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "error", code: "timeout" });
  expect(result.frames.filter(v => v && typeof v === "object" && "kind" in v && v.kind === "terminal")).toHaveLength(1);
  expect(result.counts.network).toBe(1); expect(result.providerReleased).toBe(true);
  expect(result.outcome.durationMs).toBe(180000);
});

test("a never-ready preparation still stops at the whole STEP deadline before model dispatch", async () => {
  const result = await scenario({ prepareMs: 181000, advanceMs: 180001 });
  expect(result.frames.at(-1)).toMatchObject({ ok: false, error: { code: "timeout" } });
  expect(result.counts.network).toBe(0);
  expect(result.outcome.durationMs).toBe(180000);
});
