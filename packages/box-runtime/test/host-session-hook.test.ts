import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";
import { bindHostSessionHook } from "../src/internal/host/session-hook.ts";

const official = { kind: "official" };

describe("Host session hook placeholders", () => {
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
  });

  test("managed assignment is visible runtime_not_ready without dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hook-managed-"));
    await writeFile(join(root, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { "agent-tom": STUB_ECHO_MODEL_ID } },
    })}\n`);
    const hook = bindHostSessionHook({ mode: "route", durableRoot: root, runRoot: root });
    try {
      hook({ originalSession: official, agentId: "agent-tom" });
      throw new Error("expected runtime_not_ready");
    } catch (error) {
      expect(error).toBeInstanceOf(BoxRuntimeError);
      expect(error).toMatchObject({ code: "runtime_not_ready", userVisible: true });
    }
  });
});
