import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { TURN_SEAM_BOUNDED_STRING } from "../src/events.ts";
import { eventsPath } from "../src/paths.ts";
import {
  createManagedPromptSession,
  isHostPromptSession,
  type HostPromptSession,
  type PromptSession,
  type StreamPart,
} from "../src/session.ts";
import { createSessionSeam, createStubRouteDriver } from "../src/seam.ts";
import { applyPatchProfile, profileFromSource, ROUTE_SESSION_SYMBOL } from "../src/transform.ts";
import {
  consumeHandle,
  consumeHostSession,
  consumePromptSession,
  SEAM_STOP_PARTS,
  type HostSideEffectVector,
} from "./host-consumer.ts";
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
    .filter((row) => row.name === "model_step_terminal" || row.name === "host_stream_rejected");
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

  test("route seam requires a bounded modelId before admission", () => {
    const driver = createStubRouteDriver(SEAM_STOP_PARTS);
    const base = {
      mode: "route" as const,
      root: "unused-seam-admission",
      assignment: "main" as const,
      driver,
      now: () => AT,
    };
    expect(() => createSessionSeam(base)).toThrow(/bounded modelId/);
    expect(() => createSessionSeam({ ...base, modelId: "" })).toThrow(/bounded modelId/);
    expect(() => createSessionSeam({ ...base, modelId: "x".repeat(TURN_SEAM_BOUNDED_STRING + 1) })).toThrow(
      /bounded modelId/,
    );
    expect(() => createSessionSeam({ ...base, modelId: "stub/\necho" })).toThrow(/bounded modelId/);
    expect(() =>
      createSessionSeam({
        ...base,
        assignment: "official",
        modelId: "stub/echo",
      }),
    ).toThrow(/assignment=official/);
    expect(() => createSessionSeam({ ...base, modelId: "stub/echo" })).not.toThrow();
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
    }) as HostPromptSession;
    expect(managed).not.toBe(original);
    expect(isHostPromptSession(managed)).toBe(true);
    const treatment = await consumeHostSession(managed, "inv-stop");
    await seam.flush();
    expect(treatment).toEqual(control);
    expect(driver.dispatches).toBe(1);
    expect(driver.officialCalls).toBe(0);
    expect(driver.secondProviderCalls).toBe(0);
    const events = await turnLines(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      name: "model_step_terminal",
      schemaVersion: 2,
      at: AT,
      mode: "route",
      hostGenerationId: "unbound",
      agentId: "agent-tom",
      turnId: "inv-stop",
      invocationId: "inv-stop",
      modelId: "stub/echo",
      assignment: "main",
      toolCallCount: 2,
      terminalClass: "stop",
      outcome: "managed",
      stage: "host-normalize",
      admission: "none",
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
    }) as HostPromptSession;
    await consumeHostSession(errorSession, "inv-error");
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
    }) as HostPromptSession;
    const controller = new AbortController();
    controller.abort();
    abortSession.getExecutor().stream(undefined, "inv-abort", undefined, { abortSignal: controller.signal });
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
      expect.objectContaining({ name: "model_step_terminal", invocationId: "inv-error", turnId: "inv-error", terminalClass: "error", outcome: "managed", toolCallCount: 0 }),
      expect.objectContaining({ name: "model_step_terminal", invocationId: "inv-abort", turnId: "inv-abort", terminalClass: "abort", outcome: "managed" }),
    ]);
    expect(errorDriver.officialCalls + abortDriver.officialCalls + unknownDriver.officialCalls).toBe(0);
    expect(errorDriver.secondProviderCalls + abortDriver.secondProviderCalls + unknownDriver.secondProviderCalls).toBe(0);
    expect(unknownDriver.dispatches).toBe(0);
    expect(events).toHaveLength(2);
  });

  test("duplicate submit does not replay the Host side-effect vector", async () => {
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
    const first = seam.hook(args) as HostPromptSession;
    const firstVector = await consumeHostSession(first, "inv-dup");
    first.getExecutor().stream({}, "inv-dup");
    const second = seam.hook(args);
    expect(second).toBe(first);
    const secondVector = await consumeHostSession(second as HostPromptSession, "inv-dup");
    await seam.flush();
    const aggregate: HostSideEffectVector = {
      toolExecutionCount: firstVector.toolExecutionCount + secondVector.toolExecutionCount,
      finalDeliveryCount: firstVector.finalDeliveryCount + secondVector.finalDeliveryCount,
      transcriptEntryDelta: firstVector.transcriptEntryDelta + secondVector.transcriptEntryDelta,
      transcriptSequenceDelta: firstVector.transcriptSequenceDelta + secondVector.transcriptSequenceDelta,
      memoryIdDelta: firstVector.memoryIdDelta + secondVector.memoryIdDelta,
      duplicateCount: firstVector.duplicateCount + secondVector.duplicateCount,
    };
    expect(firstVector).toEqual({
      toolExecutionCount: 2,
      finalDeliveryCount: 1,
      transcriptEntryDelta: 3,
      transcriptSequenceDelta: 3,
      memoryIdDelta: 1,
      duplicateCount: 0,
    });
    expect(secondVector).toEqual({
      toolExecutionCount: 0,
      finalDeliveryCount: 0,
      transcriptEntryDelta: 0,
      transcriptSequenceDelta: 0,
      memoryIdDelta: 0,
      duplicateCount: 0,
    });
    expect(aggregate).toEqual(firstVector);
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
    }) as HostPromptSession;
    const treatment = await consumeHostSession(managed, "inv-gap");
    await seam.flush();
    expect(treatment).toEqual(control);
    expect(await turnLines(dir)).toEqual([]);
    expect(seam.evidence("inv-gap")).toEqual({ emitted: false, gap: "write_failed" });
    expect(driver.dispatches).toBe(1);
  });

  test("route Host consumer uses getModelId then getExecutor().stream; missing TURN is originalSession",
    async () => {
    const dir = await root();
    const original: PromptSession = {
      stream() {
        throw new Error("official session must not run");
      },
    };
    const driver = createStubRouteDriver(SEAM_STOP_PARTS);
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
      sessionOptions: { invocationId: "inv-host-shape", inferenceReason: "main" },
      agentId: "agent-tom",
    });
    expect(managed).not.toBe(original);
    expect(isHostPromptSession(managed)).toBe(true);
    if (!isHostPromptSession(managed)) return;
    expect(managed.getModelId().trim()).toBe("stub/echo");
    const result = managed.getExecutor({}).stream({}, "inv-host-shape", [], {});
    const response = await result.response;
    expect(response.modelId.trim()).toBe("stub/echo");
    expect(await result.extendedUsage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
    await seam.flush();
    expect(driver.dispatches).toBe(1);
    expect(driver.officialCalls).toBe(0);

    const missing = seam.hook({
      originalSession: original,
      sessionOptions: { inferenceReason: "main" },
      agentId: "agent-tom",
    });
    expect(missing).toBe(original);
    expect(driver.dispatches).toBe(1);
    expect(driver.officialCalls).toBe(0);

    const identity = createSessionSeam({ mode: "identity", root: dir, assignment: "official", now: () => AT });
    const untouched = identity.hook({
      originalSession: original,
      sessionOptions: { inferenceReason: "main" },
      agentId: "agent-tom",
    });
    expect(untouched).toBe(original);
    expect(isHostPromptSession(untouched)).toBe(false);
  });

  test("Host-shaped stream extras dispatch; Redacted content writes rejected errorCode", async () => {
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
    const original: PromptSession = { stream() { throw new Error("official session must not run"); } };
    const managed = seam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-extras", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const schema = { type: "object", properties: {} };
    await managed.getExecutor([{ role: "user", content: "ok", _privacyMode: "x", id: "m1" }]).stream(
      {},
      "inv-extras",
      [{ name: "lookup", parameters: { jsonSchema: schema }, render: () => "nope" }],
      { acceptedUnadvertisedToolNames: ["alias"] },
    ).response;
    await seam.flush();
    expect(driver.dispatches).toBe(1);
    expect(await turnLines(dir)).toEqual([expect.objectContaining({
      invocationId: "inv-extras", terminalClass: "stop", outcome: "managed",
    })]);

    class HostRedacted { constructor(readonly hidden: string) {} }
    const blocked = seam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "inv-redacted", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const failed = await blocked.getExecutor([{ role: "user", content: new HostRedacted("private-plain") }])
      .stream({}, "inv-redacted", [], { acceptedUnadvertisedToolNames: [] }).response;
    await seam.flush();
    expect(failed.error?.code).toBe("unsupported_content");
    expect(JSON.stringify(failed)).not.toContain("private-plain");
    const events = await turnLines(dir);
    expect(events).toEqual([
      expect.objectContaining({ invocationId: "inv-extras", outcome: "managed" }),
      expect.objectContaining({
        invocationId: "inv-redacted",
        terminalClass: "error",
        outcome: "rejected",
        errorCode: "unsupported_content",
      }),
    ]);
  });

  test("Host step id may differ from pinned turn id; submit splits STEP vs TURN", async () => {
    const dir = await root();
    const driver = createStubRouteDriver([
      { type: "text-delta", textDelta: "echo" },
      { type: "finish", reason: "stop" },
    ]);
    const submitted: Array<{ invocationId: string; turnId: string }> = [];
    driver.submit = async (request) => {
      submitted.push({ invocationId: request.invocationId, turnId: request.turnId });
      return { parts: [{ type: "text-delta", textDelta: "echo" }, { type: "finish", reason: "stop" }], dispatched: true };
    };
    const seam = createSessionSeam({
      mode: "route",
      root: dir,
      assignment: "main",
      modelId: "stub/echo",
      driver,
      now: () => AT,
    });
    const original: PromptSession = { stream() { throw new Error("official session must not run"); } };
    const managed = seam.hook({
      originalSession: original,
      sessionOptions: { invocationId: "turn-aaaa-bbbb-cccc-dddd", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const response = await managed.getExecutor([{ role: "user", content: "plain-step-text" }])
      .stream({}, "step-1111-2222-3333-4444", [], {}).response;
    await seam.flush();
    expect(response.error).toBeUndefined();
    expect(driver.dispatches).toBe(1);
    expect(driver.officialCalls).toBe(0);
    expect(submitted).toEqual([{
      invocationId: "step-1111-2222-3333-4444",
      turnId: "turn-aaaa-bbbb-cccc-dddd",
    }]);
    expect(await turnLines(dir)).toEqual([expect.objectContaining({
      name: "model_step_terminal",
      turnId: "turn-aaaa-bbbb-cccc-dddd",
      invocationId: "step-1111-2222-3333-4444",
      terminalClass: "stop",
      outcome: "managed",
      admission: "new",
    })]);
  });

  test("same executor STEP-2 does not collide with STEP-1 on one TURN", async () => {
    const dir = await root();
    const submitted: string[] = [];
    const driver = createStubRouteDriver([{ type: "text-delta", textDelta: "echo" }, { type: "finish", reason: "stop" }]);
    driver.submit = async (request) => {
      submitted.push(request.invocationId);
      return { parts: [{ type: "text-delta", textDelta: request.invocationId }, { type: "finish", reason: "stop" }], dispatched: true };
    };
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "main", modelId: "stub/echo", driver, now: () => AT,
    });
    const managed = seam.hook({
      originalSession: { stream() { throw new Error("official session must not run"); } },
      sessionOptions: { invocationId: "turn-multi", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const executor = managed.getExecutor([{ role: "user", content: "step-one" }]);
    expect((await executor.stream({}, "step-one", [], {}).response).error).toBeUndefined();
    executor.appendMessages({ role: "assistant", content: "echo" });
    executor.appendMessages({ role: "user", content: "step-two" });
    expect((await executor.stream({}, "step-two", [], {}).response).error).toBeUndefined();
    await seam.flush();
    expect(submitted).toEqual(["step-one", "step-two"]);
    expect(driver.dispatches).toBe(2);
    expect(await turnLines(dir)).toEqual([
      expect.objectContaining({ name: "model_step_terminal", turnId: "turn-multi", invocationId: "step-one", terminalClass: "stop" }),
      expect.objectContaining({ name: "model_step_terminal", turnId: "turn-multi", invocationId: "step-two", terminalClass: "stop" }),
    ]);
  });

  test("omitted and illegal STEP reject without falling back to TURN", async () => {
    const dir = await root();
    const driver = createStubRouteDriver([{ type: "text-delta", textDelta: "echo" }, { type: "finish", reason: "stop" }]);
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "main", modelId: "stub/echo", driver, now: () => AT,
    });
    const managed = seam.hook({
      originalSession: { stream() { throw new Error("official session must not run"); } },
      sessionOptions: { invocationId: "turn-missing-step", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const omitted = await managed.getExecutor([{ role: "user", content: "plain" }]).stream({}, undefined, [], {}).response;
    const illegal = await managed.getExecutor([{ role: "user", content: "plain" }]).stream({}, "step\nid", [], {}).response;
    await seam.flush();
    expect(omitted.error?.code).toBe("invalid_envelope");
    expect(illegal.error?.code).toBe("invalid_envelope");
    expect(driver.dispatches).toBe(0);
    expect(await turnLines(dir)).toEqual([
      expect.objectContaining({ name: "host_stream_rejected", turnId: "turn-missing-step", reason: "missing-step-id", errorCode: "invalid_envelope" }),
      expect.objectContaining({ name: "host_stream_rejected", turnId: "turn-missing-step", reason: "invalid-step-id", errorCode: "invalid_envelope" }),
    ]);
    expect(JSON.stringify(await turnLines(dir))).not.toContain("step\\nid");
  });

  test("duplicate STEP is idle; changed payload conflicts; rejected STEP cannot revive after latch/clear", async () => {
    const dir = await root();
    const driver = createStubRouteDriver([{ type: "text-delta", textDelta: "echo" }, { type: "finish", reason: "stop" }]);
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "main", modelId: "stub/echo", driver, now: () => AT,
    });
    const managed = seam.hook({
      originalSession: { stream() { throw new Error("official session must not run"); } },
      sessionOptions: { invocationId: "turn-latch", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const executor = managed.getExecutor([{ role: "user", content: "ok" }]);
    const first = await consumeHandle(executor.stream({}, "step-ok", [], {}));
    const idle = await consumeHandle(executor.stream({}, "step-ok", [], {}));
    executor.appendMessages({ role: "user", content: "changed" });
    const conflict = await executor.stream({}, "step-ok", [], {}).response;
    expect(first).toEqual({ toolExecutionCount: 0, finalDeliveryCount: 1, transcriptEntryDelta: 1, transcriptSequenceDelta: 1, memoryIdDelta: 0, duplicateCount: 0 });
    expect(idle).toEqual({ toolExecutionCount: 0, finalDeliveryCount: 0, transcriptEntryDelta: 0, transcriptSequenceDelta: 0, memoryIdDelta: 0, duplicateCount: 0 });
    expect(conflict.error?.code).toBe("invocation_conflict");
    expect(driver.dispatches).toBe(1);

    const broken = managed.getExecutor([{ role: "user", content: { nested: "private-latch" } }]);
    expect((await broken.stream({}, "step-bad", [], {}).response).error?.code).toBe("unsupported_content");
    broken.clearMessages();
    broken.appendMessages({ role: "user", content: "repaired" });
    expect((await broken.stream({}, "step-bad", [], {}).response).error?.code).toBe("invocation_conflict");

    const latched = managed.getExecutor({ transcript: "private-state" });
    expect(latched.getState()).toEqual([]);
    latched.appendMessages({ role: "user", content: "ignored-after-latch" });
    expect(latched.getMessages()).toEqual([]);
    expect((await latched.stream({}, "step-latched", [], {}).response).error?.code).toBe("invalid_envelope");
    await seam.flush();
    expect(driver.dispatches).toBe(1);
    const events = await turnLines(dir);
    expect(events.filter((row) => row.invocationId === "step-ok")).toHaveLength(1);
    expect(events.filter((row) => row.invocationId === "step-bad")).toEqual([
      expect.objectContaining({ name: "model_step_terminal", invocationId: "step-bad", outcome: "rejected", errorCode: "unsupported_content" }),
    ]);
  });

  test("STEP-1 abort does not cancel STEP-2 on the same executor", async () => {
    const dir = await root();
    const started: string[] = [];
    const driver = createStubRouteDriver([]);
    driver.delivery = "stream";
    driver.stream = (request) => ({
      async *[Symbol.asyncIterator]() {
        started.push(request.invocationId);
        if (request.invocationId === "step-s1") {
          await new Promise<void>((resolve) => {
            if (request.abortSignal?.aborted) { resolve(); return; }
            request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield { type: "text-delta" as const, textDelta: "s2-ok" };
        yield { type: "finish" as const, reason: "stop" as const };
      },
    });
    const seam = createSessionSeam({
      mode: "route", root: dir, assignment: "main", modelId: "stub/echo", driver, now: () => AT,
    });
    const managed = seam.hook({
      originalSession: { stream() { throw new Error("official session must not run"); } },
      sessionOptions: { invocationId: "turn-isolate", inferenceReason: "main" },
      agentId: "agent-tom",
    }) as HostPromptSession;
    const executor = managed.getExecutor([{ role: "user", content: "plain" }]);
    const s1Abort = new AbortController();
    const s1 = executor.stream({ abortSignal: s1Abort.signal }, "step-s1", [], {});
    const s2 = executor.stream({}, "step-s2", [], {});
    const deadline = Date.now() + 2000;
    while (started.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started.sort()).toEqual(["step-s1", "step-s2"]);
    s1Abort.abort();
    expect((await s1.response).finishReason).toBe("abort");
    expect((await s2.response).error).toBeUndefined();
    expect((await s2.response).messages).toEqual([{ role: "assistant", content: [{ type: "text", text: "s2-ok" }] }]);
    await seam.flush();
    expect(driver.dispatches).toBe(2);
    const events = await turnLines(dir);
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "model_step_terminal", invocationId: "step-s2", terminalClass: "stop", turnId: "turn-isolate" }),
      expect.objectContaining({ name: "model_step_terminal", invocationId: "step-s1", terminalClass: "abort", turnId: "turn-isolate" }),
    ]));
  });
});
