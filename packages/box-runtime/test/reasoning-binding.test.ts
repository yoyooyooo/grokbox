import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Clock, Effect, Layer, Stream } from "effect";
import { WIRE_VERSION, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { InferenceMemory, coolInactiveTurns, inferenceMemoryLayer, runStep } from "@grokbox/runtime-kernel/inference";
import { applyUse, captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { turnKey } from "../../runtime-kernel/src/internal/inference/route-binding.ts";
import { openExecutionHistory } from "../src/internal/io/execution-history.node.ts";
import { testSdkBackendLayer } from "../src/internal/roots/layers.ts";
import { reasoningModel, reasoningResponse, reasoningSnapshot } from "./reasoning-fixture.ts";
test("disk-backed TURN retains effort across edits, cooling, resume and duplicate STEP", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reasoning-binding-")), record = reasoningModel();
  let file = applyUse(parseModelsFile({ version: 2, models: { [record.id]: record }, assignments: { main: null, agents: {} } }), record.id, "a", { effort: "high" });
  const calls: string[] = [], counts = createCountedSeams();
  const fetch = Object.assign(async (_url: unknown, init?: RequestInit) => { calls.push(JSON.parse(String(init?.body)).reasoning.effort); return reasoningResponse("responses"); }, { preconnect: async () => undefined }) as typeof globalThis.fetch;
  const request = (stepId: string, turnId = "turn-one"): RunStepRequest => {
    const selection = captureManagedSelection(file, "a"); if (selection.kind !== "managed") throw Error("fixture selection");
    return { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: `v${WIRE_VERSION}` },
      serviceEpoch: { incarnationId: "reasoning-epoch" }, agentId: "a", turnId, stepId,
      selection: { agentId: "a", modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot: reasoningSnapshot() };
  };
  const collect = (req: RunStepRequest) => Effect.scoped(Effect.gen(function* () {
    const step = yield* runStep(req); if (step.kind !== "live") return step;
    yield* Stream.runDrain(step.stream); return { kind: "live" as const, bindingId: step.bindingId };
  }));
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const history = yield* openExecutionHistory(dir, "reasoning-epoch");
      const layer = testSdkBackendLayer({ fetch, env: { FIXTURE_KEY: "synthetic" } }).pipe(
        Layer.merge(fakeConfigurationReadLayer({ models: () => file })),
        Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
        Layer.merge(inferenceMemoryLayer({ serviceEpoch: "reasoning-epoch", history })),
      );
      yield* Effect.gen(function* () {
        const original = request("step-one"), first = yield* collect(original);
        file = applyUse(file, record.id, "a", { effort: "xhigh" });
        yield* collect({ ...original, stepId: "step-two", bindingId: first.bindingId });
        expect(calls).toEqual(["high", "high"]);
        const memory = yield* InferenceMemory;
        yield* coolInactiveTurns(memory, yield* Clock.currentTimeMillis, true);
        const cold = yield* history.getTurn(turnKey(original));
        expect(cold?.binding?.model.reasoning?.effort).toBe("high");
        expect(cold?.binding).not.toHaveProperty("lease");
        const altered = structuredClone(cold!); altered.binding!.model.reasoning!.effort = "xhigh";
        const invalid = yield* Effect.result(history.putTurn(turnKey(original), altered));
        expect(invalid).toMatchObject({ _tag: "Failure", failure: { code: "ledger_unavailable" } });
        expect((yield* history.getTurn(turnKey(original)))?.binding?.model.reasoning?.effort).toBe("high");
        yield* history.putTurn(turnKey(original), cold!);
        yield* collect({ ...original, stepId: "step-three", bindingId: first.bindingId });
        const next = request("step-next", "turn-two"); yield* collect(next);
        expect(calls).toEqual(["high", "high", "high", "xhigh"]);
        expect((yield* collect(next)).kind).toBe("duplicate"); expect(calls).toHaveLength(4);
        const changedReplay = yield* Effect.result(collect({ ...next, selection: original.selection }));
        expect(changedReplay._tag).toBe("Failure"); expect(calls).toHaveLength(4);
      }).pipe(Effect.provide(layer));
    })));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
