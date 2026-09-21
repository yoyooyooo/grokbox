import { expect, test } from "bun:test";
import { Effect, Layer, Stream, SynchronizedRef } from "effect";
import { contextSnapshotBody, type ContextMaintenanceIdentity, type ContextSnapshot, type HostEpoch, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest, sha256Text } from "@grokbox/runtime-kernel/hash";
import { captureContextSelection, inferenceMemoryLayer, InferenceMemory, memoryExecutionHistory, runStep } from "@grokbox/runtime-kernel/inference";
import { turnKey } from "../src/internal/inference/route-binding.ts";
import { captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";

const agentId = "00000000-0000-4000-8000-000000000123";
const hostEpoch: HostEpoch = { compile: "compile", source: "source", profile: "profile", hostIdentity: "host", bridgeDigest: "bridge", wireVersion: "v8" };
function fixture() {
  const models = parseModelsFile({ version: 3, models: { "owned/model": { provider: "openai", model: "owned", endpoint: "https://fixture.invalid/v1",
    apiKeyRef: "env:OWNED_KEY", contextWindowTokens: 500000 } }, assignments: { main: null, agents: { [agentId]: { modelId: "owned/model" } } } });
  const selected = captureManagedSelection(models, agentId);
  if (selected.kind !== "managed") throw Error("fixture selection missing");
  const selection = { agentId, modelId: selected.modelId, selectionRevision: selected.selectionRevision };
  const serviceEpoch = { incarnationId: "service" };
  const identity: ContextMaintenanceIdentity = { operationId: "maintenance", hostEpoch, serviceEpoch, agentId, sessionId: "",
    rootId: "root", rootRevision: "revision", selection, parent: { turnId: "turn", stepId: "first-step" } };
  const body = contextSnapshotBody({ version: 1, profileId: "t21-state-root", abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "Be helpful." }], messages: [{ role: "user", content: "Continue." }], tools: [], options: {} });
  const snapshot: ContextSnapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
  const request: RunStepRequest = { hostEpoch, serviceEpoch, agentId, turnId: "turn", stepId: "first-step", selection, snapshot };
  const history = memoryExecutionHistory(), counts = createCountedSeams();
  const config = { models: () => models, context: { windowTokens: 128000 } };
  const layer = fakeConfigurationReadLayer(config).pipe(
    Layer.merge(fakeAdmissionAuthorityLayer(undefined, counts)),
    Layer.merge(fakeBackendAuthLayer("current-synthetic-key", counts)),
    Layer.merge(fakeModelBackendLayer([{ type: "text_delta", text: "ok" }, { type: "backend_finish", finishReason: "stop" }], counts)),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: "service", history })),
  );
  const next = { ...identity, operationId: "maintenance-next", parent: { turnId: "turn", stepId: "next-step" } };
  const completeMain = Effect.scoped(Effect.gen(function* () {
    const admitted = yield* runStep(request);
    if (admitted.kind === "live") yield* Stream.runDrain(admitted.stream);
    return admitted;
  }));
  return { identity, next, request, counts, config, history, layer, completeMain };
}

test("context credential capture cannot rotate within a TURN; a new TURN can capture a new credential", async () => {
  const f = fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* captureContextSelection(f.identity, { authFingerprint: sha256Text("original-key") });
    expect(first.authFingerprint).toBe(sha256Text("original-key"));
    const changed = yield* Effect.result(captureContextSelection(f.next, { authFingerprint: sha256Text("new-key") }));
    expect(changed).toMatchObject({ _tag: "Failure", failure: { code: "auth_mismatch" } });
    const same = yield* captureContextSelection(f.next, { authFingerprint: sha256Text("original-key") });
    expect(same.authFingerprint).toBe(first.authFingerprint);
    const fresh = yield* captureContextSelection({ ...f.next, parent: { turnId: "new-turn", stepId: "fresh-step" } }, { authFingerprint: sha256Text("new-key") });
    expect(fresh.authFingerprint).toBe(sha256Text("new-key"));
  }).pipe(Effect.provide(f.layer))));
  expect(f.counts.network).toBe(0);
  expect(f.counts.credential).toBe(0);
});

test("first main request refuses a credential changed since successful context preflight, with no provider effect or lease leak", async () => {
  const f = fixture();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* captureContextSelection(f.identity, { authFingerprint: sha256Text("older-synthetic-key") });
    return yield* Effect.result(f.completeMain);
  }).pipe(Effect.provide(f.layer))));
  expect(result).toMatchObject({ _tag: "Failure", failure: { code: "auth_mismatch" } });
  expect(f.counts.network).toBe(0);
  expect(f.counts.leasesAlive).toBe(0);
});

test("late context capture inherits the existing main binding's credential and policy, not a newer global configuration", async () => {
  const f = fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.completeMain;
    f.config.context.windowTokens = 64000;
    const captured = yield* captureContextSelection(f.next, { authFingerprint: sha256Text("current-synthetic-key") });
    expect(captured.authFingerprint).toBe(sha256Text("current-synthetic-key"));
    expect(captured.policy.windowTokens).toBe(128000);
    const rotated = yield* Effect.result(captureContextSelection(f.next, { authFingerprint: sha256Text("rotated-key") }));
    expect(rotated).toMatchObject({ _tag: "Failure", failure: { code: "auth_mismatch" } });
    const oldStep = yield* Effect.result(captureContextSelection(f.identity));
    expect(oldStep).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } });
  }).pipe(Effect.provide(f.layer))));
  expect(f.counts.network).toBe(1);
});

for (const lifecycle of ["closed", "revoked"] as const) test(`cached context selection cannot revive a ${lifecycle} TURN`, async () => {
  const f = fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.completeMain;
    yield* captureContextSelection(f.next);
    const memory = yield* InferenceMemory;
    const key = turnKey(f.request);
    const prior = yield* f.history.getTurn(key);
    if (!prior) throw Error("missing committed TURN");
    yield* f.history.putTurn(key, { ...prior, turn: { ...prior.turn, lifecycle } });
    // Exercise cold restoration with a still-present durable context capture.
    yield* SynchronizedRef.update(memory.ref, state => ({ ...state, bindings: new Map(), turns: new Map() }));
    const rejected = yield* Effect.result(captureContextSelection(f.next));
    expect(rejected).toMatchObject({ _tag: "Failure", failure: { code: "not_admitted" } });
  }).pipe(Effect.provide(f.layer))));
  expect(f.counts.network).toBe(1);
});

test("context authority changing scope revokes the original TURN, even if a later read changes back", async () => {
  const f = fixture();
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* f.completeMain;
    const key = turnKey(f.request);
    const prior = yield* f.history.getTurn(key);
    if (!prior?.binding) throw Error("missing main binding");
    const original = prior.binding.ownership;
    yield* captureContextSelection(f.next, { ownership: original });
    const revoked = yield* Effect.result(captureContextSelection(f.next, { ownership: { ...original, scopeId: "different-scope" } }));
    expect(revoked).toMatchObject({ _tag: "Failure", failure: { code: "not_admitted" } });
    expect((yield* f.history.getTurn(key))?.turn.lifecycle).toBe("revoked");
    const returned = yield* Effect.result(captureContextSelection(f.next, { ownership: original }));
    expect(returned).toMatchObject({ _tag: "Failure", failure: { code: "not_admitted" } });
    const replay = yield* Effect.result(Effect.scoped(runStep({ ...f.request, stepId: "next-step", bindingId: prior.binding.bindingId })));
    expect(replay).toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } });
  }).pipe(Effect.provide(f.layer))));
  expect(f.counts.network).toBe(1);
});
