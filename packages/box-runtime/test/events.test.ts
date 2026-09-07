import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWatchdogTick } from "../src/coordinator.ts";
import {
  appendEvent,
  appendHostStreamRejected,
  appendModelStepTerminal,
  appendTurnSeamTerminal,
  compactEvents,
  CONTROL_PLANE_EVENT_RETENTION,
  projectHostStreamRejected,
  projectModelStepTerminal,
  projectTurnSeamTerminal,
  sanitizeEvent,
  TURN_SEAM_BOUNDED_STRING,
  TURN_SEAM_TERMINAL_RETENTION,
} from "../src/events.ts";
import { eventsPath } from "../src/paths.ts";
import { FakeProcessTree } from "./fake-tree.ts";

const AT = "2026-01-01T00:00:00.000Z";

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "grokbox-events-"));
}

async function linesOf(dir: string): Promise<string[]> {
  try {
    return (await readFile(eventsPath(dir), "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function parsed(dirLines: string[]): Array<Record<string, unknown>> {
  return dirLines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function turnEvent(invocationId: string, extra: Record<string, unknown> = {}) {
  return {
    name: "turn_seam_terminal" as const,
    at: AT,
    mode: "route",
    agentId: "agent-tom",
    assignment: "main",
    modelId: "stub/echo",
    invocationId,
    toolCallCount: 2,
    terminalClass: "stop",
    outcome: "managed",
    ...extra,
  };
}

describe("control-plane event projector", () => {
  test("keeps nested counts and sha, and still drops forbidden keys", () => {
    const census = sanitizeEvent({
      name: "census",
      at: AT,
      sha: "abc",
      counts: { wrapper: 1, supervisor: 1, host: 1 },
      prompt: "SENTINEL_PROMPT",
      agentId: "agent-tom",
      invocationId: "inv-1",
    });
    expect(census.sha).toBe("abc");
    expect(census.counts).toEqual({ wrapper: 1, supervisor: 1, host: 1 });
    expect(census).not.toHaveProperty("prompt");
    expect(census).not.toHaveProperty("agentId");
    expect(census).not.toHaveProperty("invocationId");
  });
});

describe("turn_seam_terminal projector", () => {
  test("keeps only bounded scalars and drops sentinel bodies", () => {
    const projected = projectTurnSeamTerminal({
      ...turnEvent("inv-1"),
      prompt: "SENTINEL_PROMPT",
      token: "SENTINEL_TOKEN",
      apiKey: "SENTINEL_CRED",
      providerError: { body: "SENTINEL_PROVIDER_ERROR" },
      tool: { name: "bash", args: { command: "SENTINEL_TOOL" } },
      transcript: "SENTINEL_TRANSCRIPT",
      memory: "SENTINEL_MEMORY",
      delivery: "SENTINEL_DELIVERY",
      payload: { nested: true },
      metadata: { x: 1 },
      counts: { tools: 2 },
      sha: "deadbeef",
    });
    expect(projected).toEqual({
      name: "turn_seam_terminal",
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      assignment: "main",
      modelId: "stub/echo",
      invocationId: "inv-1",
      toolCallCount: 2,
      terminalClass: "stop",
      outcome: "managed",
    });
    const text = JSON.stringify(projected);
    expect(text).not.toMatch(/SENTINEL_|prompt|token|secret|apiKey|transcript|memory|delivery|payload|metadata/i);
    expect(text).not.toContain("deadbeef");
    expect(text).not.toContain("counts");
    for (const value of Object.values(projected ?? {})) {
      expect(value === null || ["string", "number"].includes(typeof value)).toBe(true);
    }
  });

  test("keeps bounded errorCode on rejected terminals and drops unknown codes", () => {
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-rej"),
        terminalClass: "error",
        outcome: "rejected",
        errorCode: "unsupported_options",
        prompt: "SENTINEL_PROMPT",
      }),
    ).toMatchObject({ outcome: "rejected", errorCode: "unsupported_options" });
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-rej-unknown"),
        terminalClass: "error",
        outcome: "rejected",
        errorCode: "not-a-code",
      }),
    ).toEqual({
      name: "turn_seam_terminal",
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      assignment: "main",
      modelId: "stub/echo",
      invocationId: "inv-rej-unknown",
      toolCallCount: 2,
      terminalClass: "error",
      outcome: "rejected",
    });
  });

  test("omits modelId for official execution and rejects invalid required fields", () => {
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-off"),
        mode: "identity",
        assignment: "official",
        modelId: "stub/echo",
        outcome: "official",
      }),
    ).toMatchObject({ assignment: "official", outcome: "official" });
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-off"),
        mode: "identity",
        assignment: "official",
      })?.modelId,
    ).toBeUndefined();
    const { modelId: _officialModel, ...officialWithoutModel } = {
      ...turnEvent("inv-official-omit"),
      mode: "identity" as const,
      assignment: "official" as const,
      outcome: "official" as const,
    };
    expect(projectTurnSeamTerminal(officialWithoutModel)).toMatchObject({
      assignment: "official",
      outcome: "official",
    });
    expect(projectTurnSeamTerminal(officialWithoutModel)).not.toHaveProperty("modelId");
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-last-resort"),
        outcome: "last_resort_official",
      }),
    ).toMatchObject({ assignment: "main", outcome: "last_resort_official" });
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-last-resort"),
        outcome: "last_resort_official",
      }),
    ).not.toHaveProperty("modelId");
    const { modelId: _officialManagedModel, ...officialManaged } = {
      ...turnEvent("inv-official-managed"),
      assignment: "official" as const,
      outcome: "managed" as const,
    };
    expect(projectTurnSeamTerminal(officialManaged)).toBeNull();
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-official-managed-with-id"),
        assignment: "official",
        outcome: "managed",
        modelId: "stub/echo",
      }),
    ).toBeNull();
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-route-official"),
        assignment: "official",
        outcome: "official",
      }),
    ).toBeNull();
    const { modelId: _mainModel, ...mainWithoutModel } = turnEvent("inv-main-missing");
    expect(projectTurnSeamTerminal(mainWithoutModel)).toBeNull();
    const { modelId: _rejectedModel, ...rejectedWithoutModel } = {
      ...turnEvent("inv-rejected"),
      outcome: "rejected" as const,
      terminalClass: "error" as const,
      toolCallCount: 0,
    };
    expect(projectTurnSeamTerminal(rejectedWithoutModel)).toBeNull();
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-rejected-ok"),
        outcome: "rejected",
        terminalClass: "error",
        toolCallCount: 0,
      }),
    ).toMatchObject({ outcome: "rejected", assignment: "main", modelId: "stub/echo" });
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-agent-missing"), assignment: "agent", modelId: undefined })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-main-empty"), modelId: "" })).toBeNull();
    expect(
      projectTurnSeamTerminal({
        ...turnEvent("inv-main-oversize"),
        modelId: "x".repeat(TURN_SEAM_BOUNDED_STRING + 1),
      }),
    ).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-main-type"), modelId: 1 })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-main-nested"), modelId: { id: "nested" } })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), mode: "other" })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), terminalClass: "crash" })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), outcome: "success" })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), toolCallCount: -1 })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), toolCallCount: 1.5 })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), toolCallCount: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), toolCallCount: Number.NaN })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), agentId: "x".repeat(TURN_SEAM_BOUNDED_STRING + 1) })).toBeNull();
    expect(projectTurnSeamTerminal({ ...turnEvent("inv-bad"), invocationId: { id: "nested" } })).toBeNull();
    expect(projectTurnSeamTerminal({ name: "census", at: AT })).toBeNull();
  });
});

describe("model_step_terminal and host_stream_rejected projectors", () => {
  const stepEvent = {
    name: "model_step_terminal" as const,
    schemaVersion: 2,
    at: AT,
    mode: "route" as const,
    hostGenerationId: "unbound",
    agentId: "agent-tom",
    turnId: "turn-1",
    invocationId: "step-1",
    modelId: "stub/echo",
    assignment: "main" as const,
    terminalClass: "stop" as const,
    outcome: "managed" as const,
    toolCallCount: 0,
    stage: "host-normalize" as const,
    admission: "none" as const,
  };

  test("keeps bounded STEP fields and drops prompt bodies", () => {
    expect(projectModelStepTerminal({ ...stepEvent, prompt: "SENTINEL_PROMPT", invocationId: "step-1" })).toEqual(stepEvent);
    expect(projectModelStepTerminal({ ...stepEvent, schemaVersion: 1 })).toBeNull();
    expect(projectModelStepTerminal({ ...stepEvent, mode: "identity" })).toBeNull();
    expect(projectModelStepTerminal({ ...stepEvent, assignment: "official" })).toBeNull();
    expect(projectModelStepTerminal({ ...stepEvent, stage: "custom" })).toBeNull();
  });

  test("host_stream_rejected never stores the illegal STEP value", () => {
    expect(projectHostStreamRejected({
      name: "host_stream_rejected",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      hostGenerationId: "unbound",
      agentId: "agent-tom",
      turnId: "turn-1",
      stage: "stream-id",
      errorCode: "invalid_envelope",
      reason: "invalid-step-id",
      invocationId: "step\nid",
    })).toEqual({
      name: "host_stream_rejected",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      hostGenerationId: "unbound",
      agentId: "agent-tom",
      turnId: "turn-1",
      stage: "stream-id",
      errorCode: "invalid_envelope",
      reason: "invalid-step-id",
    });
    expect(projectHostStreamRejected({ name: "host_stream_rejected", schemaVersion: 2, at: AT })).toBeNull();
  });

  test("generic control append cannot write the new seam events", async () => {
    const dir = await root();
    await appendEvent(dir, { name: "model_step_terminal", at: AT });
    await appendEvent(dir, { name: "host_stream_rejected", at: AT });
    expect(await linesOf(dir)).toEqual([]);
    expect(await appendModelStepTerminal(dir, stepEvent)).toBe("written");
    expect(await appendHostStreamRejected(dir, {
      name: "host_stream_rejected", schemaVersion: 2, at: AT, mode: "route", hostGenerationId: "unbound",
      agentId: "agent-tom", turnId: "turn-1", stage: "stream-id", errorCode: "invalid_envelope", reason: "missing-step-id",
    })).toBe("written");
    expect(parsed(await linesOf(dir)).map((row) => row.name)).toEqual(["model_step_terminal", "host_stream_rejected"]);
  });
});

describe("append-only host journal and watchdog compaction", () => {
  test("control-plane append does not slice, and does not write turn_seam_terminal", async () => {
    const dir = await root();
    for (let i = 0; i < 300; i += 1) {
      await appendEvent(dir, { name: "disk_sha_observed", at: AT, sha: `sha-${i}` });
    }
    expect(await linesOf(dir)).toHaveLength(300);
    await appendEvent(dir, turnEvent("inv-should-drop") as never);
    expect(await linesOf(dir)).toHaveLength(300);
    const file = await stat(eventsPath(dir));
    const logDir = await stat(dirname(eventsPath(dir)));
    expect(file.mode & 0o777).toBe(0o600);
    expect(logDir.mode & 0o777).toBe(0o700);
  });

  test("watchdog compaction retains inject/census and terminals independently", async () => {
    const dir = await root();
    await appendEvent(dir, { name: "inject_phase", at: AT, phase: "stop" });
    await appendEvent(dir, { name: "census", at: AT, counts: { host: 1 } });
    for (let i = 0; i < TURN_SEAM_TERMINAL_RETENTION + 1; i += 1) {
      expect(await appendTurnSeamTerminal(dir, turnEvent(`inv-old-${i}`))).toBe("written");
    }
    await compactEvents(dir);
    let rows = parsed(await linesOf(dir));
    expect(rows.some((row) => row.name === "inject_phase")).toBe(true);
    expect(rows.some((row) => row.name === "census")).toBe(true);
    const turns = rows.filter((row) => row.name === "turn_seam_terminal");
    expect(turns).toHaveLength(TURN_SEAM_TERMINAL_RETENTION);
    expect(turns[0]?.invocationId).toBe("inv-old-1");
    expect(turns.at(-1)?.invocationId).toBe(`inv-old-${TURN_SEAM_TERMINAL_RETENTION}`);

    await appendTurnSeamTerminal(dir, turnEvent("inv-recent"));
    for (let i = 0; i < CONTROL_PLANE_EVENT_RETENTION + 1; i += 1) {
      await appendEvent(dir, { name: "disk_sha_observed", at: AT, sha: `flood-${i}` });
    }
    await compactEvents(dir);
    rows = parsed(await linesOf(dir));
    const control = rows.filter((row) => row.name !== "turn_seam_terminal");
    const keptTurns = rows.filter((row) => row.name === "turn_seam_terminal");
    expect(control).toHaveLength(CONTROL_PLANE_EVENT_RETENTION);
    expect(control.some((row) => row.name === "inject_phase")).toBe(false);
    expect(control.at(-1)).toMatchObject({ name: "disk_sha_observed", sha: `flood-${CONTROL_PLANE_EVENT_RETENTION}` });
    expect(keptTurns.some((row) => row.invocationId === "inv-recent")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/SENTINEL_|fixture-memory-body|fixture-final-response/);
  });

  test("host append concurrent with watchdog compact is not lost, duplicated, or partial", async () => {
    const dir = await root();
    for (let i = 0; i < 40; i += 1) {
      await appendEvent(dir, { name: "inject_phase", at: AT, phase: `p-${i}` });
    }
    const ids = Array.from({ length: 24 }, (_, i) => `inv-race-${i}`);
    await Promise.all(
      ids.flatMap((id, i) => [
        appendTurnSeamTerminal(dir, turnEvent(id)),
        i % 2 === 0 ? compactEvents(dir) : Promise.resolve(),
      ]),
    );
    await compactEvents(dir);
    const fileLines = await linesOf(dir);
    for (const line of fileLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.includes("\n")).toBe(false);
    }
    const rows = parsed(fileLines);
    const invocationIds = rows
      .filter((row) => row.name === "turn_seam_terminal")
      .map((row) => row.invocationId);
    expect(invocationIds.sort()).toEqual([...ids].sort());
    expect(new Set(invocationIds).size).toBe(ids.length);
    expect(rows.some((row) => row.name === "inject_phase")).toBe(true);
  });

  test("runWatchdogTick composition root compacts control-plane and terminals independently", async () => {
    const dir = await root();
    const ephemeralRoot = await mkdtemp(join(tmpdir(), "grokbox-wd-eph-"));
    const tree = new FakeProcessTree();
    const extra = 20;
    for (let i = 0; i < CONTROL_PLANE_EVENT_RETENTION + extra; i += 1) {
      await appendEvent(dir, { name: "disk_sha_observed", at: AT, sha: `sha-${i}` });
    }
    for (let i = 0; i < TURN_SEAM_TERMINAL_RETENTION + extra; i += 1) {
      expect(await appendTurnSeamTerminal(dir, turnEvent(`inv-tick-${i}`))).toBe("written");
    }
    expect(await linesOf(dir)).toHaveLength(
      CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION + extra * 2,
    );

    const result = await runWatchdogTick({
      root: dir,
      desired: { version: 1, mode: "observe" },
      models: { version: 1, models: {}, assignments: { main: null, agents: {} } },
      processes: tree,
      classify: () => null,
      ephemeralRoot,
      diskSha: "sha-reviewed",
      now: () => 10,
      isoNow: () => AT,
    });
    expect(result.injected).toBe(false);
    expect(result.signaled).toBe(false);
    expect(tree.signals).toEqual([]);

    const rows = parsed(await linesOf(dir));
    const control = rows.filter((row) => row.name !== "turn_seam_terminal");
    const turns = rows.filter((row) => row.name === "turn_seam_terminal");
    expect(rows.length).toBeLessThanOrEqual(CONTROL_PLANE_EVENT_RETENTION + TURN_SEAM_TERMINAL_RETENTION);
    expect(control.length).toBeLessThanOrEqual(CONTROL_PLANE_EVENT_RETENTION);
    expect(turns.length).toBeLessThanOrEqual(TURN_SEAM_TERMINAL_RETENTION);
    expect(control.at(-1)).toMatchObject({
      name: "disk_sha_observed",
      sha: `sha-${CONTROL_PLANE_EVENT_RETENTION + extra - 1}`,
    });
    expect(turns.at(-1)).toMatchObject({
      invocationId: `inv-tick-${TURN_SEAM_TERMINAL_RETENTION + extra - 1}`,
    });
  });
});
