import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogAgentMessage, HOST_FAILURE_CATALOG, INVALID_STREAM_AGENT_MESSAGE } from "@grokbox/box-runtime/runtime";
import { projectAlert, projectSendOutcome, SEND_OUTCOME_STATES } from "../packages/cli/src/outcome.ts";
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

test("opaque botFailedToReply tray with invalid-stream detail projects managedCode invalid_stream", () => {
  const projected = projectAlert({
    kind: "error", id: "alert-shape", agentId: "agent-alpha", requestId,
    titleKind: "botFailedToReply", errorKind: "UnknownError", createdAt: 11, count: 1,
    rawDetail: `${INVALID_STREAM_AGENT_MESSAGE} (agentId=agent-alpha invocationId=${requestId} stage=normalize)`,
  });
  expect(projected).toMatchObject({ managedCode: "invalid_stream", stepId: requestId, requestId, hasDetail: true });
  expect(projected?.titleKind).toBe("botFailedToReply");
  expect(JSON.stringify(projected)).not.toContain("unknown_failure");
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

test("recorded, delivered progress, and the exact expected result are distinct", () => {
  expect(projectSendOutcome(base).state).toBe("recorded");
  expect(projectSendOutcome(base)).toMatchObject({ echoObserved: true, requestId });
  expect(projectSendOutcome({ ...base, entries: [user, progress] }).state).toBe("delivered");
  expect(projectSendOutcome({ ...base, entries: [user, progress], expectedText: "DONE" }).state).toBe("progress");
  const done = { ...progress, id: "final", message: { type: "text", content: "DONE" } };
  expect(projectSendOutcome({ ...base, entries: [user, progress, done], expectedText: "DONE" })).toMatchObject({ state: "expected_result_observed", expectedMatched: true, executionCompleted: "not_proven" });
});

test("a same-request error wins over earlier SendToUser; other Bot and request warnings do not", () => {
  const alert = projectAlert(tray)!;
  expect(projectSendOutcome({ ...base, entries: [user, progress], alerts: [alert] }).state).toBe("failed");
  expect(projectSendOutcome({ ...base, alerts: [{ ...alert, agentId: "other" }, { ...alert, requestId: "other" }] }).state).toBe("recorded");
});

test("first_chunk then normalize stream_invalid is failed with invalid_stream, not opaque model_error", () => {
  const alert = projectAlert({
    kind: "error", id: "alert-shape", agentId: "agent-alpha", requestId,
    titleKind: "botFailedToReply", errorKind: "UnknownError", createdAt: 11, count: 1,
    rawDetail: `${INVALID_STREAM_AGENT_MESSAGE} (agentId=agent-alpha invocationId=${requestId} stage=normalize)`,
  })!;
  const result = projectSendOutcome({
    ...base,
    alerts: [alert],
    runtimeEvents: [
      { name: "host_seam_stage", agentId: "agent-alpha", clientNonce: nonce, stage: "first_chunk", result: "ok", stepId: requestId, turnId: "turn-1" },
      {
        name: "model_step_terminal", agentId: "agent-alpha", stepId: requestId, turnId: "turn-1", serviceEpoch: "epoch",
        outcome: "error", phase: "normalize", failureCode: "stream_invalid",
        diagnostic: { phase: "normalize", reason: "stream_shape" },
      },
      {
        name: "host_normalized_terminal", agentId: "agent-alpha", stepId: requestId, turnId: "turn-1", serviceEpoch: "epoch",
        terminalClass: "error", errorCode: "model_error",
      },
      {
        name: "host_stream_rejected", agentId: "agent-alpha", stepId: requestId, turnId: "turn-1", clientNonce: nonce,
        stage: "provider", errorCode: "model_error", reason: "terminal-rejected",
      },
    ],
  });
  expect(result).toMatchObject({
    state: "failed",
    alerts: [expect.objectContaining({ managedCode: "invalid_stream" })],
    runtimeFailure: {
      code: "invalid_stream",
      reason: "invalid-stream",
      stage: "normalize",
      message: catalogAgentMessage("invalid-stream"),
    },
  });
  expect(result.runtimeFailure?.message).toBe(INVALID_STREAM_AGENT_MESSAGE);
  expect(JSON.stringify(result)).not.toContain("unknown_failure");
  expect(result.runtimeFailure?.code).toBe("invalid_stream");
  // Retain original layer observations; specialization must not rewrite history.
  expect(result.runtimeFailure?.observations.some(row => row.code === "model_error")).toBe(true);
});

for (const hostName of ["host_stream_rejected", "host_normalized_terminal"]) {
  const identity = { agentId: base.agentId, turnId: "turn-1", stepId: requestId };
  const host = {
    ...identity, name: hostName, clientNonce: nonce, terminalClass: "error",
    errorCode: "model_error", reason: "terminal-rejected", stage: "provider",
  };
  const modeld = { ...identity, name: "model_step_terminal", outcome: "error", failureCode: "stream_invalid" };

  test(`${hostName} specializes only a matching STEP, not another STEP in the same TURN`, () => {
    const result = projectSendOutcome({ ...base, runtimeEvents: [
      { ...modeld, stepId: "older-step", serviceEpoch: "epoch-1" },
      { ...modeld, failureCode: "provider_error", serviceEpoch: "epoch-1" },
      host,
    ] });
    expect(result).toMatchObject({ state: "failed", runtimeFailure: { stepId: requestId, code: "model_error", stage: "provider" } });
    expect(projectSendOutcome({ ...base, runtimeEvents: [modeld, host] })).toMatchObject({
      state: "failed", runtimeFailure: { stepId: requestId, code: "invalid_stream", stage: "normalize" },
    });
  });

  for (const [label, patch] of [
    ["different agent", { agentId: "other-agent" }],
    ["different turn", { turnId: "other-turn" }],
    ["missing turn", { turnId: undefined }],
    ["missing step", { stepId: undefined }],
    ["invalid step", { stepId: "bad step" }],
  ] as const) {
    test(`${hostName} does not specialize from a modeld terminal with ${label}`, () => {
      const result = projectSendOutcome({ ...base, runtimeEvents: [
        { ...modeld, clientNonce: nonce, ...patch }, host,
      ] });
      expect(result).toMatchObject({ state: "failed", runtimeFailure: { code: "model_error", stage: "provider" } });
    });
  }

  for (const field of ["turnId", "stepId"] as const) {
    test(`${hostName} missing ${field} is not a wildcard for specialization`, () => {
      const result = projectSendOutcome({ ...base, runtimeEvents: [modeld, { ...host, [field]: undefined }] });
      expect(result).toMatchObject({ state: "failed", runtimeFailure: { code: "model_error", stage: "provider" } });
    });
  }

  for (const field of ["hostGenerationId", "serviceEpoch"] as const) {
    test(`${hostName} requires a modeld match for a supplied ${field}`, () => {
      const qualifiedHost = { ...host, [field]: "generation-1" };
      expect(projectSendOutcome({ ...base, runtimeEvents: [
        { ...modeld, [field]: "generation-1" }, qualifiedHost,
      ] })).toMatchObject({ state: "failed", runtimeFailure: { code: "invalid_stream" } });
      for (const value of [undefined, "generation-2", "bad generation"]) {
        const result = projectSendOutcome({ ...base, runtimeEvents: [
          { ...modeld, [field]: value }, qualifiedHost,
        ] });
        // Both process identities fence the join, not only the service epoch.
        if (value === "generation-2") {
          expect(result).toMatchObject({ state: "unknown", runtimeFailure: null });
        } else {
          expect(result).toMatchObject({ state: "failed", runtimeFailure: { code: "model_error" } });
        }
      }
    });
  }

  test(`${hostName} preserves a typed Host rejection even with same-STEP stream_invalid`, () => {
    expect(projectSendOutcome({ ...base, runtimeEvents: [modeld, { ...host, errorCode: "parallel_tools" }] }))
      .toMatchObject({ state: "failed", runtimeFailure: { code: "parallel_tools" } });
  });
}

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
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...failed, turnId: "other-turn" }] }).state).toBe("recorded");
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...failed, agentId: "other-agent" }] }).state).toBe("recorded");
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
  expect(projectSendOutcome({ ...base, runtimeEvents: [anchor, { ...anchor, stepId: "step-2", terminalClass: "error", errorCode: "parallel_tools" }] }).state).toBe("recorded");
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
  expect(projectSendOutcome({ ...base, runtimeEvents: [{ name: "host_normalized_terminal", agentId: "agent-alpha", stepId: requestId }] }).state).toBe("recorded");
});

test("nonce ambiguity and a Gateway restart cannot join observations into success", () => {
  expect(projectSendOutcome({ ...base, entries: [user, progress, { ...user, requestId: "different" }] }).state).toBe("unknown");
  expect(projectSendOutcome({ ...base, entries: [user, progress], gatewayChanged: true })).toMatchObject({ state: "unknown", delivery: [] });
  const incomplete = projectSendOutcome({ ...base, entries: [user, progress], alertsIncomplete: true });
  expect(incomplete).toMatchObject({ state: "unknown", observations: { delivery: "observed", execution: "unknown" } });
  expect(incomplete.delivery).toHaveLength(1);
});

test("missing or streaming messages cannot satisfy the final marker", () => {
  expect(projectSendOutcome({ ...base, entries: [], truncated: true }).state).toBe("unknown");
  expect(projectSendOutcome({ ...base, entries: [user, { ...progress, isStreaming: true }], expectedText: "Running pwd" }).state).toBe("recorded");
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
      expect(parseJson(outcome.stdout)).toMatchObject({ data: { state: "failed", echoObserved: true, samples: 1 } });
      expect(outcome.stdout).not.toContain("acceptedObserved");
      expect(outcome.stdout).not.toContain('"state":"accepted"');
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

test("outcome states never include accepted", () => {
  expect(SEND_OUTCOME_STATES).toEqual([
    "unknown", "recorded", "failed", "progress", "delivered", "expected_result_observed",
  ]);
  expect(SEND_OUTCOME_STATES).not.toContain("accepted");
  const result = projectSendOutcome(base);
  expect(result).not.toHaveProperty("acceptedObserved");
  expect(JSON.stringify(result)).not.toContain("acceptedObserved");
  expect(result.state).not.toBe("accepted");
});

const admitEcho = { kind: "message", id: "u", role: "user", clientNonce: nonce, requestId: null };
const routeReject = {
  name: "host_stream_rejected", agentId: "agent-alpha", clientNonce: nonce, turnId: "turn-admit",
  stage: "admit", errorCode: "runtime_config_invalid", reason: "route-model-not-admitted",
  message: "FREEFORM_MUST_NOT_LEAK",
};

test("null requestId plus journal reject is failed, empty trays do not fall back to recorded", () => {
  const result = projectSendOutcome({
    ...base, entries: [admitEcho], alerts: [], runtimeEvents: [routeReject],
  });
  expect(result).toMatchObject({
    state: "failed", requestId: null, echoObserved: true, alerts: [], executionCompleted: "not_proven",
    runtimeFailure: {
      source: "host_stream_rejected",
      reason: "route-model-not-admitted",
      stage: "admit",
      code: "runtime_config_invalid",
      message: catalogAgentMessage("route-model-not-admitted"),
    },
  });
  expect(result.runtimeFailure?.message).toBe("route admits only stub/echo or openai* in this slice.");
  expect(JSON.stringify(result)).not.toContain("FREEFORM_MUST_NOT_LEAK");
  expect(result.state).not.toBe("recorded");
});

test("journal reject with the send nonce is failed even without a transcript echo", () => {
  const result = projectSendOutcome({
    ...base, entries: [], truncated: true, alerts: [], runtimeEvents: [routeReject],
  });
  expect(result).toMatchObject({
    state: "failed", echoObserved: false, requestId: null,
    runtimeFailure: { reason: "route-model-not-admitted", message: catalogAgentMessage("route-model-not-admitted") },
  });
  expect(result.gaps).not.toContain("nonce_not_in_transcript_window");
});

test("request-id lookup joins journal reject through the echo clientNonce", () => {
  const result = projectSendOutcome({
    agentId: "agent-alpha", requestId, entries: [user], alerts: [], truncated: false, runtimeEvents: [routeReject],
  });
  expect(result).toMatchObject({
    state: "failed", clientNonce: nonce, echoObserved: true,
    runtimeFailure: { reason: "route-model-not-admitted", message: catalogAgentMessage("route-model-not-admitted") },
  });
});

test("a journal bind without terminal evidence stays recorded, not delivered", () => {
  expect(projectSendOutcome({
    ...base, entries: [], runtimeEvents: [
      { name: "host_seam_stage", agentId: "agent-alpha", clientNonce: nonce, stage: "hook_enter", turnId: "turn-admit" },
    ],
  })).toMatchObject({ state: "recorded", echoObserved: false });
  expect(projectSendOutcome({ ...base, entries: [{ ...user, requestId: null }] })).toMatchObject({
    state: "recorded", requestId: null, echoObserved: true, runtimeFailure: null,
  });
});

test("a different nonce reject does not fail this send", () => {
  expect(projectSendOutcome({
    ...base, runtimeEvents: [{ ...routeReject, clientNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
  }).state).toBe("recorded");
});

for (const row of HOST_FAILURE_CATALOG) {
  test(`catalog reason ${row.reason} projects failed with the catalog sentence`, () => {
    const result = projectSendOutcome({
      ...base, entries: [admitEcho], alerts: [], runtimeEvents: [{
        name: "host_stream_rejected", agentId: "agent-alpha", clientNonce: nonce, turnId: "turn-admit",
        reason: row.reason, errorCode: row.errorCode, stage: row.stage, message: "FREEFORM_MUST_NOT_LEAK",
      }],
    });
    expect(result.state).toBe("failed");
    expect(result.runtimeFailure).toMatchObject({
      reason: row.reason, code: row.errorCode, stage: row.stage, message: row.agentMessage,
    });
    expect(result.runtimeFailure?.message).toBe(catalogAgentMessage(row.reason));
    expect(JSON.stringify(result)).not.toContain("FREEFORM_MUST_NOT_LEAK");
  });
}

test("CLI --runtime joins a nonce-only journal reject while trays stay empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grokbox-outcome-runtime-"));
  const runRoot = join(dir, "run");
  await mkdir(join(runRoot, "log"), { recursive: true });
  await writeFile(join(runRoot, "log", "events.ndjson"), `${JSON.stringify({
    name: "host_stream_rejected", schemaVersion: 2, at: "2026-01-01T00:00:00.000Z", mode: "route",
    agentId: "agent-alpha", turnId: "turn-admit", clientNonce: nonce, stage: "admit",
    errorCode: "runtime_config_invalid", reason: "route-model-not-admitted",
  })}\n`);
  const gateway = await startMockGateway({ agents: routedAgents, trays: [], tail: { entries: [admitEcho] } });
  const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
  try {
    const result = await captureCli(["history", "outcome", "alpha", "--nonce", nonce, "--runtime"], {
      configDir: dir, env: { GROKBOX_RUN_ROOT: runRoot }, discoveryPath, transport: "local",
      daemonSocket: join(dir, "none.sock"), boxRuntimeRoot: join(dir, "durable"),
      skillsDir: join(import.meta.dir, "../skills"), stdinIsTTY: true,
    });
    expect(result.code).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({
      data: {
        state: "failed", requestId: null, echoObserved: true, alerts: [],
        runtimeFailure: {
          reason: "route-model-not-admitted",
          message: catalogAgentMessage("route-model-not-admitted"),
        },
      },
    });
    expect(result.stdout).not.toContain('"state":"accepted"');
    expect(result.stdout).not.toContain("acceptedObserved");
  } finally { gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("send topic teaches nonce+runtime outcome while the entry keeps the receipt safety rule", async () => {
  const entry = await readFile(join(import.meta.dir, "../skills/grokbox/SKILL.md"), "utf8");
  const skill = await readFile(join(import.meta.dir, "../skills/grokbox/send.md"), "utf8");
  const diagnostics = await readFile(join(import.meta.dir, "../skills/grokbox/diagnostics.md"), "utf8");
  expect(entry).toContain("[send](send.md)");
  expect(entry).toContain("clientNonce");
  expect(entry).toContain("queued, not a reply");
  expect(skill).toContain("grokbox send <agent>");
  expect(skill).toContain("history outcome <agent> --nonce <clientNonce> --runtime");
  expect(skill).toMatch(/queued, not a reply/);
  expect(skill).toContain("| `recorded` |");
  expect(skill).toContain("| `failed` |");
  expect(skill).toContain("`accepted` token");
  expect(skill).toContain("[diagnostics](diagnostics.md)");
  expect(diagnostics).toContain("GROKBOX_RUN_ROOT");
  expect(diagnostics).toContain("evidence.runtimeRoot");
  expect(skill).not.toMatch(/data\.state\s*=\s*accepted/);
});

test("observation docs drop accepted as an outcome state", async () => {
  const observation = await readFile(join(import.meta.dir, "../docs/maintainers/run-outcome-observation.md"), "utf8");
  const contract = await readFile(join(import.meta.dir, "../docs/product-contract.md"), "utf8");
  const core = await readFile(join(import.meta.dir, "../skills/core.md"), "utf8");
  for (const [name, text] of [["observation", observation], ["contract", contract], ["core", core]] as const) {
    expect(text, name).toContain("recorded");
    expect(text, name).not.toMatch(/accepted（仅输入记录）/);
    expect(text, name).not.toMatch(/Success means accepted, not\s+completed/);
  }
  expect(observation).toContain("history outcome <agent-id> --nonce <clientNonce> --runtime");
  expect(contract).toContain("history outcome <id-or-name> --nonce <clientNonce> --runtime");
  expect(core).toContain("history outcome <target> --nonce <clientNonce> --runtime");
});
