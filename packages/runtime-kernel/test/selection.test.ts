import { describe, expect, test } from "bun:test";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import {
  STUB_ECHO_MODEL_ID,
  applyUse,
  captureManagedSelection,
  computeSelectionRevision,
  decideRouteSession,
  parseApiKeyRef,
  parseModelId,
  parseModelsFile,
  routeModelAdmitted,
} from "@grokbox/runtime-kernel/selection";

describe("kernel selection", () => {
  test("parses stub/echo and refuses literals", () => {
    const file = parseModelsFile({
      version: 1,
      models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "" } },
      assignments: { main: STUB_ECHO_MODEL_ID, agents: {} },
    });
    expect(file.models[STUB_ECHO_MODEL_ID]?.id).toBe(STUB_ECHO_MODEL_ID);
    expect(routeModelAdmitted(file.models[STUB_ECHO_MODEL_ID]!)).toBe(true);
    expect(parseModelId("acme/fast")).toEqual({ provider: "acme", model: "fast", id: "acme/fast" });
    expect(() => parseApiKeyRef("sk-live")).toThrow(BoxRuntimeError);
  });

  test("selective route does not use main as session fallback", () => {
    const file = applyUse(parseModelsFile({
      version: 1,
      models: {},
      assignments: { main: STUB_ECHO_MODEL_ID, agents: {} },
    }), STUB_ECHO_MODEL_ID, "agent-1");
    expect(decideRouteSession(file).kind).toBe("official");
    expect(decideRouteSession(file, "agent-1")).toEqual({
      kind: "managed",
      modelId: STUB_ECHO_MODEL_ID,
      assignment: "agent",
    });
  });

  test("selectionRevision is order-independent for object keys", () => {
    const model = {
      id: "openai/gpt",
      provider: "openai",
      model: "gpt",
      endpoint: "https://api.example.test/v1",
      apiKeyRef: "env:KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    expect(computeSelectionRevision({ agentId: "a", model })).toMatch(/^[a-f0-9]{64}$/);
    expect(computeSelectionRevision({ agentId: "a", model })).toBe(computeSelectionRevision({ agentId: "a", model }));
    expect(computeSelectionRevision({ agentId: "b", model })).not.toBe(computeSelectionRevision({ agentId: "a", model }));
  });

  test("other bot assignment does not change this selectionRevision; endpoint/ref does", () => {
    const openai = {
      provider: "openai",
      model: "gpt",
      endpoint: "https://api.example.test/v1",
      apiKeyRef: "env:KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const base = parseModelsFile({
      version: 1,
      models: { "openai/gpt": openai },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    });
    const first = captureManagedSelection(base, "agent-a");
    const otherBot = applyUse(base, STUB_ECHO_MODEL_ID, "agent-b");
    const afterOther = captureManagedSelection(otherBot, "agent-a");
    expect(first).toMatchObject({ kind: "managed", modelId: "openai/gpt" });
    expect(afterOther).toEqual(first);
    expect(captureManagedSelection(base, "agent-b").kind).toBe("official");

    const moved = parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, endpoint: "https://other.test/v1" } },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    });
    const afterEndpoint = captureManagedSelection(moved, "agent-a");
    expect(afterEndpoint.kind).toBe("managed");
    if (first.kind === "managed" && afterEndpoint.kind === "managed") {
      expect(afterEndpoint.selectionRevision).not.toBe(first.selectionRevision);
    }
  });
});
