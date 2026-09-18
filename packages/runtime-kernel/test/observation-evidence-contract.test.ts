import { expect, test } from "bun:test";
import { assessEvidenceCoverage, selectEvidenceClosure, assessIncident, assessUnsettledExecution, EVIDENCE_REQUIREMENTS,
  diagnosticAdmission, diagnosticStoragePolicy, retentionClock, type EvidenceFact } from "../src/observation.ts";

const fact = (ref: string, value: Record<string, unknown>): EvidenceFact => ({ ref, value });
const identity = { agentId: "agent-a", turnId: "turn-a", hostGenerationId: "host-a", serviceEpoch: "epoch-a" };
const seed = fact("first", { ...identity, name: "host_seam_stage", stepId: "step-a" });
const sibling = fact("second", { ...identity, name: "model_step_terminal", stepId: "step-b", outcome: "error", phase: "normalize", failureCode: "stream_invalid", diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool" } });

for (const requirement of EVIDENCE_REQUIREMENTS) {
  test(`${requirement}: absent source, truncated window and conflicting identity are explicit`, () => {
    const absent = assessEvidenceCoverage([]).find(r => r.requirement === requirement)!;
    expect(absent.status).not.toBe("observed"); expect(absent.missing.length).toBeGreaterThan(0);
    const conflict = assessEvidenceCoverage([seed, sibling], { conflicting: true }).find(r => r.requirement === requirement)!;
    expect(conflict.status).toBe("conflicting");
    const truncated = assessEvidenceCoverage([seed, sibling], { truncated: true }).find(r => r.requirement === requirement)!;
    expect(truncated.status).not.toBe("observed"); expect(truncated.missing).toContain("bounded_window");
  });
}
test("same TURN closure is bounded by actual generation and epoch, not Agent or timestamps", () => {
  const other = fact("other", { ...sibling.value, serviceEpoch: "epoch-b" });
  const changed = fact("changed", { ...sibling.value, hostGenerationId: "host-b" });
  const result = selectEvidenceClosure([seed, sibling, other, changed], { agentId: "agent-a", stepId: "step-a" });
  expect(result.facts.map(f => f.ref)).toEqual(["first", "second"]);
  expect(result.relationEdges).toEqual([{ from: "first", to: "second", kind: "same_execution", basis: "explicit_identity" }]);
  expect(selectEvidenceClosure([seed, sibling], { agentId: "agent-a", stepId: "step-a" }, 1).truncated).toBe(true);
});
test("tool release is only partial evidence; checkpoint and App results are not inferred", () => {
  const coverage = assessEvidenceCoverage([seed, fact("tool", { ...identity, name: "host_normalized_terminal", toolCallCount: 1 })]);
  expect(coverage.find(r => r.requirement === "E04")).toMatchObject({ status: "partial", missing: ["external_business_commit", "native_tool_execution_and_acceptance"] });
  expect(coverage.find(r => r.requirement === "E05")?.status).toBe("not_instrumented");
  expect(coverage.find(r => r.requirement === "E06")?.status).not.toBe("observed");
});
test("upstream 503 is local-only only when there is no observed independent local defect", () => {
  const upstream = fact("upstream", { ...identity, name: "model_step_terminal", stepId: "step-a", outcome: "error", phase: "provider", failureCode: "model_error", diagnostic: { httpStatus: 503, reason: "http" } });
  expect(assessIncident("execution_failure", [upstream])).toMatchObject({ disposition: "local_only", reason: "upstream_only" });
  expect(assessIncident("execution_failure", [upstream, sibling])).toMatchObject({ disposition: "notify", reason: "runtime_failure" });
  expect(assessIncident("native_alert", [])).toMatchObject({ disposition: "notify", category: "unknown", rootCause: "not_proven" });
});
test("silence is not a deadlock; source liveness and explicit waiting remain independent", () => {
  const value = { state: "started", lastProgressMs: 1000, nowMs: 601000, sourceLastObservedMs: 600000 };
  expect(assessUnsettledExecution(value)).toBe("suspected");
  expect(assessUnsettledExecution({ ...value, sourceLastObservedMs: null })).toBe("source_unavailable");
  expect(assessUnsettledExecution({ ...value, waitingReason: "approval" })).toBe("waiting");
  expect(assessUnsettledExecution({ ...value, state: "finished" })).toBe("settled");
});
test("storage quota includes reserved working space and clock reversal cannot renew retention", () => {
  const policy = diagnosticStoragePolicy({ targetBytes: 256, maxBytes: 512, reserveBytes: 64 });
  expect(diagnosticAdmission(policy, 400, 32, 32).accepted).toBe(false);
  expect(diagnosticAdmission(policy, 200, 0, 20).accepted).toBe(true);
  expect(retentionClock(100, 200)).toMatchObject({ mayExpire: false, nowMs: 200, state: "clock_reversed" });
  expect(retentionClock(1_000_000_000, 200).state).toBe("clock_jump");
});
