import { expect, test } from "bun:test";
import { StreamEvidence, annotateStreamFailure, streamFailureDiagnostic, projectStreamDiagnostic, projectFailureSummary, withStreamLayer, type StreamSummary } from "@grokbox/runtime-kernel/contract";
import { ToolIdentityObserver } from "../src/internal/backends/tool-identity-audit.ts";
import { diagnoseExecution } from "@grokbox/runtime-kernel/alerts";
import { projectSendOutcome } from "../../cli/src/outcome.ts";

function observations() {
  const backend = new StreamEvidence(), host = new StreamEvidence(), wire = new StreamEvidence();
  const identity = new ToolIdentityObserver(["CorrectTool"], backend);
  identity.provider("call", "UnknownTool"); identity.sdk("call", "UnknownTool");
  backend.setCount("toolsStarted", 2); backend.setCount("httpCalls", 1);
  host.setCount("hostToolsReleased", 0); host.setCount("toolsStarted", 1);
  wire.setCount("hostEvents", 3);
  return { backend: backend.snapshot(), host: host.snapshot(), wire: wire.snapshot() };
}
const tuple = { agentId: "agent", turnId: "turn", stepId: "step", hostGenerationId: "host", serviceEpoch: "service" };
function rows() {
  const evidence = observations();
  return { evidence,
    backend: { ...tuple, name: "model_step_terminal", outcome: "error", failureCode: "stream_invalid", phase: "normalize", backendAttempts: 2,
      diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "sdk_tool", stream: evidence.backend } },
    host: { ...tuple, name: "host_stream_rejected", errorCode: "invalid_stream", stage: "normalize",
      diagnostic: { normalizeCause: "undeclared_tool", rejectSite: "host_tool", stream: evidence.host },
      failureSummary: projectFailureSummary({ version: 1, code: "stream_invalid", phase: "normalize", identity: tuple, progress: { canonicalEvents: 1, backendAttempts: 2 } }) },
  };
}

test("successive local observations retain three independent layers without adding counts", () => {
  const o = observations();
  const error = annotateStreamFailure(new Error("fixture"), withStreamLayer({ normalizeCause: "undeclared_tool", rejectSite: "sdk_tool" }, "backend", o.backend));
  annotateStreamFailure(error, withStreamLayer(streamFailureDiagnostic(error), "wire", o.wire));
  annotateStreamFailure(error, withStreamLayer(streamFailureDiagnostic(error), "host", o.host));
  const projected = streamFailureDiagnostic(error)!;
  expect(projected.normalizeCause).toBe("undeclared_tool"); expect(projected.rejectSite).toBe("sdk_tool");
  expect(projected.streams).toEqual(o);
  expect(projected.stream?.counts.toolsStarted).toBe(1);
  expect(projected.streams?.backend?.counts.toolsStarted).toBe(2);
});

test("same bound execution and final attempt can enrich Host cause with backend tool witnesses", () => {
  const r = rows();
  for (const events of [[r.host, r.backend], [r.backend, r.host]]) {
    const diagnosis = diagnoseExecution(events, tuple);
    expect(diagnosis).toMatchObject({ diagnostic: { rejectSite: "host_tool", streams: { backend: r.evidence.backend, host: r.evidence.host } } });
    const cli = projectSendOutcome({ agentId: tuple.agentId, stepId: tuple.stepId, entries: [], alerts: [], truncated: false, runtimeEvents: events });
    expect(cli.runtimeFailure?.diagnostic).toEqual("diagnostic" in diagnosis ? diagnosis.diagnostic : undefined);
  }
});

for (const fault of ["missing-epoch", "other-attempt", "missing-attempt", "wrong-summary-identity", "duplicate-backend", "binding-mismatch"] as const) {
  test(`enrichment cannot borrow evidence from ${fault}`, () => {
    const r = rows();
    let host: Record<string, any> = r.host, backend: Record<string, any> = r.backend;
    if (fault === "missing-epoch") host = { ...host, serviceEpoch: undefined };
    if (fault === "other-attempt") backend = { ...backend, backendAttempts: 1 };
    if (fault === "missing-attempt") backend = { ...backend, backendAttempts: undefined };
    if (fault === "wrong-summary-identity") host = { ...host, failureSummary: { ...host.failureSummary, identity: { ...tuple, serviceEpoch: "foreign" } } };
    if (fault === "binding-mismatch") backend = { ...backend, bindingId: "foreign" };
    const events = [host, backend, ...(fault === "duplicate-backend" ? [{ ...backend }] : [])];
    const diagnosis = diagnoseExecution(events, tuple);
    expect("diagnostic" in diagnosis && diagnosis.diagnostic?.streams?.backend).toBeUndefined();
    expect(JSON.stringify(diagnosis)).not.toContain("nameDigest");
  });
}

test("legacy scalar specialization cannot smuggle unbound backend tool evidence into either summary", () => {
  const r = rows(), host = { ...r.host, serviceEpoch: undefined, failureSummary: undefined, diagnostic: undefined, errorCode: "model_error" };
  const diagnosis = diagnoseExecution([host, r.backend], tuple);
  expect(diagnosis).toMatchObject({ code: "invalid_stream" });
  expect(JSON.stringify(diagnosis)).not.toContain("nameDigest");
});

function legacyBoundRows(kind: "host_stream_rejected" | "host_normalized_terminal") {
  const r = rows();
  const summary = projectFailureSummary({ version: 1, code: "stream_invalid", phase: "normalize",
    identity: { ...tuple, bindingId: "fixture-binding" }, diagnostic: r.backend.diagnostic,
    progress: { canonicalEvents: 2, backendAttempts: 2 } })!;
  const backend: Record<string, any> = { ...r.backend, bindingId: "fixture-binding", failureSummary: summary };
  const host: Record<string, any> = { ...r.host, name: kind, failureSummary: summary,
    diagnostic: { ...r.host.diagnostic, failureSummaryStatus: "direct" },
    ...(kind === "host_normalized_terminal" ? { binding: "fixture-binding", terminalClass: "error", requestKind: "main" } : {}) };
  return { ...r, host, backend };
}

for (const kind of ["host_stream_rejected", "host_normalized_terminal"] as const) {
  test(`legacy ${kind} preserves its bound carried evidence without inventing an outer bindingId`, () => {
    const r = legacyBoundRows(kind), before = JSON.stringify(r);
    for (const events of [[r.host], [r.backend, r.host], [r.host, r.backend]]) {
      const diagnosis = diagnoseExecution(events, tuple);
      expect(diagnosis).toMatchObject({ diagnostic: { streams: { backend: r.evidence.backend, host: r.evidence.host } },
        failureSummary: { diagnostic: { streams: { backend: r.evidence.backend } } } });
      const cli = projectSendOutcome({ agentId: tuple.agentId, stepId: tuple.stepId, entries: [], alerts: [], truncated: false, runtimeEvents: events });
      expect(cli.runtimeFailure?.diagnostic?.streams?.backend).toEqual(r.evidence.backend);
      expect(cli.runtimeFailure?.failureSummary?.diagnostic?.streams?.backend).toEqual(r.evidence.backend);
    }
    expect(JSON.stringify(r)).toBe(before);
  });
}

for (const fault of ["unattested-missing-binding", "alias-conflict", "alias-summary-conflict", "empty-binding", "wrong-summary-code", "summary-status-invalid", "summary-status-mismatch", "binding-accessor"] as const) {
  test(`legacy carried evidence stays unavailable with ${fault}`, () => {
    const r = legacyBoundRows("host_normalized_terminal");
    let reads = 0;
    if (fault === "unattested-missing-binding") { delete r.host.binding; delete r.host.diagnostic.failureSummaryStatus; }
    if (fault === "alias-conflict") r.host.bindingId = "different-binding";
    if (fault === "alias-summary-conflict") r.host.binding = "different-binding";
    if (fault === "empty-binding") r.host.binding = "";
    if (fault === "wrong-summary-code") r.host.failureSummary = { ...r.host.failureSummary, code: "provider_error" };
    if (fault === "summary-status-invalid") r.host.diagnostic.failureSummaryStatus = "invalid";
    if (fault === "summary-status-mismatch") r.host.diagnostic.failureSummaryStatus = "identity_mismatch";
    if (fault === "binding-accessor") Object.defineProperty(r.host, "binding", { get() { reads++; return "fixture-binding"; }, enumerable: true });
    const diagnosis = diagnoseExecution([r.backend, r.host], tuple);
    expect("diagnostic" in diagnosis && diagnosis.diagnostic?.streams?.backend).toBeUndefined();
    expect(JSON.stringify(diagnosis)).not.toContain("nameDigest");
    expect(reads).toBe(0);
  });
}

for (const purpose of ["main", "memory-extraction", "episode"] as const) {
  test(`legacy requestKind=${purpose} is explicit purpose evidence, not a missing observation`, () => {
    const r = legacyBoundRows("host_normalized_terminal"); r.host.requestKind = purpose;
    const cli = projectSendOutcome({ agentId: tuple.agentId, stepId: tuple.stepId, entries: [], alerts: [], truncated: false, runtimeEvents: [r.backend, r.host] });
    expect(cli.runtimeFailure?.purpose).toBe(purpose);
  });
}
for (const fault of ["conflicting-purpose", "foreign-step-only"] as const) {
  test(`purpose stays unknown for ${fault}`, () => {
    const r = legacyBoundRows("host_normalized_terminal");
    if (fault === "conflicting-purpose") r.host.purpose = "episode";
    else delete r.host.requestKind;
    const other = { ...r.host, stepId: "other-step", requestKind: "main" };
    const cli = projectSendOutcome({ agentId: tuple.agentId, stepId: tuple.stepId, entries: [], alerts: [], truncated: false, runtimeEvents: [r.backend, r.host, other] });
    expect(cli.runtimeFailure?.purpose).toBe("not_observed");
  });
}

test("conflicting generations and service epochs remain ambiguous", () => {
  const r = rows();
  expect(diagnoseExecution([r.host, { ...r.backend, serviceEpoch: "foreign" }], { agentId: "agent", stepId: "step" })).toMatchObject({ state: "unknown" });
  expect(diagnoseExecution([r.host, { ...r.backend, hostGenerationId: "foreign" }], { agentId: "agent", stepId: "step" })).toMatchObject({ state: "unknown" });
});

test("layered projection stays finite, non-recursive and accessor/payload-free", () => {
  let getters = 0;
  const summary = { ...observations().backend, raw: "PRIVATE", tail: Array.from({ length: 100 }, (_, sequence) => ({ layer: "sdk", type: "tool-call", sequence, elapsedMs: 0, raw: "PRIVATE" })) };
  const value = { streams: { backend: summary, host: summary, wire: summary, privateLayer: summary, get credentials() { getters++; return "PRIVATE"; } }, get stream() { getters++; return summary; } };
  const projected = projectStreamDiagnostic(value)!;
  expect(getters).toBe(0); expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  expect(Object.keys(projected.streams!)).toEqual(["backend", "wire", "host"]);
  for (const layer of Object.values(projected.streams!) as StreamSummary[]) expect(layer.tail).toHaveLength(32);
  expect(JSON.stringify(projected).length).toBeLessThan(24000);
});
