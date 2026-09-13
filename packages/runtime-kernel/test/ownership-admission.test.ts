import { expect, test } from "bun:test";
import { Clock, Effect, Layer, Stream } from "effect";
import { AdmissionAuthority, ModelBackend, type PreparedCall } from "@grokbox/runtime-kernel/ports";
import { BackendFailure, decideManagedOwnership, contextSnapshotBody, type InferenceEvent, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer, runStep } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeHostCompactLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";

function observed(overrides: Record<string, unknown> = {}) {
  const local = { harness: "box", serverId: "s1" };
  const at = new Date(10000).toISOString();
  return { schemaVersion: 3, source: "Host.official-client/ListGrokBotAgents", state: "observed",
    observedAt: at, completedAt: at, serverObservedAt: at, scope: { id: "a".repeat(64), stable: true },
    localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } },
    localExecution: { before: { allowed: true, bound: true }, after: { allowed: true, bound: true } },
    agents: [{ agentId: "agent", serverEvidence: "found", server: { agentId: "agent", serverId: "s1", harness: "box", viewerIsOwner: true },
      local: { before: local, after: local, stable: true } }], ...overrides };
}

test("shared decision requires scoped, current, stable evidence; v1 inspection is not admission", () => {
  expect(decideManagedOwnership({ agentId: "agent", snapshot: observed(), nowMs: 10000 }).ok).toBe(true);
  for (const change of [
    { schemaVersion: 1, scope: undefined }, { scope: { id: "a".repeat(64), stable: false } },
    { serverObservedAt: new Date(1).toISOString() }, { completedAt: new Date(20000).toISOString() },
    { state: "unavailable" }, { agents: [] },
    { localMigrationWindow: { before: { kind: "active" }, after: { kind: "inactive" } } },
  ]) expect(decideManagedOwnership({ agentId: "agent", snapshot: observed(change), nowMs: 10000 }).ok).toBe(false);
  expect(decideManagedOwnership({ agentId: "agent", snapshot: observed(), nowMs: 16000 }).ok).toBe(false);
});

test("invalid current time cannot make ownership evidence fresh", () => {
  for (const nowMs of [NaN, Infinity, -Infinity, -1]) {
    expect(decideManagedOwnership({ agentId: "agent", snapshot: observed(), nowMs }).ok).toBe(false);
  }
});

test("conflict and temporal cannot be forged into eligibility by top-level status or raw getters", () => {
  const snapshot = observed();
  snapshot.agents[0]!.server.harness = "temporal";
  expect(decideManagedOwnership({ agentId: "agent", snapshot, nowMs: 10000 })).toMatchObject({ ok: false, reason: "harness_mismatch" });
  let reads = 0;
  const unsafe = { get schemaVersion() { reads++; throw Error("PRIVATE_SENTINEL"); } };
  expect(decideManagedOwnership({ agentId: "agent", snapshot: unsafe, nowMs: 10000 }).ok).toBe(false);
  expect(reads).toBe(0);
});

const models = parseModelsFile({ version: 1, assignments: { main: null, agents: { agent: "stub/echo" } } });
const selection = captureManagedSelection(models, "agent");
if (selection.kind !== "managed") throw Error("owned-selection");
const body = contextSnapshotBody({ version: 1, profileId: "t21-state-root", abiIdentity: "host-abi-v1",
  systemMessages: [{ role: "system", content: "owned root" }], messages: [{ role: "user", content: "owned" }], tools: [], options: {} });
const request: RunStepRequest = {
  hostEpoch: { compile: "fixture", source: "fixture", profile: "fixture", hostIdentity: "fixture", bridgeDigest: "fixture", wireVersion: "v4" },
  serviceEpoch: { incarnationId: "svc-1" }, agentId: "agent", turnId: "turn", stepId: "step",
  selection: { agentId: "agent", modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) },
};
const events: InferenceEvent[] = [{ type: "text_delta", text: "owned" }, { type: "backend_finish", finishReason: "stop" }];
const collect = (req = request) => Effect.gen(function* () {
  const admitted = yield* runStep(req);
  if (!("stream" in admitted)) return { bindingId: admitted.bindingId, events: [] };
  return { bindingId: admitted.bindingId, events: [...yield* Stream.runCollect(admitted.stream)] };
});

for (const condition of ["missing", "denied", "expired", "scope-change", "row-change"] as const) {
  test(`production STEP program refuses ${condition} without a provider effect (no CLI precheck)`, async () => {
    const counts = createCountedSeams();
    let afterPin = false;
    const authority = Layer.succeed(AdmissionAuthority, { current: () => Effect.gen(function* () {
      if (condition === "missing") return { admitted: true };
      return { admitted: condition !== "denied", ownership: {
        scopeId: condition === "scope-change" && afterPin ? "b".repeat(64) : "a".repeat(64),
        serverId: condition === "row-change" && afterPin ? "s2" : "s1",
        observedAtMs: condition === "expired" ? 0 : yield* Clock.currentTimeMillis,
      } };
    }) });
    const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(
      Layer.merge(authority), Layer.merge(inferenceMemoryLayer()),
      Layer.merge(fakeBackendAuthLayer("owned", counts, { afterMaterialize: Effect.sync(() => { afterPin = true; }) })),
      Layer.merge(fakeModelBackendLayer(events, counts)),
    );
    await expect(Effect.runPromise(Effect.scoped(collect().pipe(Effect.provide(layer))))).rejects.toMatchObject({ code: "not_admitted" });
    expect(counts.network).toBe(0);
    if (["missing", "denied", "expired"].includes(condition)) expect(counts.credential).toBe(0);
    expect(counts.leasesAlive).toBe(0);
  });
}

for (const revoke of ["ownership", "credential"] as const) {
  test(`recovery preparation cannot slip past the last ${revoke} check into attempt1`, async () => {
    const counts = createCountedSeams();
    const compactCounts = { invocations: 0 };
    let allowed = true, credentialValid = true;
    const authority = Layer.succeed(AdmissionAuthority, { current: () => Effect.map(Clock.currentTimeMillis, observedAtMs => ({
      admitted: allowed, ownership: { scopeId: "a".repeat(64), serverId: "s1", observedAtMs },
    })) });
    const backend = Layer.succeed(ModelBackend, {
      prepare: () => Effect.sync(() => {
        counts.prepare++;
        if (counts.prepare === 2) {
          if (revoke === "ownership") allowed = false;
          else credentialValid = false;
        }
        return Object.freeze({}) as PreparedCall;
      }),
      infer: () => Stream.unwrap(Effect.sync(() => {
        counts.network++;
        return counts.network === 1
          ? Stream.fail(new BackendFailure("overflow_candidate", { overflowCandidate: true,
            overflowEvidence: { providerCode: "context_length_exceeded", httpStatus: 400 } }))
          : Stream.fromArray(events);
      })),
    });
    const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(
      Layer.merge(authority), Layer.merge(inferenceMemoryLayer()), Layer.merge(backend),
      Layer.merge(fakeBackendAuthLayer("owned", counts, { verifyOk: () => credentialValid })),
      Layer.merge(fakeHostCompactLayer({ counts: compactCounts,
        handle: () => ({ kind: "snapshot", snapshot: request.snapshot }) })),
    );
    const result = await Effect.runPromise(Effect.result(Effect.scoped(collect().pipe(Effect.provide(layer)))));
    expect(result._tag).toBe("Failure");
    expect(compactCounts.invocations).toBe(1);
    expect(counts.prepare).toBe(2);
    expect(counts.network).toBe(1);
    expect(counts.leasesAlive).toBe(0);
  });
}

test("a revoked scope cannot revive the same TURN after it changes back", async () => {
  const counts = createCountedSeams();
  let scope = "a".repeat(64);
  const authority = Layer.succeed(AdmissionAuthority, { current: () => Effect.map(Clock.currentTimeMillis, observedAtMs => ({
    admitted: true, ownership: { scopeId: scope, serverId: "s1", observedAtMs },
  })) });
  const layer = fakeConfigurationReadLayer({ models: () => models }).pipe(Layer.merge(authority), Layer.merge(inferenceMemoryLayer()),
    Layer.merge(fakeBackendAuthLayer("owned", counts)), Layer.merge(fakeModelBackendLayer(events, counts)));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* Effect.scoped(collect());
    scope = "b".repeat(64);
    const denied = yield* Effect.result(Effect.scoped(collect({ ...request, stepId: "step-2", bindingId: first.bindingId })));
    expect(denied._tag).toBe("Failure");
    scope = "a".repeat(64);
    const retry = yield* Effect.result(Effect.scoped(collect({ ...request, stepId: "step-3", bindingId: first.bindingId })));
    expect(retry._tag).toBe("Failure");
    expect(counts.network).toBe(1);
    const next = yield* Effect.scoped(collect({ ...request, turnId: "new-turn", stepId: "new-step" }));
    expect(next.events).toHaveLength(2);
    expect(counts.network).toBe(2);
  }).pipe(Effect.provide(layer))));
  expect(counts.leasesAlive).toBe(0);
});
