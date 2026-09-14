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
  persistModelsDocument,
  piModelsPathCandidates,
  resolveExternalCatalog,
  qualifiedContextWindowTokens,
  modelForAgent,
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

  test("contextWindowTokens is retained, fenced in selectionRevision, and never guessed", () => {
    const openai = {
      provider: "openai",
      model: "gpt",
      endpoint: "https://api.example.test/v1",
      apiKeyRef: "env:KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const withWindow = parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 200000 } },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    });
    expect(withWindow.models["openai/gpt"]?.contextWindowTokens).toBe(200000);
    expect(qualifiedContextWindowTokens(withWindow.models["openai/gpt"]!)).toBe(200000);
    expect(qualifiedContextWindowTokens(withWindow.models["openai/gpt"]!, 128000)).toBe(128000);
    const without = parseModelsFile({
      version: 1,
      models: { "openai/gpt": openai },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    });
    expect(without.models["openai/gpt"]?.contextWindowTokens).toBeUndefined();
    expect(qualifiedContextWindowTokens(without.models["openai/gpt"]!)).toBeUndefined();
    const first = captureManagedSelection(withWindow, "agent-a");
    const same = captureManagedSelection(withWindow, "agent-a");
    const smaller = captureManagedSelection(parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 32000 } },
      assignments: { main: null, agents: { "agent-a": "openai/gpt" } },
    }), "agent-a");
    expect(first).toEqual(same);
    expect(first.kind).toBe("managed");
    expect(smaller.kind).toBe("managed");
    if (first.kind === "managed" && smaller.kind === "managed") {
      expect(smaller.selectionRevision).not.toBe(first.selectionRevision);
    }
    const noWindowRev = captureManagedSelection(without, "agent-a");
    if (first.kind === "managed" && noWindowRev.kind === "managed") {
      expect(noWindowRev.selectionRevision).not.toBe(first.selectionRevision);
    }
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 0 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: -1 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 1.5 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(qualifiedContextWindowTokens(without.models["openai/gpt"]!, "gpt-4")).toBeUndefined();
    const fromAlias = parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindow: 200000 } },
      assignments: { main: null, agents: {} },
    });
    expect(fromAlias.models["openai/gpt"]?.contextWindowTokens).toBe(200000);
    expect("contextWindow" in (fromAlias.models["openai/gpt"] ?? {})).toBe(false);
    const bothAgree = parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 200000, contextWindow: 200000 } },
      assignments: { main: null, agents: {} },
    });
    expect(bothAgree.models["openai/gpt"]?.contextWindowTokens).toBe(200000);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindowTokens: 200000, contextWindow: 32000 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindow: 0 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindow: -1 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => parseModelsFile({
      version: 1,
      models: { "openai/gpt": { ...openai, contextWindow: 1.5 } },
      assignments: { main: null, agents: {} },
    })).toThrow(BoxRuntimeError);
  });

  test("configured stub contextWindowTokens is selected, not discarded for STUB_ECHO_MODEL", () => {
    const withWindow = parseModelsFile({
      version: 1,
      models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "", contextWindowTokens: 200000 } },
      assignments: { main: null, agents: { "agent-a": STUB_ECHO_MODEL_ID } },
    });
    const smaller = parseModelsFile({
      version: 1,
      models: { [STUB_ECHO_MODEL_ID]: { provider: "stub", model: "echo", endpoint: "stub:echo", apiKeyRef: "", contextWindowTokens: 32000 } },
      assignments: { main: null, agents: { "agent-a": STUB_ECHO_MODEL_ID } },
    });
    expect(modelForAgent(withWindow, "agent-a")?.contextWindowTokens).toBe(200000);
    expect(modelForAgent(smaller, "agent-a")?.contextWindowTokens).toBe(32000);
    const first = captureManagedSelection(withWindow, "agent-a");
    const second = captureManagedSelection(smaller, "agent-a");
    expect(first.kind).toBe("managed");
    expect(second.kind).toBe("managed");
    if (first.kind === "managed" && second.kind === "managed") {
      expect(first.selectionRevision).not.toBe(second.selectionRevision);
    }
  });

  test("Pi externalCatalog adapts openai-responses models and skips secrets and other APIs", () => {
    const native = parseModelsFile({
      version: 1,
      externalCatalog: ["pi"],
      credentials: { "example-provider-b": "env:MINI_KEY" },
      models: {},
      assignments: { main: null, agents: { bot: "example-provider-b/cursor-grok-4.6-xhigh" } },
    });
    const resolved = resolveExternalCatalog(native, {
      pi: {
        providers: {
          "example-provider-b": {
            api: "openai-responses",
            baseUrl: "http://provider-b.example.invalid/",
            apiKey: "sk-should-never-be-copied",
            models: [
              { id: "cursor-grok-4.6-xhigh", contextWindow: 256000, input: ["text"] },
              { id: "cursor-grok-4.6-low", contextWindow: 256000 },
            ],
          },
          claude: {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            apiKey: "sk-ant",
            models: [{ id: "claude-opus" }],
          },
        },
      },
    });
    expect(resolved.models["example-provider-b/cursor-grok-4.6-xhigh"]).toMatchObject({
      provider: "openai-responses",
      model: "cursor-grok-4.6-xhigh",
      endpoint: "http://provider-b.example.invalid/",
      apiKeyRef: "env:MINI_KEY",
      catalog: "pi",
      contextWindowTokens: 256000,
    });
    expect(JSON.stringify(resolved.models)).not.toContain("sk-should-never-be-copied");
    expect(resolved.models["claude/claude-opus"]).toBeUndefined();
    expect(persistModelsDocument(resolved).models).toEqual({});
    expect(modelForAgent(resolved, "bot")?.model).toBe("cursor-grok-4.6-xhigh");
  });

  test("local models overlay Pi ids and persist without catalog records", () => {
    const native = parseModelsFile({
      version: 1,
      externalCatalog: ["pi"],
      credentials: { mini: "env:MINI_KEY" },
      models: {
        "mini/kept": {
          provider: "openai-responses",
          model: "kept",
          endpoint: "http://provider-b.example.invalid/",
          apiKeyRef: "env:OTHER_KEY",
          alias: "g46x",
        },
      },
      assignments: { main: null, agents: {} },
    });
    const resolved = resolveExternalCatalog(native, {
      pi: {
        providers: {
          mini: {
            api: "openai-responses",
            baseUrl: "http://provider-b.example.invalid/",
            models: [{ id: "kept" }, { id: "from-pi" }],
          },
        },
      },
    });
    expect(resolved.models["mini/kept"]?.apiKeyRef).toBe("env:OTHER_KEY");
    expect(resolved.models["mini/kept"]?.alias).toBe("g46x");
    expect(resolved.models["mini/from-pi"]?.catalog).toBe("pi");
    const persisted = persistModelsDocument(resolved);
    expect(persisted.models["mini/from-pi"]).toBeUndefined();
    expect(persisted.models["mini/kept"]?.alias).toBe("g46x");
    expect(persisted.externalCatalog).toEqual(["pi"]);
  });

  test("Pi catalog discovery prefers PI_MODELS_PATH then agent then root", () => {
    expect(piModelsPathCandidates({
      catalog: ["pi"],
      homedir: "/home/box",
      env: {},
    })).toEqual(["/home/box/.pi/agent/models.json", "/home/box/.pi/models.json"]);
    expect(piModelsPathCandidates({
      catalog: ["pi"],
      homedir: "/home/box",
      env: { PI_MODELS_PATH: "/custom/models.json" },
    })[0]).toBe("/custom/models.json");
    expect(piModelsPathCandidates({
      catalog: [{ id: "pi", modelsPath: "/abs/pi.json" }],
      homedir: "/home/box",
      env: { PI_MODELS_PATH: "/custom/models.json" },
    })).toEqual(["/abs/pi.json"]);
  });
});
