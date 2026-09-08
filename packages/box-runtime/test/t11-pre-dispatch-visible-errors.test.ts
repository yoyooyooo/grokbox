import { describe, expect, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { bindHostSessionHook, createSessionSeam, createStubRouteDriver, createModeldRouteDriver } from "../src/seam.ts";
import { eventsPath, modelsPath } from "../src/paths.ts";
import { STUB_ECHO_MODEL_ID } from "../src/models.ts";
import type { HostPromptSession, PromptSession } from "../src/session.ts";
import { FAKE_BINDING, modeldFixture } from "./modeld-fixture.ts";
import { startStubModeldServer } from "../src/modeld-serve.ts";
import { consumeHandle } from "./host-consumer.ts";

const AT = "2026-01-01T00:00:00.000Z";
/** T11 debug canary: grokbox test0. grokbox test1 and others stay official via T10 until opted in. */
const GROK_BOT = "00000000-0000-4000-8000-000000000114";

function officialOff(): PromptSession {
  return { stream() { throw new Error("official session must not run"); } };
}

async function stepEvents(dir: string): Promise<Array<Record<string, unknown>>> {
  let text = "";
  try { text = await readFile(eventsPath(dir), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.name === "model_step_terminal");
}

describe("T11 pre-dispatch official passthrough and STEP-correlated visible errors", () => {
  test("hook: missing models, missing ids, resolve throw, and down socket return originalSession", async () => {
    const missingFile = await modeldFixture();
    await unlink(modelsPath(missingFile.durable));
    const missingHook = bindHostSessionHook({
      mode: "route", durableRoot: missingFile.durable, runRoot: missingFile.runRoot, binding: FAKE_BINDING,
    });
    const official = officialOff();
    expect(missingHook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-models", inferenceReason: "main" },
    })).toBe(official);

    const f = await modeldFixture();
    await f.store.saveModels({
      version: 1, models: {}, assignments: { main: null, agents: { [GROK_BOT]: STUB_ECHO_MODEL_ID } },
    });
    const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
    expect(hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { inferenceReason: "main" },
    })).toBe(official);
    expect(hook({
      originalSession: official,
      sessionOptions: { invocationId: "turn-no-agent", inferenceReason: "main" },
    })).toBe(official);

    const bad = await modeldFixture();
    await bad.store.saveModels({
      version: 1,
      models: {
        "acme/fast": {
          id: "acme/fast", provider: "acme", model: "fast", endpoint: "https://x", apiKeyRef: "env:X",
          capabilities: { vision: false, tools: false, images: false }, dataTypes: ["text"],
        },
      },
      assignments: { main: null, agents: { [GROK_BOT]: "acme/fast" } },
    });
    const badHook = bindHostSessionHook({ mode: "route", durableRoot: bad.durable, runRoot: bad.runRoot, binding: FAKE_BINDING });
    expect(badHook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-acme", inferenceReason: "main" },
    })).toBe(official);

    // Assigned canary, no modeld socket: handshake-unavailable before wrap.
    expect(hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-down", inferenceReason: "main" },
    })).toBe(official);
  });

  test("unassigned bots stay originalSession; assigned canary is modeld when socket is up", async () => {
    const f = await modeldFixture();
    await f.store.saveModels({
      version: 1, models: {}, assignments: { main: null, agents: { [GROK_BOT]: STUB_ECHO_MODEL_ID } },
    });
    const server = await startStubModeldServer({ ...f, durableRoot: f.durable });
    try {
      const official = officialOff();
      const hook = bindHostSessionHook({ mode: "route", durableRoot: f.durable, runRoot: f.runRoot, binding: FAKE_BINDING });
      const canary = hook({
        originalSession: official, agentId: GROK_BOT,
        sessionOptions: { invocationId: "turn-canary", inferenceReason: "main" },
      }) as HostPromptSession;
      expect(canary).not.toBe(official);
      expect((await canary.getExecutor([]).stream({}, "step-canary").response).modelId).toBe(STUB_ECHO_MODEL_ID);
      const other = hook({
        originalSession: official, agentId: "grokbox-bot",
        sessionOptions: { invocationId: "turn-other", inferenceReason: "main" },
      });
      expect(other).toBe(official);
      expect(server.dispatches()).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("session identity conflict stays visible; does not unwrap to originalSession", async () => {
    const dir = (await modeldFixture()).durable;
    const driver = createStubRouteDriver([
      { type: "text-delta", textDelta: "echo" }, { type: "finish", reason: "stop" },
    ]);
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "main", modelId: STUB_ECHO_MODEL_ID, driver, now: () => AT,
    });
    const official = officialOff();
    const first = seam.hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-conflict", inferenceReason: "main" },
    }) as HostPromptSession;
    const second = seam.hook({
      originalSession: official, agentId: "other-bot",
      sessionOptions: { invocationId: "turn-conflict", inferenceReason: "main" },
    }) as HostPromptSession;
    expect(second).not.toBe(official);
    expect(second).not.toBe(first);
    const error = (await second.getExecutor([]).stream({}, "step-conflict").response).error;
    expect(error).toMatchObject({
      userVisible: true, code: "invalid_envelope", agentId: "other-bot", invocationId: "turn-conflict", stage: "admit",
    });
    expect(driver.officialCalls).toBe(0);
  });

  test("after wrap, handshake/admit failure is visible admit error; official never runs", async () => {
    const { durable, runRoot } = await modeldFixture();
    const driver = createModeldRouteDriver(runRoot, FAKE_BINDING);
    const seam = createSessionSeam({
      mode: "route", root: durable, assignment: "agent", modelId: STUB_ECHO_MODEL_ID, driver, now: () => AT,
    });
    const official = officialOff();
    const session = seam.hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-admit", inferenceReason: "main" },
    }) as HostPromptSession;
    expect(session).not.toBe(official);
    const response = await session.getExecutor([]).stream({}, "step-admit").response;
    expect(response.error).toMatchObject({
      userVisible: true, agentId: GROK_BOT, invocationId: "step-admit", stage: "admit",
    });
    expect(response.error?.message).toContain("stage=admit");
    await seam.flush();
    expect(driver.officialCalls).toBe(0);
    expect(driver.secondProviderCalls).toBe(0);
    expect(await stepEvents(durable)).toEqual([
      expect.objectContaining({
        name: "model_step_terminal", agentId: GROK_BOT, invocationId: "step-admit", turnId: "turn-admit",
        terminalClass: "error", outcome: "managed", stage: "admit", errorCode: "model_error",
      }),
    ]);
  });

  test("after provider dispatch / mid-tool: visible provider error; no official replay", async () => {
    const dir = (await modeldFixture()).durable;
    const driver = createStubRouteDriver([]);
    driver.delivery = "stream";
    driver.stream = async function* () {
      yield { type: "tool-call", toolCallId: "call-1", toolName: "bash", args: { command: "true" } };
      throw new Error("provider died");
    };
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "agent", modelId: STUB_ECHO_MODEL_ID, driver, now: () => AT,
    });
    const official = officialOff();
    const session = seam.hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-provider", inferenceReason: "main" },
    }) as HostPromptSession;
    const result = session.getExecutor([]).stream({}, "step-provider");
    const vector = await consumeHandle(result);
    const error = (await result.response).error;
    expect(error).toMatchObject({
      userVisible: true, agentId: GROK_BOT, invocationId: "step-provider", stage: "provider",
    });
    expect(error?.message).toContain("No fallback model was used");
    expect(vector.toolExecutionCount).toBe(1);
    expect(driver.officialCalls).toBe(0);
    expect(driver.secondProviderCalls).toBe(0);
    await seam.flush();
    expect(await stepEvents(dir)).toEqual([
      expect.objectContaining({
        invocationId: "step-provider", agentId: GROK_BOT, stage: "provider", terminalClass: "error",
        outcome: "managed", errorCode: "model_error", toolCallCount: 1,
      }),
    ]);
  });

  test("normalize failure after dispatched parts is visible; no official replay", async () => {
    const dir = (await modeldFixture()).durable;
    const driver = createStubRouteDriver([]);
    driver.submit = async () => ({
      dispatched: true,
      assignment: "agent",
      parts: [{ type: "text-delta", textDelta: "partial" }],
    });
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "agent", modelId: STUB_ECHO_MODEL_ID, driver, now: () => AT,
    });
    const official = officialOff();
    const session = seam.hook({
      originalSession: official, agentId: GROK_BOT,
      sessionOptions: { invocationId: "turn-normalize", inferenceReason: "main" },
    }) as HostPromptSession;
    const error = (await session.getExecutor([]).stream({}, "step-normalize").response).error;
    expect(error).toMatchObject({
      userVisible: true, agentId: GROK_BOT, invocationId: "step-normalize", stage: "normalize",
    });
    expect(driver.officialCalls).toBe(0);
    await seam.flush();
    expect(await stepEvents(dir)).toEqual([
      expect.objectContaining({
        invocationId: "step-normalize", stage: "normalize", terminalClass: "error", errorCode: "invalid_stream",
      }),
    ]);
  });
});
