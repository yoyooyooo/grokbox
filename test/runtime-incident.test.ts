import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSendOutcome } from "../packages/cli/src/outcome.ts";
import { captureCli, parseJson, startMockGateway, writeDiscovery } from "./helpers.ts";

const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const at = "2026-09-01T00:00:00.000Z";
const identity = { agentId: "agent-alpha", turnId: "turn-a", hostGenerationId: "generation-1", serviceEpoch: "epoch-1" };
const user = { id: "t0u", kind: "message", role: "user", clientNonce: nonce, requestId: "first" };
const progress = { id: "t0s0", kind: "send-message", requestId: "first", message: { type: "text", content: "progress, not final" } };
const seed = { name: "host_seam_stage", schemaVersion: 1, at, ...identity, clientNonce: nonce, stepId: "first", stage: "stream_enter", result: "entered" };
const backend = { name: "model_step_terminal", schemaVersion: 3, at, ...identity, stepId: "failed", outcome: "error", phase: "normalize", eventCount: 1429, failureCode: "stream_invalid", diagnostic: { phase: "normalize", reason: "stream_shape", normalizeCause: "open_tools_at_finish", rejectSite: "canonical_finish", prompt: "PRIVATE_PROMPT", stream: { version: 1, counts: { openTools: 1 }, timings: {}, tail: [] } } };
const host = { name: "host_stream_rejected", schemaVersion: 2, at, ...identity, stepId: "failed", mode: "route", stage: "normalize", errorCode: "invalid_stream", reason: "invalid-stream", diagnostic: { rejectSite: "host_terminal" } };
const input = { agentId: identity.agentId, nonce, entries: [user, progress], alerts: [], truncated: false };

for (const gap of ["invalid", "partial", "truncated", "missing", "unavailable", "not_in_retained_window"]) {
  test(`a progress delivery plus ${gap} runtime evidence never masks unknown execution`, () => {
    const result = projectSendOutcome({ ...input, runtimeEvents: [], runtimeGap: gap });
    expect(result.state).toBe("unknown"); expect(result.delivery).toHaveLength(1);
    expect(result).toMatchObject({ observations: { delivery: "observed", execution: "unknown" }, runtimeFailure: null, executionCompleted: "not_proven" });
  });
  test(`known same-STEP failure wins even with ${gap} evidence`, () => {
    const result = projectSendOutcome({ ...input, runtimeEvents: [seed, backend, host], runtimeGap: gap });
    expect(result.state).toBe("failed"); expect(result.delivery).toHaveLength(1);
    expect(result.runtimeFailure).toMatchObject({ stepId: "failed", diagnostic: { normalizeCause: "open_tools_at_finish" } });
    expect(JSON.stringify(result.runtimeFailure)).not.toContain("PRIVATE_PROMPT");
  });
}
test("specific Host rejection keeps its cause while disconnect remains a separate backend observation", () => {
  const result = projectSendOutcome({ ...input, runtimeEvents: [seed, { ...backend, outcome: "cancelled", phase: "transport", failureCode: "disconnected", diagnostic: undefined },
    { ...host, diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", declaredToolMatch: false } }] });
  expect(result.runtimeFailure).toMatchObject({ diagnostic: { normalizeCause: "undeclared_tool" }, backend: { failureCode: "disconnected", relation: "same_step_not_cross_process_causal_order" } });
});
test("SDK detail from another STEP cannot specialize a relay-only Host error", () => {
  const result = projectSendOutcome({ ...input, runtimeEvents: [seed, { ...backend, stepId: "unrelated" }, host] });
  expect(result.runtimeFailure?.diagnostic?.normalizeCause).toBeUndefined();
});
test("new TURN with no trigger relation is not inferred from matching Bot or nearby time", () => {
  const otherTurn = { ...backend, turnId: "not-proven-parent", stepId: "followup" };
  const result = projectSendOutcome({ ...input, runtimeEvents: [seed, otherTurn] });
  expect(result.runtimeFailure).toBeNull();
  expect(result.relatedStepIds).not.toContain("followup");
  expect(result.observations.subsequentTurnLineage).toBe("not_observed");
});
test("known failure remains visible when unrelated tray schema is incomplete", () => {
  expect(projectSendOutcome({ ...input, alertsIncomplete: true, runtimeEvents: [seed, backend, host] }).state).toBe("failed");
});
test("no collected Host release receipts means unknown, not zero tools executed", () => {
  const result = projectSendOutcome({ ...input, runtimeEvents: [seed, backend] });
  expect(result.observations.toolCallsReleased).toBeNull();
  expect(result.observations.toolExecution).toBe("not_observed");
});
test("exact STEP selects that incident rather than another failure in the same TURN", () => {
  const result = projectSendOutcome({ ...input, nonce: undefined, stepId: "failed", runtimeEvents: [seed, backend, host, { ...host, stepId: "later", errorCode: "parallel_tools" }] });
  expect(result.runtimeFailure?.stepId).toBe("failed"); expect(result.runtimeFailure?.code).toBe("invalid_stream");
  expect(result.clientNonce).toBe(nonce);
});

test("offline incident CLI reads an exact STEP without any Gateway and never mutates evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owned-incident-cli-"));
  const runRoot = join(dir, "run"); await mkdir(join(runRoot, "log"), { recursive: true });
  const file = join(runRoot, "log", "events.ndjson"), body = [seed, backend, host].map(v => JSON.stringify(v)).join("\n") + "\n";
  await writeFile(file, body);
  try {
    const before = await readdir(runRoot);
    const result = await captureCli(["runtime", "incident", "failed", "--agent", identity.agentId], {
      configDir: dir, env: { GROKBOX_RUN_ROOT: runRoot }, discoveryPath: join(dir, "NO_GATEWAY"), transport: "local",
      daemonSocket: join(dir, "NO_DAEMON"), boxRuntimeRoot: join(dir, "durable"), stdinIsTTY: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { state: "failed", selectedStepId: "failed", queryMode: "offline_step", replayAuthorized: false,
      runtimeFailure: { diagnostic: { normalizeCause: "open_tools_at_finish" } }, evidence: { transcript: "not_checked", alerts: "not_checked" } } });
    expect(result.stdout).not.toContain("PRIVATE_PROMPT");
    expect(await readFile(file, "utf8")).toBe(body); expect(await readdir(runRoot)).toEqual(before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("history outcome --step-id resolves the original send and later failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "owned-outcome-step-")), runRoot = join(dir, "run");
  await mkdir(join(runRoot, "log"), { recursive: true });
  await writeFile(join(runRoot, "log", "events.ndjson"), [seed, backend, host].map(v => JSON.stringify(v)).join("\n") + "\n");
  const gateway = await startMockGateway({ agents: [{ id: identity.agentId, name: "alpha", harness: "box", kind: "agent", isGroup: false }], tail: { entries: [user, progress] }, trays: [] });
  const discoveryPath = await writeDiscovery({ port: gateway.port, pid: gateway.pid, startedAt: gateway.startedAt, token: gateway.token });
  try {
    const result = await captureCli(["history", "outcome", "alpha", "--step-id", "failed", "--runtime"], {
      configDir: dir, env: { GROKBOX_RUN_ROOT: runRoot }, discoveryPath, transport: "local", daemonSocket: join(dir, "none.sock"), boxRuntimeRoot: join(dir, "durable"), stdinIsTTY: true,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(parseJson(result.stdout)).toMatchObject({ data: { state: "failed", clientNonce: nonce, selectedStepId: "failed", observations: { delivery: "observed", execution: "failure_observed" } } });
    const methods = gateway.requests.filter(r => r.pathname.startsWith("/api/")).map(r => r.pathname);
    expect(methods.every(m => ["/api/listAgents", "/api/getAgentTranscriptTail", "/api/getTrays"].includes(m))).toBe(true);
  } finally { gateway.stop(); await rm(dir, { recursive: true, force: true }); }
});
