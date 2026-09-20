import { describe, expect, test } from "bun:test";
import { applyUse, applyReset, assertRouteAssignment, captureManagedSelection, computeSelectionRevision,
  modelForAgent, parseModelsFile, persistModelsDocument, resolveExternalCatalog, parseResolvedModelSelection,
  parseReasoningCapability, parseRequestedEffort, assignedModelTokens, assignedReasoningEfforts } from "@grokbox/runtime-kernel/selection";
import { composeAgentTitle, parseAgentTitle } from "@grokbox/runtime-kernel/contract";
const id = "channel/grok-4.6";
function base() {
  return parseModelsFile({ version: 2, models: { [id]: { provider: "openai-responses", model: "grok-4.6",
    endpoint: "https://reasoning.invalid/v1", apiKeyRef: "env:FIXTURE_KEY", contextWindowTokens: 200000,
    capabilities: { reasoning: { efforts: ["xhigh", "high", "low", "medium"] } } } },
    assignments: { main: null, agents: { a: { modelId: id }, b: { modelId: id } } } });
}
describe("structured model reasoning selection", () => {
  test("legacy read normalizes without inventing policy and writes schema v3", () => {
    const raw = { version: 1, models: {}, assignments: { main: "stub/echo", agents: { a: "stub/echo" } } };
    const before = JSON.stringify(raw), file = parseModelsFile(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(file.version).toBe(3);
    expect(file.assignments).toEqual({ main: { modelId: "stub/echo" }, agents: { a: { modelId: "stub/echo" } } });
    expect(persistModelsDocument(file).version).toBe(3);
    expect(parseModelsFile(persistModelsDocument(file))).toEqual(file);
    expect(() => parseModelsFile({ ...raw, version: 2 })).toThrow();
    expect(() => parseModelsFile({ ...raw, version: 3 })).toThrow();
  });
  test("same channel has per-Bot settings without derived records or credential copies", () => {
    const original = base(), beforeB = captureManagedSelection(original, "b");
    const high = applyUse(original, id, "a", { effort: "high" });
    const xhigh = applyUse(high, id, "a", { effort: "xhigh" });
    expect(Object.keys(xhigh.models)).toEqual([id]);
    expect(xhigh.models).toEqual(original.models);
    expect(xhigh.assignments.agents.a).toEqual({ modelId: id, reasoning: { effort: "xhigh" } });
    expect(captureManagedSelection(xhigh, "b")).toEqual(beforeB);
    expect(captureManagedSelection(high, "a")).not.toEqual(captureManagedSelection(xhigh, "a"));
    expect(modelForAgent(xhigh, "a")).toMatchObject({ id, model: "grok-4.6", endpoint: original.models[id]!.endpoint, apiKeyRef: "env:FIXTURE_KEY" });
    expect(assignedModelTokens(xhigh).get("a")).toBe("grok-4.6");
    expect(assignedReasoningEfforts(xhigh).get("a")).toBe("xhigh");
    expect(xhigh.models[id]).not.toHaveProperty("reasoning");
  });
  test("omission/default clears policy, none is explicit, reset selects official", () => {
    const high = applyUse(base(), id, "a", { effort: "high" });
    for (const effort of [undefined, "default"]) {
      const file = applyUse(high, id, "a", parseRequestedEffort(effort));
      expect(file.assignments.agents.a).toEqual({ modelId: id });
      expect(modelForAgent(file, "a")).not.toHaveProperty("reasoning");
    }
    expect(parseRequestedEffort("none")).toEqual({ effort: "none" });
    expect(() => applyUse(high, id, "a", { effort: "none" })).toThrow();
    const reset = applyReset(high, "a");
    expect(captureManagedSelection(reset, "a")).toEqual({ kind: "official" });
    expect(reset.assignments.agents.b).toEqual(high.assignments.agents.b);
  });
  test("unqualified or unsupported capabilities fail closed", () => {
    for (const capability of [undefined, false, { efforts: ["low"] }]) {
      const file = base(); file.models[id]!.capabilities.reasoning = capability as never;
      expect(() => applyUse(file, id, "a", { effort: "xhigh" })).toThrow();
      expect(applyUse(file, id, "a").assignments.agents.a).toEqual({ modelId: id });
    }
    expect(() => applyUse(base(), "stub/echo", "a", { effort: "high" })).toThrow();
    const file = base(); file.models[id]!.provider = "anthropic";
    expect(() => applyUse(file, id, "a", { effort: "high" })).toThrow();
    const malformed = base(); malformed.assignments.agents.a!.reasoning = { effort: "xhigh" };
    delete malformed.models[id]!.capabilities.reasoning;
    expect(() => assertRouteAssignment(malformed)).toThrow();
  });
  test("unknown and malformed fields cannot be silently discarded", () => {
    for (const policy of [{ effort: "default" }, { effort: "XHIGH" }, { effort: "high", budget: 100 }, {}, true, null, "high"]) {
      const file = base();
      expect(() => parseModelsFile({ ...file, assignments: { main: null, agents: { a: { modelId: id, reasoning: policy } } } })).toThrow();
    }
    for (const capability of [true, {}, { efforts: [] }, { efforts: ["high", "high"] }, { efforts: ["unknown"] }, { efforts: ["high"], extra: true }]) {
      expect(() => parseReasoningCapability(capability)).toThrow();
    }
    expect(() => parseRequestedEffort("xhigh ")).toThrow();
    expect(() => parseModelsFile({ ...base(), settings: {} })).toThrow();
    const file = base();
    expect(() => parseModelsFile({ ...file, models: { [id]: { ...file.models[id], thinking: "xhigh" } } })).toThrow();
    expect(() => parseModelsFile({ ...file, assignments: { main: null, agents: { a: { modelId: id, typo: true } } } })).toThrow();
  });
  test("captured settings are detached, frozen, hashed and cold-restorable", () => {
    const file = applyUse(base(), id, "a", { effort: "high" });
    const selected = modelForAgent(file, "a")!, revision = computeSelectionRevision({ agentId: "a", model: selected });
    file.assignments.agents.a!.reasoning!.effort = "xhigh"; file.models[id]!.endpoint = "https://changed.invalid/v1";
    expect(selected.reasoning?.effort).toBe("high"); expect(selected.endpoint).toBe("https://reasoning.invalid/v1");
    expect(Object.isFrozen(selected)).toBe(true); expect(Object.isFrozen(selected.reasoning)).toBe(true);
    expect(Object.isFrozen(selected.capabilities.reasoning)).toBe(true);
    const restored = parseResolvedModelSelection(JSON.parse(JSON.stringify(selected)));
    expect(computeSelectionRevision({ agentId: "a", model: restored })).toBe(revision);
    expect(() => parseResolvedModelSelection({ ...selected, reasoning: { effort: "invalid" } })).toThrow();
    expect(computeSelectionRevision({ agentId: "a", model: { ...selected, reasoning: { effort: "xhigh" } } })).not.toBe(revision);
    const reordered = base(); reordered.models[id]!.capabilities.reasoning = { efforts: ["medium", "low", "high", "xhigh"] };
    expect(captureManagedSelection(parseModelsFile(reordered), "a")).toEqual(captureManagedSelection(base(), "a"));
  });
  test("Pi requires an explicit identity effort map and never persists imported model or secret", () => {
    const native = parseModelsFile({ version: 2, models: {}, externalCatalog: ["pi"], assignments: { main: null, agents: {} } });
    for (const row of [{ id: "test", reasoning: true }, { id: "test", thinkingLevelMap: { xhigh: "high", high: 4096 } },
      { id: "test", reasoning: false }, { id: "test", thinkingLevelMap: { high: "high", xhigh: "xhigh", off: "none" } }]) {
      const file = resolveExternalCatalog(native, { pi: { providers: { fixture: { api: "openai-responses", baseUrl: "https://pi.invalid/v1", apiKey: "synthetic-only", models: [row] } } } });
      const capability = file.models["fixture/test"]!.capabilities.reasoning;
      if (row.reasoning === false) expect(capability).toBe(false);
      else if (row.thinkingLevelMap?.xhigh === "xhigh") {
        expect(capability).toEqual({ efforts: ["none", "high", "xhigh"] });
        const saved = persistModelsDocument(applyUse(file, "fixture/test", "a", { effort: "xhigh" }));
        expect(saved.models).toEqual({}); expect(JSON.stringify(saved)).not.toContain("synthetic-only");
        expect(saved.assignments.agents.a!.modelId).toBe("fixture/test");
      } else expect(capability).toBeUndefined();
    }
  });
  test("title effort remains separate from model and clears without damaging user text", () => {
    const painted = composeAgentTitle("My Bot | owner=box,m=grok-4.6,tag=keep", { type: "sync", owner: "box", m: "grok-4.6", e: "xhigh" }).title;
    expect(painted).toBe("My Bot | owner=box,m=grok-4.6,e=xhigh,tag=keep");
    expect(parseAgentTitle(painted).fields.e).toBe("xhigh");
    expect(composeAgentTitle(painted, { type: "sync", owner: "box" }).title).toBe(painted);
    expect(composeAgentTitle(painted, { type: "sync", owner: "box", m: "grok-4.6", e: null }).title).toBe("My Bot | owner=box,m=grok-4.6,tag=keep");
    expect(composeAgentTitle(painted, { type: "sync", owner: "temporal" }).title).toBe("My Bot | owner=temporal,tag=keep");
    expect(composeAgentTitle(painted, { type: "hide" }).title).toBe("My Bot");
  });
});
