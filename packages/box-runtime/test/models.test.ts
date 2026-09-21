import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReset,
  applyUse,
  applyFollowDefault,
  assertRouteAssignment,
  disclosure,
  parseApiKeyRef,
  parseModelsFile,
  resolveAssignment,
  type ModelAssignment,
} from "@grokbox/runtime-kernel/selection";
import { openRuntimeStore } from "../src/internal/io/configuration.node.ts";
import { CLI_INSTALL_ROOT, resolveDurableRoot } from "../src/internal/io/paths.ts";
import { projectStatus } from "../src/internal/io/observe.ts";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";

const SAMPLE = {
  version: 3 as const,
  models: {
    "acme/fast": {
      id: "acme/fast",
      provider: "acme",
      model: "fast",
      endpoint: "https://api.acme.test/v1",
      apiKeyRef: "env:ACME_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    },
  },
  assignments: { main: null as ModelAssignment | null, agents: {} as Record<string, ModelAssignment> },
};

describe("models.json store", () => {
  test("secret refs reject literals and $VAR", () => {
    expect(parseApiKeyRef("env:ACME_KEY")).toEqual({ kind: "env", ref: "env:ACME_KEY" });
    expect(parseApiKeyRef("pi-provider:sub2api-xai")).toEqual({ kind: "pi-provider", ref: "pi-provider:sub2api-xai" });
    expect(() => parseApiKeyRef("sk-live")).toThrow(BoxRuntimeError);
    expect(() => parseApiKeyRef("env:$TOKEN")).toThrow(BoxRuntimeError);
    expect(() => parseApiKeyRef("file:relative")).toThrow(BoxRuntimeError);
    expect(() => parseApiKeyRef("pi-provider:")).toThrow(BoxRuntimeError);
  });

  test("agent lookup uses own data keys, including explicit prototype-shaped ids", () => {
    const file = parseModelsFile({ ...SAMPLE, assignments: { main: { modelId: "stub/echo" }, agents: JSON.parse('{"__proto__":{"modelId":"acme/fast"}}') } });
    expect(resolveAssignment(file, "__proto__").id).toBe("acme/fast");
    expect(resolveAssignment(file, "toString").id).toBe("stub/echo");
    expect(resolveAssignment(file, "constructor").id).toBe("stub/echo");
  });

  test("durable root cannot be the CLI install tree", () => {
    expect(() => resolveDurableRoot(join(homedir(), ".grokbox", "runtime"))).toThrow(BoxRuntimeError);
    expect(CLI_INSTALL_ROOT).toContain(".grokbox/runtime");
  });

  test("default reset depends on followers, not route mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-runtime-"));
    const store = openRuntimeStore(root);
    await store.saveModels(parseModelsFile(SAMPLE));
    const used = applyUse(await store.loadModels(), "acme/fast");
    expect(disclosure(used, "acme/fast")).toMatchObject({
      endpoint: "https://api.acme.test/v1",
      takesEffect: "next_user_turn",
      blastRadius: "box_default",
      assignment: "main",
    });
    const forBot = applyUse(used, "acme/fast", "agent-tom");
    expect(disclosure(forBot, "acme/fast", "agent-tom").blastRadius).toBe("single_bot");
    await store.saveModels(forBot);
    const nonStub = await store.loadModels();
    expect(() => assertRouteAssignment(nonStub)).toThrow(BoxRuntimeError);
    const stubbed = applyUse(applyUse(nonStub, "stub/echo"), "stub/echo", "agent-tom");
    await store.saveModels(stubbed);
    await store.saveDesired({ version: 1, mode: "route" });
    expect((await store.loadDesired()).mode).toBe("route");
    expect(applyReset(stubbed).assignments.main).toBeNull();
    expect(() => applyReset(applyFollowDefault(stubbed, "follower"))).toThrow("model_default_in_use");
    assertRouteAssignment(await store.loadModels());
    const drifted = applyUse(await store.loadModels(), "acme/fast");
    expect(() => assertRouteAssignment(drifted)).toThrow(BoxRuntimeError);
    const openai = {
      ...SAMPLE,
      models: {
        ...SAMPLE.models,
        "openai/gpt-4o-mini": {
          id: "openai/gpt-4o-mini",
          provider: "openai",
          model: "gpt-4o-mini",
          endpoint: "https://sub2api.test/v1",
          apiKeyRef: "env:OPENAI_API_KEY",
          capabilities: { vision: false, tools: true, images: false },
          dataTypes: ["text", "tools"],
        },
      },
      assignments: { main: { modelId: "openai/gpt-4o-mini" }, agents: {} },
    };
    assertRouteAssignment(parseModelsFile(openai));
    assertRouteAssignment(parseModelsFile({
      version: 3,
      models: openai.models,
      assignments: { main: null, agents: { "00000000-0000-4000-8000-000000000114": { modelId: "openai/gpt-4o-mini" } } },
    }));
    const status = projectStatus({
      root: store.root,
      desired: await store.loadDesired(),
      models: await store.loadModels(),
    });
    expect(status.activation.desired).toBe("route");
    expect(status.coverage).toBe("none");
    expect(status.window.affectedInvocations).toBe("unknown");
    expect(status.modeld.required).toBe(true);
    await store.saveDesired({ version: 1, mode: "disabled" });
    const reset = applyReset(await store.loadModels(), "agent-tom");
    expect(reset.assignments.agents["agent-tom"]).toBeUndefined();
    expect(reset.assignments.main?.modelId).toBe("stub/echo");
  });
});
