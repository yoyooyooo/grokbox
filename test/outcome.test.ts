import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAlert, projectSendOutcome } from "../packages/cli/src/outcome.ts";
import { redactEventPayload } from "../packages/cli/src/redaction.ts";
import { createProductionDeps, type CliDeps } from "../packages/cli/src/deps.ts";
import { writeProfileFile } from "../packages/cli/src/config/profile.ts";
import { startDaemonHost } from "../packages/cli/src/daemon/host.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "step-1";
const user = { kind: "message", id: "u", role: "user", clientNonce: nonce, requestId };
const progress = { kind: "send-message", id: "s", requestId, message: { type: "text", content: "Running pwd" }, timestampMs: 10 };
const tray = { kind: "error", id: "alert-1", agentId: "agent-alpha", requestId, titleKind: "botFailedToReply", errorKind: "UnknownError", createdAt: 11, count: 1,
  rawDetail: "Parallel tool calls are not supported. Rejected calls were not executed. (agentId=agent-alpha invocationId=step-1) credential=PRIVATE_SENTINEL",
  actions: [{ kind: "open-url", url: "https://secret.invalid/?token=PRIVATE_SENTINEL" }] };
const base = { agentId: "agent-alpha", nonce, entries: [user], alerts: [], truncated: false };
// These cases use a known route; omission is tested separately in transcript-route.test.ts.
const routedAgents = [{ id: "agent-alpha", name: "alpha", isGroup: false, harness: "box" }];

test("App warning projection exposes stable codes/identity but no raw details or action URLs", () => {
  const projected = projectAlert(tray);
  expect(projected).toMatchObject({ managedCode: "parallel_tools", stepId: requestId, requestId, hasDetail: true });
  expect(JSON.stringify(projected)).not.toContain("PRIVATE_SENTINEL");
  expect(JSON.stringify(projected)).not.toContain("secret.invalid");
  expect(projectAlert({ ...tray, kind: "future-unknown" })).toBeNull();
});

test("tray streaming uses the same idempotent safe projection and never executes actions", () => {
  const once = redactEventPayload("tray", { type: "pushed", tray }, false);
  expect(redactEventPayload("tray", once, false)).toEqual(once);
  expect(JSON.stringify(once)).not.toContain("PRIVATE_SENTINEL");
  expect(redactEventPayload("tray", { type: "dismissed", id: "alert-1" }, false)).toEqual({ type: "dismissed", id: "alert-1" });
});

test("Host's causal rejection is not replaced by a later modeld cancellation", () => {
  const result = projectSendOutcome({ ...base, runtimeEvents: [
    { name: "host_stream_rejected", agentId: "agent-alpha", stepId: requestId, errorCode: "parallel_tools" },
    { name: "model_step_terminal", agentId: "agent-alpha", stepId: requestId, outcome: "cancelled", failureCode: "disconnected" },
  ] });
  expect(result).toMatchObject({ state: "failed", runtimeFailure: { code: "parallel_tools" } });
});

test("accepted, delivered progress, and the exact expected result are distinct", () => {
  expect(projectSendOutcome(base).state).toBe("accepted");
  expect(projectSendOutcome({ ...base, entries: [user, progress] }).state).toBe("delivered");
  expect(projectSendOutcome({ ...base, entries: [user, progress], expectedText: "DONE" }).state).toBe("progress");
  const done = { ...progress, id: "final", message: { type: "text", content: "DONE" } };
  expect(projectSendOutcome({ ...base, entries: [user, progress, done], expectedText: "DONE" })).toMatchObject({ state: "expected_result_observed", expectedMatched: true, executionCompleted: "not_proven" });
});

test("a same-request error wins over earlier SendToUser; other Bot and request warnings do not", () => {
  const alert = projectAlert(tray)!;
  expect(projectSendOutcome({ ...base, entries: [user, progress], alerts: [alert] }).state).toBe("failed");
  expect(projectSendOutcome({ ...base, alerts: [{ ...alert, agentId: "other" }, { ...alert, requestId: "other" }] }).state).toBe("accepted");
});

test("durable runtime cancellation stays a failure after the ephemeral App warning disappears", () => {
  const result = projectSendOutcome({ ...base, entries: [user, progress], runtimeEvents: [
    { name: "model_step_terminal", agentId: "agent-alpha", stepId: requestId, turnId: "turn-1", outcome: "cancelled", failureCode: "disconnected" },
  ] });
  expect(result).toMatchObject({ state: "failed", runtimeFailure: { code: "disconnected" }, executionCompleted: "not_proven" });
});

test("later STEP failure joins the original send only through an observed TURN and service epoch", () => {
  const anchor = { name: "host_normalized_terminal", agentId: "agent-alpha", turnId: "turn-A", serviceEpoch: "epoch-A", stepId: requestId, terminalClass: "stop", toolCallCount: 1 };
  const failed = { ...anchor, stepId: "step-2", terminalClass: "error", errorCode: "parallel_tools" };
  const result = projectSendOutcome({ ...base, entries: [user, progress], runtimeEvents: [anchor, failed] });
  expect(result).toMatchObject({ state: "failed", runtimeFailure: { stepId: "step-2", code: "parallel_tools" } });
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...failed, turnId: "other-turn" }] }).state).toBe("accepted");
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...failed, agentId: "other-agent" }] }).state).toBe("accepted");
});

test("a final SendToUser from a later STEP is linked through the same runtime TURN", () => {
  const anchor = { name: "host_normalized_terminal", agentId: "agent-alpha", turnId: "turn-A", serviceEpoch: "epoch-A", stepId: requestId, terminalClass: "stop" };
  const final = { ...progress, requestId: "step-2", message: { type: "text", content: "FINAL_RESULT" } };
  const result = projectSendOutcome({ ...base, entries: [user, final], expectedText: "FINAL_RESULT", runtimeEvents: [anchor, { ...anchor, stepId: "step-2" }] });
  expect(result).toMatchObject({ state: "expected_result_observed", expectedMatched: true, executionCompleted: "not_proven", relatedStepIds: [requestId, "step-2"] });
  expect(projectSendOutcome({ ...base, entries: [user, final], expectedText: "FINAL_RESULT", runtimeEvents: [anchor, { ...anchor, stepId: "step-2", turnId: "other-turn" }] }).expectedMatched).toBe(false);
});

test("a same-TURN runtime generation change cannot be merged into successful delivery", () => {
  const anchor = { name: "model_step_terminal", agentId: "agent-alpha", turnId: "turn-A", serviceEpoch: "epoch-A", stepId: requestId, outcome: "ok" };
  const result = projectSendOutcome({ ...base, entries: [user, progress], expectedText: "Running pwd", runtimeEvents: [anchor, { ...anchor, serviceEpoch: "epoch-B", stepId: "step-2" }] });
  expect(result.state).toBe("unknown");
  expect(result.expectedMatched).toBe(false);
  expect(result.gaps).toContain("runtime_generation_changed");
});

test("missing runtime generation is not permission to join other STEP failures", () => {
  const anchor = { name: "host_normalized_terminal", agentId: "agent-alpha", turnId: "turn-A", stepId: requestId, terminalClass: "stop" };
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...anchor, stepId: "step-2", terminalClass: "error", errorCode: "parallel_tools" }] }).state).toBe("accepted");
});

test("a native handoff final uses a qualified display turn, not a guessed runtime TURN", () => {
  const origin = { ...user, id: "t0u" };
  const final = { ...progress, id: "t0s0", requestId: "handoff-step", wake: "handoff-resume", message: { type: "text", content: "FILE_RESULT" } };
  const observed = { ...base, entries: [origin, final], expectedText: "FILE_RESULT", transcriptRoute: { initial: "box", before: "box", after: "box", expected: "box" } as const };
  expect(projectSendOutcome(observed)).toMatchObject({ state: "expected_result_observed", expectedMatched: true, executionCompleted: "not_proven",
    evidence: { handoffDelivery: { rootEntryId: "t0u", entryIds: ["t0s0"], meaning: "display-association-not-run-lineage" } } });
  expect(projectSendOutcome({ ...observed, runtimeEvents: [{ name: "host_stream_rejected", agentId: "agent-alpha", stepId: "handoff-step", turnId: "handoff-turn", serviceEpoch: "epoch", errorCode: "parallel_tools" }] }).state).toBe("failed");
  for (const patch of [
    { truncated: true },
    { transcriptRoute: undefined },
    { transcriptRoute: { initial: "temporal", before: "temporal", after: "temporal" } as const },
    { entries: [{ ...origin, id: "t8u" }, { ...final, id: "t8s0" }] },
    { entries: [origin, origin, final] },
    { entries: [origin, { ...final, id: "t1s0" }] },
    { entries: [origin, { ...final, wake: "notification" }] },
    { entries: [origin, { ...final, author: { id: "other" } }] },
    { entries: [origin, { ...final, isStreaming: true }] },
  ]) expect(projectSendOutcome({ ...observed, ...patch }).expectedMatched).toBe(false);
});

test("the next Human turn cannot donate its handoff reply to the prior nonce", () => {
  const entries = [{ ...user, id: "t0u" }, { ...user, id: "t1u", clientNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: "other-request" },
    { ...progress, id: "t1s0", requestId: "handoff-other", wake: "handoff-resume", message: { type: "text", content: "FILE_RESULT" } }];
  expect(projectSendOutcome({ ...base, entries, expectedText: "FILE_RESULT", transcriptRoute: { initial: "box", before: "box", after: "box" } }).expectedMatched).toBe(false);
});

test("a historical Host terminal without class is not proof of success", () => {
  expect(projectSendOutcome({ ...base, runtimeEvents: [{ name: "host_normalized_terminal", agentId: "agent-alpha", stepId: requestId }] }).state).toBe("accepted");
});

test("nonce ambiguity and a Gateway restart cannot join observations into success", () => {
  expect(projectSendOutcome({ ...base, entries: [user, progress, { ...user, requestId: "different" }] }).state).toBe("unknown");
  expect(projectSendOutcome({ ...base, entries: [user, progress], gatewayChanged: true })).toMatchObject({ state: "unknown", delivery: [] });
  expect(projectSendOutcome({ ...base, entries: [user, progress], alertsIncomplete: true })).toMatchObject({ state: "unknown", delivery: [] });
});

test("missing or streaming messages cannot satisfy the final marker", () => {
  expect(projectSendOutcome({ ...base, entries: [], truncated: true }).state).toBe("unknown");
  expect(projectSendOutcome({ ...base, entries: [user, { ...progress, isStreaming: true }], expectedText: "Running pwd" }).state).toBe("accepted");
});

for (const daemonMode of [false, true]) {
  test(`CLI warnings/outcome are read-only through ${daemonMode ? "daemon" : "direct Gateway"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-outcome-"));
    const gateway = await startMockGateway({ agents: routedAgents, trays: [tray], tail: { entries: [user, progress] } });
    const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
    const baseDeps: Partial<CliDeps> = { configDir: dir, env: {}, discoveryPath, daemonSocket: join(dir, "daemon.sock"), transport: daemonMode ? "daemon" : "local", skillsDir: join(import.meta.dir, "../skills"), stdinIsTTY: true };
    await writeProfileFile(dir, "default", { version: 1, transport: daemonMode ? "daemon" : "local", gateway_discovery: discoveryPath, daemon_socket: baseDeps.daemonSocket });
    const daemon = daemonMode ? await startDaemonHost({ ...createProductionDeps(), ...baseDeps, transport: "local" }, baseDeps.daemonSocket!) : undefined;
    try {
      const alerts = await captureCli(["alerts", "list", "--agent", "agent-alpha"], baseDeps);
      expect(alerts.code).toBe(0);
      expect(alerts.stdout).toContain('"managedCode":"parallel_tools"');
      expect(alerts.stdout).not.toContain("PRIVATE_SENTINEL");
      const outcome = await captureCli(["history", "outcome", "alpha", "--nonce", nonce, "--expect-text", "DONE", "--wait-ms", "1000"], baseDeps);
      expect(outcome.code).toBe(0);
      expect(parseJson(outcome.stdout)).toMatchObject({ data: { state: "failed", acceptedObserved: true, samples: 1 } });
      const methods = gateway.requests.filter(r => r.pathname.startsWith("/api/")).map(r => r.pathname);
      expect(methods.length).toBeGreaterThan(0);
      expect(methods.every(m => ["/api/listAgents", "/api/getAgentTranscriptTail", "/api/getTrays"].includes(m))).toBe(true);
      if (daemonMode) {
        const before = gateway.requests.length;
        const localJoin = await captureCli(["history", "outcome", "alpha", "--nonce", nonce, "--runtime"], baseDeps);
        expect(localJoin.code).not.toBe(0);
        expect(gateway.requests).toHaveLength(before);
      }
      const invalid = await captureCli(["history", "outcome", "alpha"], baseDeps);
      expect(invalid.code).not.toBe(0);
    } finally {
      await daemon?.close(); gateway.stop(); await rm(dir, { recursive: true, force: true });
    }
  });
}

test("bounded wait expires on a progress message without resending or a final extra poll", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-outcome-wait-"));
  const gateway = await startMockGateway({ agents: routedAgents, tail: { entries: [user, progress] } });
  const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
  try {
    const result = await captureCli(["history", "outcome", "alpha", "--nonce", nonce, "--expect-text", "DONE", "--wait-ms", "100"], {
      configDir: dir, env: {}, discoveryPath, transport: "local", daemonSocket: join(dir, "none.sock"), skillsDir: join(import.meta.dir, "../skills"), stdinIsTTY: true,
    });
    expect(result.code).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { state: "progress", waitExpired: true, samples: 1, expectedMatched: false } });
    expect(gateway.requests.filter(r => r.pathname.startsWith("/api/"))).toHaveLength(4); // includes the route-closing roster read
  } finally { gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});
