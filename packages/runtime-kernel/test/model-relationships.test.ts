import { expect, test } from "bun:test";
import {
  applyFollowDefault, applyModelDelete, applyModelRecord, applyReset, applyUse,
  assignedModelTokens, assignedReasoningEfforts, captureManagedSelection, modelForAgent,
  modelReferences, parseModelsFile, parseResolvedModelSelection, persistModelsDocument,
} from "@grokbox/runtime-kernel/selection";

import { applyModelChange, parseModelChangeRequest } from "@grokbox/runtime-kernel/model-management";
import { randomUUID } from "node:crypto";

const first = "channel/first", second = "channel/second";
function record(model: string) {
  return { provider: "openai-responses", model, endpoint: "https://models.invalid/v1",
    apiKeyRef: "env:SYNTHETIC_KEY", capabilities: { tools: true, reasoning: { efforts: ["high", "xhigh"] } },
    dataTypes: ["text", "tools"], alias: model };
}
function fixture() {
  return parseModelsFile({ version: 3, models: { [first]: record("first"), [second]: record("second") },
    assignments: { main: { modelId: first, reasoning: { effort: "high" } }, agents: {} } });
}

test("default is a relationship; explicit equal model and native selections do not follow it", () => {
  const initial = applyUse(applyFollowDefault(fixture(), "follower"), first, "explicit", { effort: "high" });
  const explicit = captureManagedSelection(initial, "explicit");
  const follower = captureManagedSelection(initial, "follower");
  const changed = applyUse(initial, second, undefined, { effort: "xhigh" });
  expect(changed.assignments.agents).toEqual(initial.assignments.agents);
  expect(changed.assignments.agents.follower).toEqual({ kind: "default" });
  expect(captureManagedSelection(changed, "explicit")).toEqual(explicit);
  expect(captureManagedSelection(changed, "follower")).not.toEqual(follower);
  expect(modelForAgent(changed, "follower")).toMatchObject({ id: second, reasoning: { effort: "xhigh" } });
  expect(captureManagedSelection(changed, "native")).toEqual({ kind: "official" });
  expect(assignedModelTokens(changed).get("follower")).toBe("second");
  expect(assignedReasoningEfforts(changed).get("follower")).toBe("xhigh");
  expect(assignedReasoningEfforts(changed).get("explicit")).toBe("high");
  expect(parseModelsFile(persistModelsDocument(changed))).toEqual(changed);
});

test("default followers require a configured default and cannot conceal overrides", () => {
  const empty = parseModelsFile(undefined);
  expect(() => applyFollowDefault(empty, "bot")).toThrow("model_default_missing");
  const file = fixture();
  for (const assignment of [{ kind: "default", modelId: first }, { kind: "default", reasoning: { effort: "high" } }, { kind: "default", extra: true }]) {
    expect(() => parseModelsFile({ ...file, assignments: { ...file.assignments, agents: { bot: assignment } } })).toThrow();
  }
  expect(() => parseModelsFile({ ...file, assignments: { main: null, agents: { bot: { kind: "default" } } } })).toThrow("model_default_missing");
  expect(() => parseModelsFile({ ...file, version: 2, assignments: { ...file.assignments, agents: { bot: { kind: "default" } } } })).toThrow();
});

test("deletion and clearing the default require explicit removal of every current reference", () => {
  const file = applyUse(applyFollowDefault(fixture(), "follower"), first, "explicit");
  expect(modelReferences(file, first)).toEqual({ references: [
    { kind: "default" }, { kind: "bot", agentId: "follower", selection: "default" },
    { kind: "bot", agentId: "explicit", selection: "model" },
  ], total: 3, truncated: false });
  expect(modelReferences(file, first, 1)).toMatchObject({ references: [{ kind: "default" }], total: 3, truncated: true });
  expect(() => applyReset(file)).toThrow("model_default_in_use");
  expect(() => applyModelDelete(file, first)).toThrow("model_in_use");
  const noFollower = applyReset(file, "follower");
  const noDefault = applyReset(noFollower);
  expect(() => applyModelDelete(noDefault, first)).toThrow("model_in_use");
  const noReferences = applyReset(noDefault, "explicit");
  expect(applyModelDelete(noReferences, first).models).not.toHaveProperty(first);
  expect(file.models).toHaveProperty(first);
  expect(captureManagedSelection(noReferences, "follower")).toEqual({ kind: "official" });
});

test("central model edits affect future turns but cannot rewrite a captured turn", () => {
  const file = applyUse(applyFollowDefault(fixture(), "follower"), first, "explicit", { effort: "xhigh" });
  const captured = modelForAgent(file, "follower")!;
  const before = captureManagedSelection(file, "follower");
  const changed = applyModelRecord(file, first, { ...record("first"), endpoint: "https://changed.invalid/v1" });
  expect(modelForAgent(changed, "explicit")?.endpoint).toBe("https://changed.invalid/v1");
  expect(modelForAgent(changed, "follower")?.endpoint).toBe("https://changed.invalid/v1");
  expect(captureManagedSelection(changed, "follower")).not.toEqual(before);
  expect(captured.endpoint).toBe("https://models.invalid/v1");
  expect(Object.isFrozen(captured)).toBe(true);
  expect(parseResolvedModelSelection(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
  expect(() => applyModelRecord(file, first, { ...record("first"), capabilities: { reasoning: false } })).toThrow();
});

test("retired model versions are rejected without modifying inputs or inventing default followers", () => {
  for (const version of [1, 2]) {
    const assignment = version === 1 ? first : { modelId: first };
    const source = { version, models: { [first]: record("first") }, assignments: { main: assignment, agents: { bot: assignment } } };
    const bytes = JSON.stringify(source);
    expect(() => parseModelsFile(source)).toThrow("current version 3");
    expect(JSON.stringify(source)).toBe(bytes);
  }
  const current = applyUse(fixture(), first, "bot");
  expect(current.assignments.agents.bot).toEqual({ modelId: first });
  expect(captureManagedSelection(applyReset(current), "bot").kind).toBe("managed");
});

test("model patches preserve omitted credentials and capabilities without altering captures", () => {
  const initial = applyUse(fixture(), first, "bot", { effort: "high" });
  const captured = modelForAgent(initial, "bot")!;
  const before = JSON.stringify(initial);
  const next = applyModelChange(initial, { kind: "model-patch", modelId: first,
    patch: { model: "next-wire", alias: "next", capabilities: { tools: false }, contextWindowTokens: 32000 } });
  expect(next.models[first]).toMatchObject({ model: "next-wire", alias: "next", apiKeyRef: "env:SYNTHETIC_KEY",
    endpoint: "https://models.invalid/v1", capabilities: { tools: false, reasoning: { efforts: ["high", "xhigh"] } }, contextWindowTokens: 32000 });
  expect(next.assignments).toEqual(initial.assignments);
  expect(captured.model).toBe("first"); expect(Object.isFrozen(captured)).toBe(true);
  expect(JSON.stringify(initial)).toBe(before);
  const cleared = applyModelChange(next, { kind: "model-patch", modelId: first, patch: { alias: null, contextWindowTokens: null } });
  expect(cleared.models[first]?.alias).toBeUndefined(); expect(cleared.models[first]?.contextWindowTokens).toBeUndefined();
  expect(() => applyModelChange(initial, { kind: "model-patch", modelId: first, patch: { capabilities: { reasoning: null } } })).toThrow();
  expect(JSON.stringify(initial)).toBe(before);
});

test("model patch shape, null and identity errors are rejected without a configuration mutation", () => {
  for (const patch of [{}, { id: "other" }, { apiKeyRef: null }, { dataTypes: [1] }, { alias: "BAD_ALIAS" }, { capabilities: { tools: "yes" } }, { capabilities: { reasoning: true } }]) {
    expect(() => parseModelChangeRequest({ requestId: randomUUID(), expectedRevision: "a".repeat(64),
      change: { kind: "model-patch", modelId: first, patch } })).toThrow();
  }
  expect(() => applyModelChange(fixture(), { kind: "model-patch", modelId: "missing", patch: { alias: "alias" } })).toThrow("The model is not configured.");
  expect(() => applyModelChange(fixture(), { kind: "model-delete", modelId: "missing" })).toThrow("The model is not configured.");
});

test("empty configurations have independent mutable ownership", () => {
  const first = parseModelsFile(undefined);
  first.assignments.agents.bot = { modelId: "stub/echo" };
  expect(parseModelsFile(undefined).assignments.agents).toEqual({});
});
