import { describe, expect, test } from "bun:test";
import { buildModelEnvelope } from "../src/envelope.ts";
import { assertRouteAssignment, routeHasNonStubAssignment, STUB_ECHO_MODEL, type ModelsFile } from "../src/models.ts";
import { BoxRuntimeError } from "../src/errors.ts";
import { submitPartsFromResponse } from "../src/modeld-ipc.ts";
import { createModeldRouteDriver } from "../src/seam.ts";
import { createDefaultCredentialFingerprint } from "../src/modeld-default.ts";
import { startStubModeldServer } from "../src/modeld-serve.ts";
import { FAKE_BINDING, modeldFixture, submitRequest } from "./modeld-fixture.ts";

const openaiModel = {
  id: "openai/gpt-4o-mini",
  provider: "openai",
  model: "gpt-4o-mini",
  endpoint: "https://sub2api.test/v1",
  apiKeyRef: "env:OPENAI_API_KEY",
  capabilities: { vision: false, tools: true, images: false },
  dataTypes: ["text", "tools"],
};

const openaiFile = (over: Partial<typeof openaiModel> = {}, assignment = openaiModel.id): ModelsFile => ({
  version: 1,
  models: { [openaiModel.id]: { ...openaiModel, ...over, id: openaiModel.id } },
  assignments: { main: assignment, agents: {} },
});

describe("T4d route admit openai*", () => {
  test("stub remains admitted; openai* with https + apiKeyRef activates; others fail-closed", () => {
    assertRouteAssignment({ version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } });
    assertRouteAssignment(openaiFile());
    assertRouteAssignment(openaiFile({ provider: "openai-responses" }));
    expect(() => assertRouteAssignment({
      version: 1,
      models: { "acme/fast": { id: "acme/fast", provider: "acme", model: "fast", endpoint: "https://api.acme.test/v1", apiKeyRef: "env:ACME_KEY", capabilities: { vision: false, tools: true, images: false }, dataTypes: ["text"] } },
      assignments: { main: "acme/fast", agents: {} },
    })).toThrow(BoxRuntimeError);
    expect(() => assertRouteAssignment(openaiFile({ apiKeyRef: "" }))).toThrow(BoxRuntimeError);
    expect(() => assertRouteAssignment(openaiFile({ endpoint: "stub:echo" }))).toThrow(BoxRuntimeError);
    expect(() => assertRouteAssignment(openaiFile({ provider: "as1" }))).toThrow(BoxRuntimeError);
    expect(routeHasNonStubAssignment(openaiFile())).toBe(false);
    expect(routeHasNonStubAssignment({ version: 1, models: {}, assignments: { main: "stub/echo", agents: {} } })).toBe(false);
    expect(routeHasNonStubAssignment({
      version: 1,
      models: { "acme/fast": { id: "acme/fast", provider: "acme", model: "fast", endpoint: "https://x", apiKeyRef: "env:X", capabilities: { vision: false, tools: false, images: false }, dataTypes: ["text"] } },
      assignments: { main: "acme/fast", agents: {} },
    })).toBe(true);
    expect(STUB_ECHO_MODEL.id).toBe("stub/echo");
  });

  test("modeld route driver accepts openai modelId and IPC parts are not stub-only", async () => {
    expect(submitPartsFromResponse({
      ok: true, method: "submit", modelId: "openai/gpt-4o-mini", assignment: "main", dispatched: true,
      parts: [{ type: "text-delta", textDelta: "hi" }, { type: "finish", reason: "stop" }],
    })).toMatchObject({
      assignment: "main",
      dispatched: true,
      parts: [{ type: "text-delta", textDelta: "hi" }, { type: "finish", reason: "stop" }],
    });

    const f = await modeldFixture();
    await f.store.saveModels(openaiFile());
    const env = { OPENAI_API_KEY: "offline-test-key" };
    const server = await startStubModeldServer({
      ...f, durableRoot: f.durable,
      defaultDriver: {
        env,
        streamEvents: async function* () {
          yield { type: "text-delta", text: "ok" };
          yield { type: "finish" };
        },
      },
    });
    try {
      const driver = createModeldRouteDriver(f.runRoot, FAKE_BINDING);
      const result = await driver.submit!({
        invocationId: "step-1", turnId: "turn-1", agentId: "agent-tom",
        modelId: "openai/gpt-4o-mini",
        envelope: buildModelEnvelope([{ role: "user", content: "hi" }]),
      });
      expect(result).toMatchObject({
        dispatched: true,
        parts: [{ type: "text-delta", textDelta: "ok" }, { type: "finish", reason: "stop" }],
      });
      expect(submitRequest(server, "unused").method).toBe("submit");
      expect(createDefaultCredentialFingerprint(env)).toBeTypeOf("function");
    } finally {
      await server.stop();
    }
  });
});
