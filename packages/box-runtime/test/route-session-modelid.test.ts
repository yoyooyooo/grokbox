import { describe, expect, test } from "bun:test";
import { bindHostSessionHook } from "../src/seam.ts";
import { loadModelsFileSync, resolveRouteSessionModel, STUB_ECHO_MODEL_ID, type ModelsFile } from "../src/models.ts";
import type { HostPromptSession } from "../src/session.ts";
import { FAKE_BINDING, modeldFixture } from "./modeld-fixture.ts";
import { startStubModeldServer } from "../src/modeld-ipc.ts";

const openaiModel = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};

const openaiFile = (agents: Record<string, string> = {}): ModelsFile => ({
  version: 1,
  models: { [openaiModel.id]: openaiModel },
  assignments: { main: openaiModel.id, agents },
});

const official = { stream: () => { throw new Error("official hard-off"); } };

describe("T4e route session modelId follows models.json", () => {
  test("resolveRouteSessionModel requires a per-agent override; missing is official", () => {
    const file = openaiFile({ "agent-tom": STUB_ECHO_MODEL_ID });
    expect(() => resolveRouteSessionModel(file)).toThrow(/official passthrough/);
    expect(() => resolveRouteSessionModel(file, "agent-jerry")).toThrow(/official passthrough/);
    expect(resolveRouteSessionModel(file, "agent-tom")).toEqual({ modelId: STUB_ECHO_MODEL_ID, assignment: "agent" });
    expect(() => resolveRouteSessionModel({
      version: 1,
      models: { "acme/fast": { id: "acme/fast", provider: "acme", model: "fast", endpoint: "https://x", apiKeyRef: "env:X", capabilities: { vision: false, tools: false, images: false }, dataTypes: ["text"] } },
      assignments: { main: null, agents: { "agent-tom": "acme/fast" } },
    }, "agent-tom")).toThrow(/openai\*/);
  });

  test("route hook session/stream modelId matches openai per-agent assignment", async () => {
    const f = await modeldFixture();
    await f.store.saveModels(openaiFile({ "agent-jerry": openaiModel.id }));
    const server = await startStubModeldServer({
      ...f, durableRoot: f.durable,
      defaultDriver: {
        env: { OPENAI_API_KEY: "offline-test-key" },
        streamEvents: async function* () {
          yield { type: "text-delta", text: "hi" };
          yield { type: "finish" };
        },
      },
    });
    try {
      expect(loadModelsFileSync(f.durable)?.assignments.agents["agent-jerry"]).toBe(openaiModel.id);
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const session = hook({
        originalSession: official,
        agentId: "agent-jerry",
        sessionOptions: { invocationId: "turn-openai", inferenceReason: "main" },
      }) as HostPromptSession;
      const response = await session.getExecutor([]).stream({}, "step-openai").response;
      expect(response.modelId).toBe(openaiModel.id);
      expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
    } finally {
      await server.stop();
    }
  });

  test("stub assignment still labels stub; missing override is official; disallowed assignment is originalSession", async () => {
    const f = await modeldFixture();
    await f.store.saveModels({ version: 1, models: {}, assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } } });
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const stub = hook({
        originalSession: official,
        agentId: "agent-tom",
        sessionOptions: { invocationId: "turn-stub", inferenceReason: "main" },
      }) as HostPromptSession;
      expect((await stub.getExecutor([]).stream({}, "step-stub").response).modelId).toBe(STUB_ECHO_MODEL_ID);

      const identity = bindHostSessionHook({ mode: "identity", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      expect(identity({ originalSession: official, agentId: "agent-tom" })).toBe(official);
    } finally {
      await server.stop();
    }

    const missing = await modeldFixture();
    await missing.store.saveModels({ version: 1, models: {}, assignments: { main: null, agents: {} } });
    const missingHook = bindHostSessionHook({ mode: "route", durableRoot: missing.durable, runRoot: missing.runRoot, binding: FAKE_BINDING });
    const passed = missingHook({
      originalSession: official,
      agentId: "agent-tom",
      sessionOptions: { invocationId: "turn-missing", inferenceReason: "main" },
    });
    expect(passed).toBe(official);

    const bad = await modeldFixture();
    await bad.store.saveModels({
      version: 1,
      models: { "acme/fast": { id: "acme/fast", provider: "acme", model: "fast", endpoint: "https://x", apiKeyRef: "env:X", capabilities: { vision: false, tools: false, images: false }, dataTypes: ["text"] } },
      assignments: { main: null, agents: { "agent-tom": "acme/fast" } },
    });
    const badHook = bindHostSessionHook({ mode: "route", durableRoot: bad.durable, runRoot: bad.runRoot, binding: FAKE_BINDING });
    const rejected = badHook({
      originalSession: official,
      agentId: "agent-tom",
      sessionOptions: { invocationId: "turn-acme", inferenceReason: "main" },
    });
    expect(rejected).toBe(official);
  });

  test("agents.* override is the only managed path; unassigned uses originalSession", async () => {
    const f = await modeldFixture();
    await f.store.saveModels(openaiFile({ "agent-tom": STUB_ECHO_MODEL_ID }));
    const server = await startStubModeldServer({
      ...f, durableRoot: f.durable,
      defaultDriver: {
        env: { OPENAI_API_KEY: "offline-test-key" },
        streamEvents: async function* () {
          yield { type: "text-delta", text: "hi" };
          yield { type: "finish" };
        },
      },
    });
    try {
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const tom = hook({
        originalSession: official,
        agentId: "agent-tom",
        sessionOptions: { invocationId: "turn-tom", inferenceReason: "main" },
      }) as HostPromptSession;
      expect((await tom.getExecutor([]).stream({}, "step-tom").response).modelId).toBe(STUB_ECHO_MODEL_ID);
      const jerry = hook({
        originalSession: official,
        agentId: "agent-jerry",
        sessionOptions: { invocationId: "turn-jerry", inferenceReason: "main" },
      });
      expect(jerry).toBe(official);
    } finally {
      await server.stop();
    }
  });
});
