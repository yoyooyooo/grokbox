import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { eventsPath } from "../src/paths.ts";
import { createManagedPromptSession, type PromptSession, type StreamPart } from "../src/session.ts";
import { createSessionSeam, createStubRouteDriver } from "../src/seam.ts";
import { applyPatchProfile, profileFromSource, ROUTE_SESSION_SYMBOL } from "../src/transform.ts";
import { consumePromptSession, SEAM_STOP_PARTS } from "./host-consumer.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

const AT = "2026-01-01T00:00:00.000Z";

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "grokbox-seam-"));
}

async function turnLines(dir: string): Promise<Array<Record<string, unknown>>> {
  let text = "";
  try {
    text = await readFile(eventsPath(dir), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.name === "turn_seam_terminal");
}

function officialSession(parts: StreamPart[] = SEAM_STOP_PARTS): PromptSession {
  return createManagedPromptSession({
    modelId: "official-main",
    vision: false,
    parallel: "allow",
    parts,
  });
}

describe("turn seam identity vs route", () => {
  test("identity returns originalSession by object identity and writes no seam event", async () => {
    const dir = await root();
    const original = officialSession();
    const seam = createSessionSeam({
      mode: "identity",
      root: dir,
      assignment: "official",
      now: () => AT,
    });
    const returned = seam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-id", agentId: "agent-tom" },
      agentId: "agent-tom",
    });
    expect(returned).toBe(original);
    expect(returned).not.toBe(new Proxy(original, {}));
    const vector = await consumePromptSession(returned as PromptSession);
    await seam.flush();
    expect(vector).toEqual({
      toolExecutionCount: 2,
      finalDeliveryCount: 1,
      transcriptEntryDelta: 3,
      transcriptSequenceDelta: 3,
      memoryIdDelta: 1,
      duplicateCount: 0,
    });
    expect(await turnLines(dir)).toEqual([]);

    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const transformed = applyPatchProfile(SYNTHETIC_HOST, profile);
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) return;
    const module = {
      exports: {} as { runTurn: (host: { getConversationId: () => string }) => { kind: string } },
    };
    const calls: object[] = [];
    const sandbox = createContext({
      module,
      exports: module.exports,
      Symbol,
      hook(args: { originalSession: object }) {
        const untouched = seam.hook({
          originalSession: args.originalSession,
          sessionOptions: { invocationId: "inv-synth" },
          agentId: "agent-tom",
        });
        calls.push(args.originalSession);
        return untouched;
      },
    });
    runInContext(`globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")] = hook;\n${transformed.source}`, sandbox);
    const session = module.exports.runTurn({ getConversationId: () => "agent-tom" });
    expect(session.kind).toBe("official-session");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(session);
    await seam.flush();
    expect(await turnLines(dir)).toEqual([]);
  });

  test("route stop matches the identity Host vector and writes one managed terminal", async () => {
    const dir = await root();
    const original = officialSession();
    const identity = createSessionSeam({ mode: "identity", root: dir, assignment: "official", now: () => AT });
    const identitySession = identity.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-stop" },
      agentId: "agent-tom",
    }) as PromptSession;
    const control = await consumePromptSession(identitySession);

    const driver = createStubRouteDriver(SEAM_STOP_PARTS);
    expect(() => driver.resolveCredential()).toThrow(/credential/);
    expect(() => driver.openNetwork()).toThrow(/network/);
    const seam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver,
      now: () => AT,
    });
    const managed = seam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-stop" },
      agentId: "agent-tom",
    }) as PromptSession;
    expect(managed).not.toBe(original);
    const treatment = await consumePromptSession(managed);
    await seam.flush();
    expect(treatment).toEqual(control);
    expect(driver.dispatches).toBe(1);
    expect(driver.officialCalls).toBe(0);
    expect(driver.secondProviderCalls).toBe(0);
    const events = await turnLines(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      name: "turn_seam_terminal",
      at: AT,
      mode: "route",
      agentId: "agent-tom",
      assignment: "main",
      modelId: "stub/echo",
      invocationId: "inv-stop",
      toolCallCount: 2,
      terminalClass: "stop",
      outcome: "managed",
    });
    expect(JSON.stringify(events)).not.toMatch(/fixture-memory-body|fixture-final-response|true/);
  });

  test("route error, abort, and unknown each write one classified line and never call official", async () => {
    const dir = await root();
    const original: PromptSession = {
      stream() {
        throw new Error("official session must not run");
      },
    };

    const errorDriver = createStubRouteDriver([{ type: "finish", reason: "error" }]);
    const errorSeam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver: errorDriver,
      now: () => AT,
    });
    const errorSession = errorSeam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-error" },
      agentId: "agent-tom",
    }) as PromptSession;
    await consumePromptSession(errorSession);
    await errorSeam.flush();

    const abortDriver = createStubRouteDriver(SEAM_STOP_PARTS);
    const abortSeam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver: abortDriver,
      now: () => AT,
    });
    const abortSession = abortSeam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-abort" },
      agentId: "agent-tom",
    }) as PromptSession;
    const controller = new AbortController();
    controller.abort();
    abortSession.stream({ abortSignal: controller.signal });
    await abortSeam.flush();

    const unknownDriver = createStubRouteDriver(SEAM_STOP_PARTS);
    const unknownSeam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver: unknownDriver,
      now: () => AT,
    });
    unknownSeam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-unknown" },
      agentId: "agent-tom",
    });
    await unknownSeam.disconnect("inv-unknown");

    const events = await turnLines(dir);
    expect(events).toEqual([
      expect.objectContaining({ invocationId: "inv-error", terminalClass: "error", outcome: "managed", toolCallCount: 0 }),
      expect.objectContaining({ invocationId: "inv-abort", terminalClass: "abort", outcome: "managed" }),
      expect.objectContaining({ invocationId: "inv-unknown", terminalClass: "unknown", outcome: "managed", toolCallCount: 0 }),
    ]);
    expect(errorDriver.officialCalls + abortDriver.officialCalls + unknownDriver.officialCalls).toBe(0);
    expect(errorDriver.secondProviderCalls + abortDriver.secondProviderCalls + unknownDriver.secondProviderCalls).toBe(0);
    expect(unknownDriver.dispatches).toBe(0);
    expect(events).toHaveLength(3);
  });

  test("duplicate submit does not dispatch or emit a second terminal line", async () => {
    const dir = await root();
    const driver = createStubRouteDriver(SEAM_STOP_PARTS);
    const seam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver,
      now: () => AT,
    });
    const args = {
      originalSession: officialSession(),
      sessionOptions: { invocationId: "inv-dup" },
      agentId: "agent-tom",
    };
    const first = seam.hook(args) as PromptSession;
    await consumePromptSession(first);
    first.stream();
    const second = seam.hook(args);
    expect(second).toBe(first);
    await consumePromptSession(second as PromptSession);
    await seam.flush();
    expect(driver.dispatches).toBe(1);
    expect(await turnLines(dir)).toHaveLength(1);
  });

  test("append failure is an evidence gap and does not change the Host vector", async () => {
    const dir = await root();
    const original = officialSession();
    const control = await consumePromptSession(original);
    const driver = createStubRouteDriver(SEAM_STOP_PARTS);
    const seam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver,
      now: () => AT,
      writeTerminal: async () => {
        throw new Error("disk full");
      },
    });
    const managed = seam.hook({
      originalSession: officialSession(),
      sessionOptions: { invocationId: "inv-gap" },
      agentId: "agent-tom",
    }) as PromptSession;
    const treatment = await consumePromptSession(managed);
    await seam.flush();
    expect(treatment).toEqual(control);
    expect(await turnLines(dir)).toEqual([]);
    expect(seam.evidence("inv-gap")).toEqual({ emitted: false, gap: "write_failed" });
    expect(driver.dispatches).toBe(1);
  });
});
