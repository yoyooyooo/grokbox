import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIRE_VERSION, contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import {
  asHostPromptSession,
  createStreamingPromptSession,
} from "../src/internal/host/session.ts";
import {
  bindHostCompactHook,
  compactControlMatchesInFlight,
  requestHostCompact,
  resetHostCompactSlotForTests,
  resumeStepFrameForCompactRequest,
  stateSystemCompactHookOptions,
  type CompactControlIdentity,
  type CompactInFlight,
} from "../src/internal/host/compact.ts";
import { requestModeld, streamModeld } from "../src/internal/host/modeld-client.node.ts";
import { decodeModeldFrame, encodeModeldFrame, parseV4ControlFrame } from "../src/internal/wire/modeld-wire.ts";

const TUPLE: CompactInFlight = {
  agentId: "agent-a",
  turnId: "turn-1",
  stepId: "step-1",
  selectionRevision: "rev-a",
  bindingId: "bind-1",
};

const NONCE = "n".repeat(32);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function rootState(text = "compacted") {
  return [
    { role: "system", content: "root-from-state" },
    { role: "user", content: text },
  ];
}

function control(overrides: Partial<CompactControlIdentity> = {}): CompactControlIdentity {
  return {
    agentId: TUPLE.agentId,
    turnId: TUPLE.turnId,
    stepId: TUPLE.stepId,
    bindingId: TUPLE.bindingId!,
    selectionRevision: TUPLE.selectionRevision,
    recoveryNonce: NONCE,
    ...overrides,
  };
}

function runStepBody() {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "t21-state-root",
    abiIdentity: "host-abi-v1",
    systemMessages: [{ role: "system", content: "root-from-state" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    options: {},
  });
  const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
  return {
    version: WIRE_VERSION,
    method: "run-step",
    hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: `v${WIRE_VERSION}` },
    serviceEpoch: { incarnationId: "00000000-0000-4000-8000-000000000001" },
    agentId: TUPLE.agentId,
    turnId: TUPLE.turnId,
    stepId: TUPLE.stepId,
    selection: { agentId: TUPLE.agentId, modelId: "openai/gpt", selectionRevision: TUPLE.selectionRevision },
    snapshot,
  };
}

function registerSlot(text = "compacted") {
  return registerSlotWith({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" }, text);
}

function registerSlotWith(options: { profileId?: string; abiIdentity?: string } | undefined, text = "compacted") {
  const hook = bindHostCompactHook(options);
  const counts = { compact: 0, stream: 0 };
  hook({
    orchestrator: {
      handleSummarization: async () => {
        counts.compact += 1;
        return "summary";
      },
    },
    ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
    stateHandler: { backgroundSummarizationPromiseInfo: null },
    rootPromptExecutor: { getState: () => rootState(text) },
    interactionListener: {},
    config: {},
    requestContext: {},
    invocationId: TUPLE.stepId,
    turnId: TUPLE.turnId,
    agentId: TUPLE.agentId,
    resourceAccessor: {},
    stepClosed: () => false,
  });
  return counts;
}

async function readOne(socket: Socket, buf: { current: Buffer }): Promise<unknown> {
  while (true) {
    const decoded = decodeModeldFrame(buf.current);
    if (decoded && "error" in decoded) throw new Error(decoded.error);
    if (decoded) {
      buf.current = Buffer.from(decoded.rest);
      return decoded.value;
    }
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      const onData = (data: Buffer) => {
        socket.off("error", onError);
        resolve(data);
      };
      const onError = (error: Error) => {
        socket.off("data", onData);
        reject(error);
      };
      socket.once("data", onData);
      socket.once("error", onError);
    });
    buf.current = Buffer.concat([buf.current, chunk]);
  }
}

async function withPeer(
  script: (socket: Socket, seen: { runSteps: number; resumes: unknown[] }) => Promise<void>,
  fn: (runRoot: string, seen: { runSteps: number; resumes: unknown[] }) => Promise<void>,
): Promise<void> {
  const runRoot = await mkdtemp(join(tmpdir(), "grokbox-host-cf-"));
  const path = join(runRoot, "modeld.sock");
  const seen = { runSteps: 0, resumes: [] as unknown[] };
  const server = createServer((socket) => {
    void script(socket, seen).catch(() => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    await fn(runRoot, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function acceptedThenCompact(
  socket: Socket,
  seen: { runSteps: number; resumes: unknown[] },
  compactOverrides: Partial<CompactControlIdentity> = {},
  afterResume: "terminal" | "hang" = "terminal",
): Promise<void> {
  const buf = { current: Buffer.alloc(0) };
  const first = await readOne(socket, buf);
  const record = first && typeof first === "object" ? first as { method?: string } : {};
  if (record.method === "run-step") seen.runSteps += 1;
  socket.write(encodeModeldFrame({
    ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: TUPLE.bindingId,
  }));
  socket.write(encodeModeldFrame({
    version: 4,
    method: "compact-request",
    ...control(compactOverrides),
    deadlineMs: 5_000,
  }));
  if (afterResume === "hang") return;
  const resume = await readOne(socket, buf);
  seen.resumes.push(resume);
  socket.write(encodeModeldFrame({
    kind: "terminal", outcome: "ok", bindingId: TUPLE.bindingId, finishReason: "stop", version: WIRE_VERSION,
  }));
}

afterEach(() => {
  resetHostCompactSlotForTests();
});

describe("Host compact-request → resume-step", () => {
  test("tuple/nonce must match the in-flight run-step", () => {
    expect(compactControlMatchesInFlight(control(), TUPLE)).toBe(true);
    expect(compactControlMatchesInFlight(control({ recoveryNonce: "" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control({ stepId: "other-step" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control({ turnId: "other-turn" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control({ agentId: "other-agent" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control({ selectionRevision: "other-rev" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control({ bindingId: "other-bind" }), TUPLE)).toBe(false);
    expect(compactControlMatchesInFlight(control(), undefined)).toBe(false);
  });

  test("good compact-request resumes with D2 snapshot and echoed nonce", async () => {
    registerSlot("after-compact");
    const resume = await resumeStepFrameForCompactRequest(control(), TUPLE);
    expect(resume).toBeDefined();
    expect(resume?.method).toBe("resume-step");
    expect(resume?.recoveryNonce).toBe(NONCE);
    expect(resume?.stepId).toBe(TUPLE.stepId);
    expect(resume?.snapshot.messages).toEqual([{ role: "user", content: "after-compact" }]);
    const parsed = parseV4ControlFrame(resume);
    expect(parsed.method).toBe("resume-step");
    if (parsed.method === "resume-step") expect(parsed.recoveryNonce).toBe(NONCE);
  });

  test("wrong nonce/tuple never invents a resume-step", async () => {
    registerSlot();
    expect(await resumeStepFrameForCompactRequest(control({ recoveryNonce: "" }), TUPLE)).toBeUndefined();
    expect(await resumeStepFrameForCompactRequest(control({ stepId: "step-other" }), TUPLE)).toBeUndefined();
    expect(await requestHostCompact({
      tuple: { ...TUPLE, bindingId: TUPLE.bindingId!, stepId: "step-other" },
      recoveryNonce: NONCE,
    })).toEqual({ kind: "unavailable", reason: "capability_not_ready" });
  });

  test("streamModeld accepts a matching compact-request and does not yield it as a STEP event", async () => {
    const counts = registerSlot("via-socket");
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen),
      async (runRoot, seen) => {
        const frames: unknown[] = [];
        for await (const frame of streamModeld(runRoot, runStepBody(), { timeoutMs: 4_000 })) {
          frames.push(frame);
        }
        expect(seen.runSteps).toBe(1);
        expect(seen.resumes).toHaveLength(1);
        const resume = parseV4ControlFrame(seen.resumes[0]);
        expect(resume.method).toBe("resume-step");
        if (resume.method === "resume-step") {
          expect(resume.recoveryNonce).toBe(NONCE);
          expect(resume.stepId).toBe("step-1");
          expect(resume.snapshot.messages).toEqual([{ role: "user", content: "via-socket" }]);
        }
        expect(frames.some((frame) => isRecord(frame) && frame.method === "compact-request")).toBe(false);
        expect(frames.some((frame) => isKind(frame, "accepted"))).toBe(true);
        expect(frames.some((frame) => isKind(frame, "terminal"))).toBe(true);
        expect(counts.compact).toBe(1);
        expect(counts.stream).toBe(0);
      },
    );
  });

  test("wrong-tuple compact-request is fail-closed and writes no resume", async () => {
    registerSlot();
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen, { stepId: "step-other" }, "hang"),
      async (runRoot, seen) => {
        await expect(requestModeld(runRoot, runStepBody(), 1_500)).rejects.toMatchObject({ message: "compact_rejected" });
        expect(seen.runSteps).toBe(1);
        expect(seen.resumes).toHaveLength(0);
      },
    );
  });

  test("pending background summary compact_rejects without invoking Host compact", async () => {
    bindHostCompactHook({ profileId: "t21-state-root", abiIdentity: "host-abi-v1" })({
      orchestrator: { handleSummarization: async () => { throw new Error("must_not_compact"); } },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: { pending: true } },
      rootPromptExecutor: { getState: () => rootState() },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen, {}, "hang"),
      async (runRoot, seen) => {
        await expect(requestModeld(runRoot, runStepBody(), 1_500)).rejects.toMatchObject({ message: "compact_rejected" });
        expect(seen.resumes).toHaveLength(0);
      },
    );
  });

  test("missing D2 slot rejects compact-request without resume-step", async () => {
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen, {}, "hang"),
      async (runRoot, seen) => {
        await expect(requestModeld(runRoot, runStepBody(), 1_500)).rejects.toMatchObject({ message: "compact_rejected" });
        expect(seen.resumes).toHaveLength(0);
      },
    );
  });

  test("empty production bind compact_rejects; state-system options resume", async () => {
    bindHostCompactHook()({
      orchestrator: { handleSummarization: async () => "summary" },
      ctx: { get: () => TUPLE.turnId, signal: { aborted: false } },
      stateHandler: { backgroundSummarizationPromiseInfo: null },
      rootPromptExecutor: { getState: () => rootState() },
      interactionListener: {},
      config: {},
      requestContext: {},
      invocationId: TUPLE.stepId,
      turnId: TUPLE.turnId,
      agentId: TUPLE.agentId,
      resourceAccessor: {},
      stepClosed: () => false,
    });
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen, {}, "hang"),
      async (runRoot, seen) => {
        await expect(requestModeld(runRoot, runStepBody(), 1_500)).rejects.toMatchObject({ message: "compact_rejected" });
        expect(seen.resumes).toHaveLength(0);
      },
    );
    resetHostCompactSlotForTests();
    const counts = registerSlotWith(stateSystemCompactHookOptions());
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen),
      async (runRoot, seen) => {
        const frames = await requestModeld(runRoot, runStepBody(), 4_000);
        expect(frames.some((frame) => isKind(frame, "terminal"))).toBe(true);
        expect(seen.resumes).toHaveLength(1);
        expect(counts.compact).toBe(1);
      },
    );
  });

  test("compact-request does not satisfy managed requireStepId turns", async () => {
    registerSlot();
    let produced = 0;
    const session = asHostPromptSession(createStreamingPromptSession({
      modelId: "stub/echo",
      vision: false,
      parallel: "fail-closed",
      produce: async function* () {
        produced += 1;
        yield { type: "finish", reason: "stop" };
      },
    }), "stub/echo", undefined, { requireStepId: true });
    const missing = session.getExecutor([{ role: "user", content: "hi" }]).stream({});
    await expect(missing.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    expect(produced).toBe(0);
    await withPeer(
      (socket, seen) => acceptedThenCompact(socket, seen),
      async (runRoot) => {
        const frames = await requestModeld(runRoot, runStepBody(), 4_000);
        expect(frames.some((frame) => isKind(frame, "terminal"))).toBe(true);
      },
    );
    expect(produced).toBe(0);
    const stillMissing = session.getExecutor([{ role: "user", content: "again" }]).stream({});
    await expect(stillMissing.response).rejects.toMatchObject({ name: "RetriableError", code: "invalid_envelope" });
    expect(produced).toBe(0);
  });
});

describe("packed preload contains Host control-frame path", () => {
  test("dist/preload.cjs records compact-request/resume-step client handling", () => {
    const packed = join(repoRoot, "dist", "preload.cjs");
    expect(existsSync(packed)).toBe(true);
    const text = readFileSync(packed, "utf8");
    expect(text).toContain("compact-request");
    expect(text).toContain("resume-step");
    expect(text).toContain("compact_rejected");
    expect(text).not.toContain("= bindHostCompactHook();");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isKind(value: unknown, kind: string): boolean {
  return isRecord(value) && value.kind === kind;
}
