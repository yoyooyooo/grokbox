import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AdmissionAuthority, ModelBackend, RuntimeEvents, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { OWNERSHIP_LOCAL_SOURCE, OWNERSHIP_READ_SOURCE, contextSnapshotBody, projectAuthorityProgress,
  streamFailureDiagnostic, type AuthorityProgress, type InferenceEvent, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { runStep, inferenceMemoryLayer, inferenceCapacity } from "@grokbox/runtime-kernel/inference";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { parseModelsFile, captureManagedSelection, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeBackendAuthLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { makeOwnershipCoordinator } from "../src/internal/io/ownership-coordinator.node.ts";
import type { OwnershipReader } from "../src/internal/io/ownership-admission.node.ts";
import { ownedOwnershipSnapshot } from "./ownership-fixture.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { [A]: STUB_ECHO_MODEL_ID } } });
const selected = captureManagedSelection(models, A);
if (selected.kind !== "managed") throw Error("fixture");
const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [],
  messages: [{ role: "user", content: "synthetic" }], tools: [], options: {} });
const request: RunStepRequest = { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v6" },
  serviceEpoch: { incarnationId: "availability-fixture" }, agentId: A, turnId: "turn", stepId: "step",
  selection: { agentId: A, modelId: selected.modelId, selectionRevision: selected.selectionRevision },
  snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };

/** Production coordinator, classifier, gate and STEP program. Only ownership
 * I/O, deployment admission and model/auth capabilities are substituted. No
 * native/Server consistency, actual tool execution or App claim is made here. */
async function scenario(options: {
  sourceMs: number; firstSourceMs?: number; prepareMs?: number; inferenceMs?: number;
  steps?: number; tools?: number; pauseAfterInference?: boolean; scopeAfterInference?: boolean;
  finalVerifyMs?: number; stripOwner?: boolean;
}) {
  const counts = createCountedSeams(), progress: AuthorityProgress[] = [];
  let sourceCalls = 0, localCalls = 0, physical = 0, checks = 0, allowed = true, scopeId = "a".repeat(64);
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const reader: OwnershipReader = (ids, signal) => Effect.runPromise(Effect.gen(function* () {
      const start = now(), scope = scopeId;
      const ordinal = ++sourceCalls; physical++;
      return yield* Effect.gen(function* () {
        yield* Effect.sleep(`${ordinal === 1 ? options.firstSourceMs ?? options.sourceMs : options.sourceMs} millis`);
        const snapshot = ownedOwnershipSnapshot(ids, { nowMs: start, scopeId: scope, localWorkAllowed: allowed });
        return { gateway: { pid: 77, startedAt: 1 }, snapshot: { ...snapshot, completedAt: new Date(now()).toISOString(),
          readObservation: { version: 1, source: OWNERSHIP_READ_SOURCE, state: "observed", phase: "complete", serverRead: "request",
            durationMs: now() - start, serverEvidenceAgeMs: now() - start } } };
      }).pipe(Effect.ensuring(Effect.sync(() => { physical--; })));
    }).pipe(Effect.provideService(Clock.Clock, clock)), { signal });
    reader.local = async ids => {
      localCalls++;
      const source = ownedOwnershipSnapshot(ids, { nowMs: now(), scopeId, localWorkAllowed: allowed });
      return { gateway: { pid: 77, startedAt: 1 }, snapshot: { schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE, state: "observed",
        observedAt: source.observedAt, completedAt: source.completedAt, scope: source.scope,
        localExecution: source.localExecution, localMigrationWindow: source.localMigrationWindow,
        agents: source.agents.map(row => ({ agentId: row.agentId, local: row.local })) } };
    };
    const coordinator = yield* makeOwnershipCoordinator(reader);
    const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: request.serviceEpoch.incarnationId })),
      Layer.merge(fakeBackendAuthLayer("synthetic", counts, { beforeVerify: Effect.suspend(() =>
        checks === 3 && options.finalVerifyMs ? Effect.sleep(`${options.finalVerifyMs} millis`) : Effect.void) })),
      Layer.merge(Layer.succeed(AdmissionAuthority, { current: (req, control) => {
        checks++;
        return coordinator.current({ agentId: req.agentId, hostGeneration: req.hostEpoch.compile, gatewayPid: 77 },
          options.stripOwner && control ? { ...control, evidenceOwner: undefined } : control).pipe(Effect.map(source => ({
          admitted: true as const, ownership: source.evidence, evidenceId: source.evidenceId,
          diagnostic: { authority: { reason: "unknown" as const, ownershipRead: source.remote.readObservation,
            ownershipWait: source.observation, readRecovery: source.recovery } },
        })));
      } })),
      Layer.merge(Layer.succeed(RuntimeEvents, { append: event => Effect.sync(() => {
        const item = projectAuthorityProgress((event as { authority?: unknown }).authority); if (item) progress.push(item);
      }) })),
      Layer.merge(Layer.succeed(ModelBackend, {
        prepare: () => Effect.gen(function* () { counts.prepare++; yield* Effect.sleep(`${options.prepareMs ?? 0} millis`); return {} as PreparedCall; }),
        infer: () => Stream.unwrap(Effect.gen(function* () {
          counts.network++;
          yield* Effect.sleep(`${options.inferenceMs ?? 0} millis`);
          if (options.pauseAfterInference) allowed = false;
          if (options.scopeAfterInference) scopeId = "b".repeat(64);
          const events: InferenceEvent[] = [{ type: "text_delta", text: "one model result" }];
          for (let n = 0; n < (options.tools ?? 0); n++) {
            events.push({ type: "tool_start", toolCallId: `call-${n}`, toolName: "lookup" },
              { type: "tool_complete", toolCallId: `call-${n}`, toolName: "lookup", args: {} });
          }
          events.push({ type: "backend_finish", finishReason: "stop" });
          return Stream.fromArray(events);
        })),
      })),
    );
    return yield* Effect.gen(function* () {
      const worker = yield* Effect.forkChild(Effect.result(Effect.gen(function* () {
        const delivered: InferenceEvent[][] = [];
        let bindingId: string | undefined;
        for (let n = 0; n < (options.steps ?? 1); n++) {
          const step = yield* Effect.scoped(Effect.gen(function* () {
            const live = yield* runStep({ ...request, stepId: `step-${n}`, ...(bindingId ? { bindingId } : {}) });
            if (live.kind !== "live") throw Error("unexpected duplicate");
            return { bindingId: live.bindingId, events: yield* Stream.runCollect(live.stream) };
          }));
          bindingId = step.bindingId; delivered.push(step.events);
        }
        return delivered;
      })));
      // Advance the shared injected clock in bounded increments, allowing the
      // synthetic Promise I/O boundaries to settle between clock adjustments.
      for (let n = 0; n < 400; n++) {
        if (worker.pollUnsafe() !== undefined) break;
        yield* TestClock.adjust("100 millis");
        yield* Effect.yieldNow;
      }
      return { outcome: yield* Fiber.join(worker), capacity: yield* inferenceCapacity, source: coordinator.snapshot() };
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(TestClock.layer()))));
  expect(counts.leasesAlive).toBe(0); expect(physical).toBe(0);
  expect(result.capacity.activeSteps).toBe(0); expect(result.capacity.authority?.active).toBe(0);
  expect(result.source).toMatchObject({ activeWaiters: 0, activeSources: 0, unsettledSources: 0 });
  return { ...result, counts, progress, sourceCalls, localCalls };
}

for (const sourceMs of [2500, 3000, 4000]) test(`production STEP with ${sourceMs}ms reads and multiple tool checkpoints uses one source`, async () => {
  const result = await scenario({ sourceMs, tools: 3 });
  expect(result.outcome._tag).toBe("Success"); expect(result.counts.network).toBe(1); expect(result.sourceCalls).toBe(1);
  expect(result.localCalls).toBeGreaterThanOrEqual(20);
  expect(result.progress.some(p => p.diagnostic?.ownershipWait?.evidenceUse === "step")).toBe(true);
  expect(result.progress.at(-1)?.checkpoint).toBe("finish");
  expect(result.progress.at(-1)?.cumulativeMs).toBeLessThan(5000);
});

test("persistent moderate latency without STEP reuse reproduces cumulative qualification exhaustion", async () => {
  const result = await scenario({ sourceMs: 3000, tools: 2, stripOwner: true });
  expect(result.outcome._tag).toBe("Failure"); expect(result.sourceCalls).toBeGreaterThanOrEqual(4);
  expect(result.counts.network).toBe(1);
  if (result.outcome._tag === "Failure") expect(streamFailureDiagnostic(result.outcome.failure)?.authority).toMatchObject({
    reason: "ownership_read_timeout", availabilityCause: "wait_budget",
  });
});

test("another STEP in the same TURN receives a new evidence owner, not a five-second shared cache", async () => {
  const result = await scenario({ sourceMs: 3000, steps: 2 });
  expect(result.outcome._tag).toBe("Success"); expect(result.counts.network).toBe(2); expect(result.sourceCalls).toBe(2);
});

test("long inference refreshes at finish without reinference or renewing the cumulative allowance", async () => {
  const result = await scenario({ sourceMs: 3000, inferenceMs: 6000 });
  expect(result.outcome._tag).toBe("Success"); expect(result.counts.network).toBe(1); expect(result.sourceCalls).toBe(2);
  expect(result.progress.at(-1)?.cumulativeMs).toBeGreaterThanOrEqual(6000);
  expect(result.progress.at(-1)?.cumulativeMs).toBeLessThan(10000);
});

test("long preparation refreshes before dispatch and later checkpoints reuse the refreshed source", async () => {
  const result = await scenario({ sourceMs: 3000, prepareMs: 6000, tools: 2 });
  expect(result.outcome._tag).toBe("Success"); expect(result.counts.network).toBe(1); expect(result.sourceCalls).toBe(2);
});

test("a stale first read recovers, then a long inference finishes under the same original allowance", async () => {
  const result = await scenario({ sourceMs: 500, firstSourceMs: 5500, inferenceMs: 6000, tools: 2 });
  expect(result.outcome._tag).toBe("Success"); expect(result.counts.network).toBe(1); expect(result.sourceCalls).toBe(3);
  expect(result.progress.some(p => p.diagnostic?.readRecovery?.firstReadReason === "ownership_evidence_stale")).toBe(true);
  expect(result.progress.at(-1)?.cumulativeMs).toBeLessThan(10000);
});

test("persistently over-age reads still stop before any model effect", async () => {
  const result = await scenario({ sourceMs: 5500 });
  expect(result.outcome._tag).toBe("Failure"); expect(result.counts.network).toBe(0);
  expect(result.sourceCalls).toBeLessThanOrEqual(2);
});

for (const change of ["pauseAfterInference", "scopeAfterInference"] as const) test(`${change} fences a held model result despite reusable remote evidence`, async () => {
  const result = await scenario({ sourceMs: 3000, [change]: true });
  expect(result.outcome._tag).toBe("Failure"); expect(result.counts.network).toBe(1);
  expect(result.progress.at(-1)?.phase).toBe("denied");
});

test("slow final credentials report permit expiry rather than blaming the source read", async () => {
  const result = await scenario({ sourceMs: 100, finalVerifyMs: 6000 });
  expect(result.outcome._tag).toBe("Failure"); expect(result.counts.network).toBe(0);
  if (result.outcome._tag === "Failure") expect(streamFailureDiagnostic(result.outcome.failure)?.authority).toMatchObject({
    reason: "ownership_evidence_stale", availabilityCause: "permit_elapsed",
  });
});
