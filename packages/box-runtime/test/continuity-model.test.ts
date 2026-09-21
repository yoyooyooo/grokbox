import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { botWorkflowRequest, continuityId, CurrentStateFailure } from "@grokbox/runtime-kernel/continuity";
import { readModelOperation } from "@grokbox/runtime-kernel/commands";
import { parseModelsFile, applyUse, applyReset } from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore, type RuntimeStore } from "../src/internal/io/configuration.node.ts";
import { modelConfigurationLayer } from "../src/internal/io/model-management.node.ts";
import { publishConfigFile } from "../src/internal/io/config-layout.node.ts";
import { selectLifecycleModel } from "../src/internal/roots/continuity-model.runtime.ts";
import { openContinuityControls } from "../src/internal/roots/continuity-control.runtime.ts";
import { ownedOwnershipReader } from "./ownership-fixture.ts";
const I = "11111111-1111-4111-8111-111111111111", A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S = "c".repeat(64);
async function fixture(native = false) {
  const root = await mkdtemp(join(tmpdir(), "lifecycle-model-domain-")), original = openRuntimeStore(root, {});
  await publishConfigFile(join(root, "state", "installation.json"), { schemaVersion: 1, installationId: I, role: "box", root });
  await original.saveModels(parseModelsFile({ version: 3, models: {}, assignments: { main: null, agents: native ? { [A]: { modelId: "stub/echo" } } : {} } }));
  const controls = openContinuityControls({ durableRoot: root, scopeId: S }); await controls.initialize();
  const workflow = botWorkflowRequest({ version: 1, operationId: randomUUID(), scopeId: S, kind: "spawn", sourceId: null,
    profile: { name: "Owned" }, modelRef: native ? null : "stub/echo", modelRevision: "d".repeat(64), instructions: "", snapshotId: null,
    activate: true, start: false, maxRunMs: 1000, policyRevision: "e".repeat(64),
    management: { installationId: I, principalId: "owner", requestId: randomUUID(), intentDigest: "f".repeat(64) } });
  const state = { writes: 0, losePublication: false, authorized: true, modelValid: true, authorizationCalls: 0 };
  const store: RuntimeStore = { ...original, saveModels: async (...args) => { state.writes++; await original.saveModels(...args); if (state.losePublication) throw Error("original-publication-ack-lost"); } };
  const input = { store, workflow, targetId: A, operationId: continuityId(workflow.operationId, "model"), ownershipRead: ownedOwnershipReader(4242),
    authorize: async () => { state.authorizationCalls++; if (!state.authorized) throw new CurrentStateFailure("policy_changed"); },
    verifyModel: async () => { if (!state.modelValid) throw new CurrentStateFailure("policy_changed"); } };
  const receipt = () => Effect.runPromise(readModelOperation({ installationId: I, principalId: "owner" }, input.operationId).pipe(Effect.provide(modelConfigurationLayer(original))));
  return { root, original, store, controls, state, input, receipt, run: () => selectLifecycleModel(input), close: () => rm(root, { recursive: true, force: true }) };
}

test("the lifecycle stage publishes through the same durable model request and retains its original operation identity", async () => {
  const f = await fixture();
  try {
    const result = await f.run(); expect(result).toMatchObject({ modelId: "stub/echo", operationId: f.input.operationId });
    expect(await f.receipt()).toMatchObject({ state: "succeeded", target: A, command: "bot-selection", currentTurn: "unchanged" });
    expect((await f.original.loadModels()).assignments.agents[A]).toEqual({ modelId: "stub/echo" });
    const current = await f.original.loadModels(); await f.original.saveModels(applyUse(current, "stub/echo", B));
    f.state.authorized = false; f.state.modelValid = false;
    expect(await f.run()).toEqual(result); expect(f.state.writes).toBe(1);
    expect((await f.original.loadModels()).assignments.agents[B]).toEqual({ modelId: "stub/echo" });
  } finally { await f.close(); }
});

test("published-but-unacknowledged models never become a succeeded lifecycle step merely because desired content matches", async () => {
  const f = await fixture();
  try {
    f.state.losePublication = true; await expect(f.run()).rejects.toMatchObject({ code: "commit_unknown" });
    expect((await f.original.loadModels()).assignments.agents[A]).toEqual({ modelId: "stub/echo" });
    expect(await f.receipt()).toMatchObject({ state: "unknown" }); f.state.losePublication = false;
    const bytes = await readFile(join(f.root, "models.json"));
    for (let i = 0; i < 3; i++) await expect(f.run()).rejects.toMatchObject({ code: "commit_unknown" });
    expect(f.state.writes).toBe(1); expect(await readFile(join(f.root, "models.json"))).toEqual(bytes);
    await f.original.saveModels(applyReset(await f.original.loadModels(), A));
    await expect(f.run()).rejects.toMatchObject({ code: "commit_unknown" }); expect(f.state.writes).toBe(1);
  } finally { await f.close(); }
});

test("a completed no-op is consumed and replay cannot restore a selection after a subsequent user edit", async () => {
  const f = await fixture(true);
  try {
    const result = await f.run(); expect(result.modelId).toBe("official");
    await f.original.saveModels(applyUse(await f.original.loadModels(), "stub/echo", A));
    expect(await f.run()).toEqual(result);
    expect((await f.original.loadModels()).assignments.agents[A]).toEqual({ modelId: "stub/echo" }); expect(f.state.writes).toBe(1);
  } finally { await f.close(); }
});

test("a reserved stage cannot refresh its approval after a concurrent model edit", async () => {
  const f = await fixture();
  try {
    const authorize = f.input.authorize; let calls = 0;
    f.input.authorize = async () => { await authorize(); if (++calls === 2) { f.state.authorized = false; throw new CurrentStateFailure("policy_changed"); } };
    await expect(f.run()).rejects.toBeDefined(); expect(f.state.writes).toBe(0);
    const original = await f.controls.read(continuityId(f.input.workflow.operationId, "model-selection")); expect(original).not.toBeNull();
    await f.original.saveModels(applyUse(await f.original.loadModels(), "stub/echo", B));
    f.state.authorized = true; f.input.authorize = authorize;
    await expect(f.run()).rejects.toMatchObject({ code: "revision_conflict" });
    expect(await f.controls.read(continuityId(f.input.workflow.operationId, "model-selection"))).toEqual(original); expect(f.state.writes).toBe(0);
  } finally { await f.close(); }
});

for (const fault of ["installation", "target", "operation", "plan"] as const) test(`the exact original lifecycle model identity rejects ${fault} changes`, async () => {
  const f = await fixture();
  try {
    await f.run();
    if (fault === "installation") await publishConfigFile(join(f.root, "state", "installation.json"), { schemaVersion: 1, installationId: randomUUID(), role: "box", root: f.root });
    if (fault === "target") f.input.targetId = B;
    if (fault === "operation") f.input.operationId = randomUUID();
    if (fault === "plan") f.input.workflow.modelRevision = "a".repeat(64);
    await expect(f.run()).rejects.toMatchObject({ code: "policy_changed" }); expect(f.state.writes).toBe(1);
  } finally { await f.close(); }
});

test("former selection-only declarations remain intact and cannot acquire a new model request", async () => {
  const f = await fixture();
  try {
    const id = continuityId(f.input.workflow.operationId, "model-selection");
    await f.controls.reserve(id, A, "model-selection", { beforeHash: "a".repeat(64), desired: f.input.workflow.modelRevision });
    const before = await f.controls.read(id);
    await expect(f.run()).rejects.toMatchObject({ code: "policy_changed" });
    expect(await f.controls.read(id)).toEqual(before); expect(f.state.writes).toBe(0); expect(await f.receipt()).toBeUndefined();
  } finally { await f.close(); }
});
