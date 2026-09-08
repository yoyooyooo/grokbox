import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHostJournal,
  appendHostStreamRejected,
  appendTurnSeamTerminal,
  hostEventsPath,
} from "../src/internal/host/terminal-journal.node.ts";
import { appendEvent, appendModelStepTerminal, compactEvents, observeEvents } from "../src/internal/io/journal.node.ts";

const AT = "2026-01-01T00:00:00.000Z";
const SECRET = "sk-live-SENTINEL_SECRET";
const PROMPT = "SENTINEL_PROMPT";
const ERROR_BODY = "provider error body SENTINEL_ERROR";

async function dir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "grokbox-host-journal-"));
}

async function lines(root: string): Promise<string[]> {
  try {
    return (await readFile(hostEventsPath(root), "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const hostReject = {
  name: "host_stream_rejected" as const,
  schemaVersion: 2,
  at: AT,
  mode: "route",
  hostGenerationId: "unbound",
  agentId: "agent-tom",
  turnId: "turn-1",
  stage: "stream-id",
  errorCode: "invalid_envelope",
  reason: "missing-step-id",
  prompt: PROMPT,
  apiKey: SECRET,
  error: ERROR_BODY,
};

const turn = {
  name: "turn_seam_terminal" as const,
  at: AT,
  mode: "route",
  agentId: "agent-tom",
  assignment: "main",
  modelId: "stub/echo",
  invocationId: "inv-1",
  toolCallCount: 0,
  terminalClass: "stop",
  outcome: "managed",
};

describe("Host terminal journal roles", () => {
  test("Host append writes only Host terminal/reject events", async () => {
    const root = await dir();
    expect(await appendHostStreamRejected(root, hostReject)).toBe("written");
    expect(await appendTurnSeamTerminal(root, turn)).toBe("written");
    expect(await appendHostJournal(root, { name: "circuit_open", at: AT, reason: "budget" })).toBe("unprojected");
    expect(await appendHostJournal(root, { name: "model_step_terminal", at: AT })).toBe("unprojected");
    const rows = (await lines(root)).map((line) => JSON.parse(line) as { name: string });
    expect(rows.map((row) => row.name)).toEqual(["host_stream_rejected", "turn_seam_terminal"]);
    const text = (await lines(root)).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ERROR_BODY);
  });

  test("control and modeld writers cannot append Host events", async () => {
    const root = await dir();
    await appendEvent(root, { name: "host_stream_rejected", at: AT });
    await appendEvent(root, { name: "turn_seam_terminal", at: AT });
    expect(await appendModelStepTerminal(root, hostReject)).toBe("unprojected");
    expect(await lines(root)).toEqual([]);
    await appendEvent(root, { name: "census", at: AT, counts: { host: 1 } });
    expect((await lines(root)).map((line) => JSON.parse(line).name)).toEqual(["census"]);
  });

  test("Host append failure is write_failed and does not throw", async () => {
    const root = await dir();
    expect(await appendHostStreamRejected(root, hostReject)).toBe("written");
    const logDir = join(root, "log");
    await chmod(logDir, 0o500);
    let thrown = false;
    let result: string | undefined;
    try {
      result = await appendHostJournal(root, { ...hostReject, turnId: "turn-2" });
    } catch {
      thrown = true;
    }
    await chmod(logDir, 0o700);
    expect(thrown).toBe(false);
    expect(result).toBe("write_failed");
  });

  test("concurrent Host append and watchdog compact keep complete JSON lines", async () => {
    const root = await dir();
    await appendEvent(root, { name: "census", at: AT, counts: { host: 1 } });
    const ids = Array.from({ length: 16 }, (_, i) => `inv-h-${i}`);
    await Promise.all(ids.flatMap((id, i) => [
      appendTurnSeamTerminal(root, { ...turn, invocationId: id }),
      i % 2 === 0 ? compactEvents(root) : Promise.resolve(),
    ]));
    await compactEvents(root);
    const fileLines = await lines(root);
    for (const line of fileLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const invocations = fileLines.map((line) => JSON.parse(line) as { name?: string; invocationId?: string })
      .filter((row) => row.name === "turn_seam_terminal")
      .map((row) => row.invocationId)
      .sort();
    expect(invocations).toEqual([...ids].sort());
    expect(fileLines.some((line) => line.includes("census"))).toBe(true);
  });

  test("host_normalized_terminal round-trip keeps verified tuple fields and drops extras", async () => {
    const root = await dir();
    const full = {
      name: "host_normalized_terminal" as const,
      at: AT,
      hostId: "host-1",
      agentId: "agent-tom",
      turnId: "turn-1",
      stepId: "step-1",
      serviceEpoch: "epoch-1",
      binding: "bind-1",
      attempt: "1",
      invocationId: "inv-must-not-become-attempt",
      authorization: SECRET,
      providerError: ERROR_BODY,
      prompt: PROMPT,
    };
    expect(await appendHostJournal(root, full)).toBe("written");
    const observed = await observeEvents(root);
    expect(observed.state).toBe("present");
    expect(observed.events).toEqual([{
      name: "host_normalized_terminal",
      at: AT,
      hostId: "host-1",
      agentId: "agent-tom",
      turnId: "turn-1",
      stepId: "step-1",
      serviceEpoch: "epoch-1",
      binding: "bind-1",
      attempt: "1",
    }]);
    const text = JSON.stringify(observed);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ERROR_BODY);
    expect(text).not.toContain("inv-must-not-become-attempt");

    const missingRoot = await dir();
    expect(await appendHostJournal(missingRoot, {
      name: "host_normalized_terminal",
      at: AT,
      agentId: "agent-tom",
      turnId: "turn-1",
    })).toBe("written");
    const missing = await observeEvents(missingRoot);
    expect(missing.state).toBe("present");
    expect(missing.events).toEqual([{ name: "host_normalized_terminal", at: AT, agentId: "agent-tom", turnId: "turn-1" }]);
  });

  test("control append projects nested counts so secret objects never reach NDJSON", async () => {
    const root = await dir();
    await appendEvent(root, {
      name: "census",
      at: AT,
      counts: { host: 1, extra: { apiKey: SECRET, prompt: PROMPT, error: ERROR_BODY } },
    });
    const raw = (await lines(root)).join("\n");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(PROMPT);
    expect(raw).not.toContain(ERROR_BODY);
    expect(JSON.parse(raw)).toEqual({ name: "census", at: AT, counts: { host: 1 } });
  });

  test("unsafe Host tuple values are rejected before append; nested phase/outcome never land in NDJSON", async () => {
    const hostRoot = await dir();
    expect(await appendHostJournal(hostRoot, {
      name: "host_normalized_terminal",
      at: AT,
      hostId: "host-1",
      agentId: SECRET,
      turnId: "turn-1",
      stepId: "step-1",
      serviceEpoch: "epoch-1",
      binding: "bind-1",
      attempt: "1",
    })).toBe("unprojected");
    expect(await lines(hostRoot)).toEqual([]);

    const controlRoot = await dir();
    await appendEvent(controlRoot, {
      name: "inject_phase",
      at: AT,
      phase: { detail: { apiKey: SECRET, prompt: PROMPT, error: ERROR_BODY } },
    });
    await appendEvent(controlRoot, {
      name: "stale_patched_term",
      at: AT,
      outcome: { detail: { apiKey: SECRET, prompt: PROMPT, error: ERROR_BODY } },
    });
    const controlRaw = (await lines(controlRoot)).join("\n");
    expect(controlRaw).not.toContain(SECRET);
    expect(controlRaw).not.toContain(PROMPT);
    expect(controlRaw).not.toContain(ERROR_BODY);
    expect(JSON.parse((await lines(controlRoot))[0]!)).toEqual({ name: "inject_phase", at: AT });
    expect(JSON.parse((await lines(controlRoot))[1]!)).toEqual({ name: "stale_patched_term", at: AT });
  });

  test("compaction does not delete old durable records to invent a single-track log", async () => {
    const root = await dir();
    await appendEvent(root, { name: "census", at: AT, counts: { host: 1 } });
    await appendTurnSeamTerminal(root, turn);
    const before = await lines(root);
    await compactEvents(root);
    expect(await lines(root)).toEqual(before);
  });
});
