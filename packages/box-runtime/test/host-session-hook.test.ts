import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";
import { captureHostSelection } from "../src/internal/host/selection.node.ts";
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
    const managed = hook({ originalSession: official, agentId: "agent-tom" });
    expect(isHostPromptSession(managed)).toBe(true);
    if (isHostPromptSession(managed)) expect(managed.getModelId()).toBe(STUB_ECHO_MODEL_ID);
    expect(captureHostSelection(root, "agent-tom")).toMatchObject({
      kind: "managed",
      modelId: STUB_ECHO_MODEL_ID,
    });
    expect(captureHostSelection(root, "agent-other")).toEqual({ kind: "official" });
  });

  test("missing TURN and invalid executor state leave Host rejection facts", async () => {
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
    const missingTurn = hook({ originalSession: official, agentId: "agent-tom" });
    expect(isHostPromptSession(missingTurn)).toBe(true);
    if (isHostPromptSession(missingTurn)) {
      missingTurn.getExecutor().stream({}, "step-1");
    }
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
      if (rows.some((row) => row.reason === "missing-turn") && rows.some((row) => row.reason === "invalid-state")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const names = rows.map((row) => row.name);
    expect(names).toContain("host_seam_stage");
    expect(names).toContain("host_stream_rejected");
    expect(rows.some((row) => row.stage === "hook_enter")).toBe(true);
    expect(rows.some((row) => row.stage === "stream_enter")).toBe(true);
    const missing = rows.find((row) => row.reason === "missing-turn");
    expect(missing).toMatchObject({ name: "host_stream_rejected", stage: "admit", agentId: "agent-tom" });
    expect(missing?.turnId).toBeUndefined();
    const invalid = rows.find((row) => row.reason === "invalid-state");
    expect(invalid).toMatchObject({ name: "host_stream_rejected", stage: "admit", turnId: "turn-1" });
    expect(rows.length).toBeGreaterThan(0);
  });
});
