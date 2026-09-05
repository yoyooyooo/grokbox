import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReset,
  applyUse,
  assertResetAllowed,
  assertRouteAssignment,
  disclosure,
  openRuntimeStore,
  parseApiKeyRef,
} from "../src/models.ts";
import { CLI_INSTALL_ROOT, resolveDurableRoot } from "../src/paths.ts";
import { projectStatus } from "../src/observe.ts";
import { BoxRuntimeError } from "../src/errors.ts";

const SAMPLE = {
  version: 1 as const,
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
  assignments: { main: null as string | null, agents: {} as Record<string, string> },
};

describe("models.json store", () => {
  test("secret refs reject literals and $VAR", () => {
    expect(parseApiKeyRef("env:ACME_KEY")).toEqual({ kind: "env", ref: "env:ACME_KEY" });
    expect(() => parseApiKeyRef("sk-live")).toThrow(BoxRuntimeError);
    expect(() => parseApiKeyRef("env:$TOKEN")).toThrow(BoxRuntimeError);
    expect(() => parseApiKeyRef("file:relative")).toThrow(BoxRuntimeError);
  });

  test("durable root cannot be the CLI install tree", () => {
    expect(() => resolveDurableRoot(join(homedir(), ".grokbox", "runtime"))).toThrow(BoxRuntimeError);
    expect(CLI_INSTALL_ROOT).toContain(".grokbox/runtime");
  });

  test("use/reset default vs --for and route refuses reset", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-runtime-"));
    const store = openRuntimeStore(root);
    await store.saveModels(SAMPLE);
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
    const desired = await store.loadDesired();
    expect(() => assertResetAllowed(desired)).toThrow(BoxRuntimeError);
    assertRouteAssignment(await store.loadModels());
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
    expect(reset.assignments.main).toBe("stub/echo");
  });
});
