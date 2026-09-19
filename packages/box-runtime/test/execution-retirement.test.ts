import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { contextSnapshotBody, type RunStepRequest } from "@grokbox/runtime-kernel/contract";
import { canonicalJson, computeSnapshotDigest, sha256Text } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer, runStep, type LedgerRecord } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { createCountedSeams, fakeAdmissionAuthorityLayer, fakeBackendAuthLayer, fakeConfigurationReadLayer, fakeModelBackendLayer } from "@grokbox/runtime-kernel/testing";
import { ledgerKey, turnKey } from "../../runtime-kernel/src/internal/inference/route-binding.ts";
import { openExecutionHistory } from "../src/internal/io/execution-history.node.ts";

const terminal: LedgerRecord = { snapshotDigest: "a".repeat(64), selectionRevision: "b".repeat(64), status: "terminal" };
const turn = (epoch: string, lifecycle: "open" | "closed" = "open") => ({ version: 1 as const, turn: { serviceEpoch: epoch, lifecycle, expired: false, lastActivityMs: 1 } });
const stepKey = (n: number, name = "closed") => canonicalJson({ host: "host", agentId: "test", turnId: name, stepId: `s-${n}` });
const key = (name = "closed") => canonicalJson({ host: "host", agentId: "test", turnId: name });
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "execution-retirement-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("closed TURN certificate retires exact children in bounded batches without forgetting its denial", () => fixture(async root => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "retirement");
    for (let n = 0; n < 350; n++) yield* history.putIdentity({ stepKey: stepKey(n), step: terminal, turnKey: key(), turn: turn("retirement") });
    yield* history.putTurn(key(), turn("retirement", "closed"));
    let total = 0;
    for (let n = 0; n < 4; n++) { const receipt = yield* history.maintain!(); total += receipt.retiredSteps;
      expect(receipt.retiredSteps).toBeLessThanOrEqual(128); expect(receipt.ttlDeletion).toBe(false); }
    expect(total).toBe(350); expect(yield* history.getStep(stepKey(0))).toBeUndefined();
    expect(yield* history.getStep(stepKey(349))).toBeUndefined(); expect(yield* history.getTurn(key())).toEqual(turn("retirement", "closed"));
    expect(yield* Effect.result(history.putIdentity({ stepKey: stepKey(400), step: { ...terminal, status: "active" }, turnKey: key(), turn: turn("retirement") })))
      .toMatchObject({ _tag: "Failure", failure: { code: "cancelled" } });
    yield* history.putStep(stepKey(0), terminal);
    expect(yield* history.getStep(stepKey(0))).toBeUndefined();
  })));
}));

test("active child and open TURN survive maintenance; closing never implies the child settled", () => fixture(async root => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "protected");
    yield* history.putIdentity({ stepKey: stepKey(0), step: { ...terminal, status: "active" }, turnKey: key(), turn: turn("protected") });
    yield* history.putIdentity({ stepKey: stepKey(1, "open"), step: terminal, turnKey: key("open"), turn: turn("protected") });
    yield* history.putTurn(key(), turn("protected", "closed"));
    for (let n = 0; n < 5; n++) expect(yield* history.maintain!()).toMatchObject({ state: "protected", blockedActiveSteps: 1, retiredSteps: 0 });
    expect(yield* history.getStep(stepKey(0))).toMatchObject({ status: "active" });
    expect(yield* history.getStep(stepKey(1, "open"))).toEqual(terminal);
    yield* history.putStep(stepKey(0), terminal);
    expect(yield* history.maintain!()).toMatchObject({ retiredSteps: 1, closedTurns: 1 });
    expect(yield* history.getStep(stepKey(1, "open"))).toEqual(terminal);
  })));
}));

test("real kernel refuses retired STEP through retained TURN before provider effects, then rejects its old epoch", () => fixture(async root => {
  const counts = createCountedSeams();
  const models = parseModelsFile({ version: 1, models: {}, assignments: { main: null, agents: { test: STUB_ECHO_MODEL_ID } } });
  const selection = captureManagedSelection(models, "test"); if (selection.kind !== "managed") throw Error("fixture_selection");
  const body = contextSnapshotBody({ version: 1, profileId: "fixture", abiIdentity: "fixture", systemMessages: [], messages: [{ role: "user", content: "private fixture" }], tools: [], options: {} });
  const request: RunStepRequest = { hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
    serviceEpoch: { incarnationId: "kernel-retirement" }, agentId: "test", turnId: "old-turn", stepId: "old-step",
    selection: { agentId: "test", modelId: selection.modelId, selectionRevision: selection.selectionRevision }, snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) } };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "kernel-retirement");
    yield* history.putIdentity({ stepKey: ledgerKey(request), step: terminal, turnKey: turnKey(request), turn: turn("kernel-retirement") });
    yield* history.putTurn(turnKey(request), turn("kernel-retirement", "closed")); yield* history.maintain!();
    const layer = fakeBackendAuthLayer("synthetic", counts).pipe(Layer.merge(fakeModelBackendLayer([], counts)),
      Layer.merge(fakeConfigurationReadLayer({ models: () => models })), Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "kernel-retirement", history })));
    expect((yield* Effect.result(Effect.scoped(runStep(request)).pipe(Effect.provide(layer))))._tag).toBe("Failure"); expect(counts.network).toBe(0);
  })));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "new-incarnation");
    const layer = fakeBackendAuthLayer("synthetic", counts).pipe(Layer.merge(fakeModelBackendLayer([], counts)),
      Layer.merge(fakeConfigurationReadLayer({ models: () => models })), Layer.merge(fakeAdmissionAuthorityLayer(() => ({ admitted: true }), counts)),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: "new-incarnation", history })));
    expect(yield* Effect.result(Effect.scoped(runStep(request)).pipe(Effect.provide(layer)))).toMatchObject({ _tag: "Failure", failure: { code: "service_epoch_mismatch" } });
    expect(counts.network).toBe(0);
  })));
}));

test("protected early TURNs do not starve a later closed TURN's reclaimable children", () => fixture(async root => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "fair-retirement");
    const names = Array.from({ length: 20 }, (_, i) => `turn-${i}`).sort((a, b) => sha256Text(key(a)).localeCompare(sha256Text(key(b))));
    for (const name of names) {
      yield* history.putIdentity({ stepKey: stepKey(0, name), step: name === names.at(-1) ? terminal : { ...terminal, status: "active" }, turnKey: key(name), turn: turn("fair-retirement") });
      yield* history.putTurn(key(name), turn("fair-retirement", "closed"));
    }
    let retired = 0;
    for (let n = 0; n < 4; n++) retired += (yield* history.maintain!()).retiredSteps;
    expect(retired).toBe(1);
    expect(yield* history.getStep(stepKey(0, names.at(-1)))).toBeUndefined();
    expect(yield* history.getStep(stepKey(0, names[0]))).toMatchObject({ status: "active" });
  })));
}));

test("a protected child prefix cannot starve terminal children later in the same TURN", () => fixture(async root => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "child-fairness");
    const children = Array.from({ length: 130 }, (_, n) => stepKey(n)).sort((a, b) => sha256Text(a).localeCompare(sha256Text(b)));
    for (const child of children) yield* history.putIdentity({ stepKey: child, step: child === children.at(-1) ? terminal : { ...terminal, status: "active" }, turnKey: key(), turn: turn("child-fairness") });
    yield* history.putTurn(key(), turn("child-fairness", "closed"));
    expect(yield* history.maintain!()).toMatchObject({ retiredSteps: 0, blockedActiveSteps: 128 });
    expect(yield* history.maintain!()).toMatchObject({ retiredSteps: 1, blockedActiveSteps: 1 });
    expect(yield* history.getStep(children.at(-1)!)).toBeUndefined();
    expect(yield* history.getStep(children[0]!)).toMatchObject({ status: "active" });
  })));
}));

test("execution pressure refuses a new claim without erasing an old guard", () => fixture(async root => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const history = yield* openExecutionHistory(root, "capacity"); yield* history.putStep("old", terminal);
    const pressure = join(root, "state/modeld-execution/owned-pressure-fixture");
    yield* Effect.promise(() => writeFile(pressure, Buffer.alloc(66 * 1024 * 1024), { mode: 0o600 }));
    expect(yield* Effect.result(history.putStep("new", terminal))).toMatchObject({ _tag: "Failure", failure: { code: "ledger_storage_pressure" } });
    expect(yield* history.getStep("old")).toEqual(terminal); expect(yield* history.getStep("new")).toBeUndefined();
    expect((yield* Effect.promise(() => readFile(pressure))).length).toBe(66 * 1024 * 1024);
  })));
}));
