import { describe, expect, test } from "bun:test";
import { BoxRuntimeError } from "../src/errors.ts";
import { bindHostSessionHook, createStubRouteDriver } from "../src/seam.ts";
import {
  assertRouteAssignment,
  decideRouteSession,
  resolveRouteSessionModel,
  STUB_ECHO_MODEL_ID,
  type ModelsFile,
} from "../src/models.ts";
import type { HostPromptSession } from "../src/session.ts";
import { FAKE_BINDING, modeldFixture } from "./modeld-fixture.ts";
import { startStubModeldServer } from "../src/modeld-ipc.ts";

/** grokbox test0 (stable id). grokbox test1 is unassigned unless opted in. */
const GROK_BOT = "00000000-0000-4000-8000-000000000114";
const openaiModel = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};

const canaryFile = (): ModelsFile => ({
  version: 1,
  models: { [openaiModel.id]: openaiModel },
  assignments: { main: null, agents: { [GROK_BOT]: openaiModel.id } },
});

describe("T10 selective route official passthrough", () => {
  test("agents-only activate is valid; missing override is official; assigned openai is managed", () => {
    const file = canaryFile();
    assertRouteAssignment(file);
    expect(decideRouteSession(file, GROK_BOT)).toEqual({
      kind: "managed",
      modelId: openaiModel.id,
      assignment: "agent",
    });
    expect(decideRouteSession(file, "other-bot")).toEqual({ kind: "official" });
    expect(decideRouteSession(file)).toEqual({ kind: "official" });
    expect(resolveRouteSessionModel(file, GROK_BOT).modelId).toBe(openaiModel.id);
    expect(() => resolveRouteSessionModel(file, "other-bot")).toThrow(BoxRuntimeError);
    expect(() => assertRouteAssignment({
      version: 1,
      models: { "acme/fast": { ...openaiModel, id: "acme/fast", provider: "acme", model: "fast" } },
      assignments: { main: null, agents: { [GROK_BOT]: "acme/fast" } },
    })).toThrow(BoxRuntimeError);
  });

  test("hook: assigned bot is modeld; unassigned bot is originalSession; unassigned never dispatches", async () => {
    const f = await modeldFixture();
    await f.store.saveModels(canaryFile());
    const env = { OPENAI_API_KEY: "offline-test-key" };
    const server = await startStubModeldServer({
      ...f,
      durableRoot: f.durable,
      defaultDriver: {
        env,
        streamEvents: async function* () {
          yield { type: "text-delta", text: "hi" };
          yield { type: "finish" };
        },
      },
    });
    try {
      const official = { stream: () => { throw new Error("official hard-off"); } };
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const canary = hook({
        originalSession: official,
        agentId: GROK_BOT,
        sessionOptions: { invocationId: "turn-canary", inferenceReason: "main" },
      }) as HostPromptSession;
      expect(canary).not.toBe(official);
      const response = await canary.getExecutor([]).stream({}, "step-canary").response;
      expect(response.modelId).toBe(openaiModel.id);
      expect(response.messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]);
      expect(server.dispatches()).toBe(1);

      const other = hook({
        originalSession: official,
        agentId: "grokbox-bot",
        sessionOptions: { invocationId: "turn-other", inferenceReason: "main" },
      });
      expect(other).toBe(official);
      expect(server.dispatches()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("assigned stub still echoes; static stub driver is unused for passthrough", async () => {
    const f = await modeldFixture();
    await f.store.saveModels({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    });
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      const official = { stream: () => { throw new Error("official hard-off"); } };
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const tom = hook({
        originalSession: official,
        agentId: "agent-tom",
        sessionOptions: { invocationId: "turn-stub", inferenceReason: "main" },
      }) as HostPromptSession;
      expect((await tom.getExecutor([]).stream({}, "step-stub").response).modelId).toBe(STUB_ECHO_MODEL_ID);
      expect(server.dispatches()).toBe(1);
      const jerry = hook({
        originalSession: official,
        agentId: "agent-jerry",
        sessionOptions: { invocationId: "turn-jerry", inferenceReason: "main" },
      });
      expect(jerry).toBe(official);
      expect(server.dispatches()).toBe(1);
      expect(createStubRouteDriver([]).officialCalls).toBe(0);
    } finally {
      await server.stop();
    }
  });
});
