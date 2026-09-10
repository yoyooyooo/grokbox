import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_ECHO_MODEL_ID, computeSelectionRevision, modelForAgent } from "@grokbox/runtime-kernel/selection";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { captureHostManagedSelection, captureHostSelection, loadModelsFileSync } from "../src/internal/host/selection.node.ts";
import { isHostPromptSession } from "../src/internal/host/session.ts";
import { hostEventsPath } from "../src/internal/host/terminal-journal.node.ts";
import type { HostBinding } from "../src/internal/host/host-binding.ts";

const official = { kind: "official" };

describe("Host session hook", () => {
  test("missing models and unassigned agents passthrough originalSession", async () => {
    const missing = await mkdtemp(join(tmpdir(), "grokbox-hook-missing-"));
    const hook = bindHostSessionHook({ mode: "route", durableRoot: missing, runRoot: missing });
    expect(hook({ originalSession: official, agentId: "agent-1" })).toBe(official);

    const empty = await mkdtemp(join(tmpdir(), "grokbox-hook-empty-"));
    await writeFile(join(empty, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: STUB_ECHO_MODEL_ID, agents: {} },
    })}\n`);
    const emptyHook = bindHostSessionHook({ mode: "route", durableRoot: empty, runRoot: empty });
    expect(emptyHook({ originalSession: official, agentId: "agent-1" })).toBe(official);
    expect(captureHostSelection(empty, "agent-1")).toEqual({ kind: "official" });
  });

  test("managed assignment returns Host prompt session", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-managed-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    const declined = hook({ originalSession: official, agentId: "agent-tom" });
    expect(declined).toBe(official);
    const managed = hook({
      originalSession: official,
      agentId: "agent-tom",
      sessionOptions: { invocationId: "turn-1", agentId: "agent-tom" },
    });
    expect(isHostPromptSession(managed)).toBe(true);
    if (isHostPromptSession(managed)) expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
    expect(captureHostSelection(root, "agent-tom")).toMatchObject({
      kind: "managed",
      modelId: STUB_ECHO_MODEL_ID,
    });
    expect(captureHostSelection(root, "agent-other")).toEqual({ kind: "official" });
  });

  test("no-STEP createSession declines to the original Host session", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-compact-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    expect(hook({ originalSession: official, agentId: "agent-tom" })).toBe(official);
    const started = Date.now();
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() - started < 2000) {
      try {
        rows = (await readFile(hostEventsPath(root), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        rows = [];
      }
      if (rows.some((row) => row.stage === "hook_decline" && row.result === "compact_passthrough")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rows.some((row) => row.reason === "missing-turn")).toBe(false);
    expect(rows.some((row) => row.stage === "hook_decline" && row.result === "compact_passthrough")).toBe(true);
  });

  test("STEP streams stay managed; no-STEP streams use the original Host session", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-overlay-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const binding: HostBinding = {
      generationId: "a".repeat(64),
      activationId: "op-1",
      pid: 1,
      start: 1,
      sourceSha: "b".repeat(64),
      identitySha: "c".repeat(64),
    };
    const compile = {
      profileId: "p",
      profileSha256: "d".repeat(64),
      sourceSha256: "b".repeat(64),
      transformedSha256: "e".repeat(64),
    };
    const officialCalls: unknown[] = [];
    const original = {
      getModelId: () => "official",
      getExecutor: () => ({
        appendMessages() { return this; },
        getMessages: () => [],
        getState: () => [],
        clearMessages() {},
        stream(...args: unknown[]) {
          officialCalls.push(args);
          return { fullStream: (async function* () {})(), response: Promise.resolve({}), usage: Promise.resolve({}), extendedUsage: Promise.resolve({}), providerMetadata: Promise.resolve({}), invocationId: Promise.resolve(undefined) };
        },
      }),
      getExecutorWithoutResolvedModelTracking() { return this.getExecutor(); },
    };
    const hook = bindHostSessionHook({
      mode: "route",
      durableRoot: root,
      runRoot: root,
      binding,
      compile,
    });
    const managed = hook({
      originalSession: original,
      agentId: "agent-tom",
      sessionOptions: { invocationId: "turn-1", agentId: "agent-tom" },
    });
    expect(isHostPromptSession(managed)).toBe(true);
    if (!isHostPromptSession(managed)) return;
    managed.getExecutor([]).stream({}, undefined);
    expect(officialCalls.length).toBe(1);
    managed.getExecutor([]).stream({}, "step-1");
    expect(officialCalls.length).toBe(1);
    const started = Date.now();
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() - started < 2000) {
      try {
        rows = (await readFile(hostEventsPath(root), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        rows = [];
      }
      if (rows.some((row) => row.stage === "hook_decline" && row.result === "compact_passthrough")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(rows.some((row) => row.reason === "missing-step-id")).toBe(false);
    expect(rows.some((row) => row.stage === "hook_decline" && row.result === "compact_passthrough")).toBe(true);
  });

  test("invalid executor state leaves Host rejection facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-reject-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const binding: HostBinding = {
      generationId: "a".repeat(64),
      activationId: "op-1",
      pid: 1,
      start: 1,
      sourceSha: "b".repeat(64),
      identitySha: "c".repeat(64),
    };
    const compile = {
      profileId: "p",
      profileSha256: "d".repeat(64),
      sourceSha256: "b".repeat(64),
      transformedSha256: "e".repeat(64),
    };
    const hook = bindHostSessionHook({
      mode: "route",
      durableRoot: root,
      runRoot: root,
      binding,
      compile,
    });
    const withTurn = hook({
      originalSession: official,
      agentId: "agent-tom",
      sessionOptions: { invocationId: "turn-1", agentId: "agent-tom" },
    });
    expect(isHostPromptSession(withTurn)).toBe(true);
    if (isHostPromptSession(withTurn)) {
      withTurn.getExecutor({ not: "messages" }).stream({}, "step-1", 1);
    }
    const started = Date.now();
    let rows: Array<Record<string, unknown>> = [];
    while (Date.now() - started < 2000) {
      try {
        rows = (await readFile(hostEventsPath(root), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        rows = [];
      }
      if (rows.some((row) => row.reason === "invalid-state")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const names = rows.map((row) => row.name);
    expect(names).toContain("host_seam_stage");
    expect(names).toContain("host_stream_rejected");
    expect(rows.some((row) => row.stage === "hook_enter")).toBe(true);
    expect(rows.some((row) => row.reason === "missing-turn")).toBe(false);
    const invalid = rows.find((row) => row.reason === "invalid-state");
    expect(invalid).toMatchObject({ name: "host_stream_rejected", stage: "admit", turnId: "turn-1" });
    expect(rows.length).toBeGreaterThan(0);
  });

  test("Host W and selectionRevision come from one models.json snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-capacity-"));
    const openai = {
      provider: "openai",
      model: "gpt",
      endpoint: "https://api.example.test/v1",
      apiKeyRef: "env:KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
    };
    const write = async (window: number) => {
      await writeFile(join(root, "models.json"), `${JSON.stringify({
        version: 1,
        models: { "openai/gpt": { ...openai, contextWindowTokens: window } },
        assignments: { main: null, agents: { "agent-tom": "openai/gpt" } },
      })}\n`);
    };
    await write(32000);
    const captureA = captureHostManagedSelection(root, "agent-tom");
    expect(captureA.kind).toBe("managed");
    if (captureA.kind !== "managed") throw new Error("A");
    expect(captureA.record.contextWindowTokens).toBe(32000);
    expect(captureA.selectionRevision).toBe(computeSelectionRevision({ agentId: "agent-tom", model: captureA.record }));

    await write(200000);
    const fileB = loadModelsFileSync(root);
    expect(fileB).not.toBeNull();
    const recordB = modelForAgent(fileB!, "agent-tom");
    expect(recordB?.contextWindowTokens).toBe(200000);
    expect(computeSelectionRevision({ agentId: "agent-tom", model: recordB! })).not.toBe(captureA.selectionRevision);
    expect(captureA.record.contextWindowTokens).toBe(32000);

    await write(32000);
    const captureAgain = captureHostManagedSelection(root, "agent-tom");
    expect(captureAgain.kind).toBe("managed");
    if (captureAgain.kind !== "managed") throw new Error("A2");
    expect(captureAgain.record.contextWindowTokens).toBe(32000);
    expect(captureAgain.selectionRevision).toBe(captureA.selectionRevision);
    expect(captureA.record.contextWindowTokens).toBe(32000);
  });
});
