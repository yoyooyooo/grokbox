import { expect, test } from "bun:test";
import {
  OWNERSHIP_READ_SOURCE, OWNERSHIP_READ_ERRORS, projectOwnershipReadObservation,
  ownershipReadObservationFromSnapshot, decideManagedOwnership, inspectOwnership,
  projectStreamDiagnostic, projectFailureSummary, failureSummaryFromObservation, presentFailure,
} from "../src/contract.ts";

const at = "2026-01-01T00:00:00.000Z";
const detail = { version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "timeout", phase: "server",
  serverRead: "request", durationMs: 9500, deadlineMs: 10000, serverWaitMs: 9400 };
const snapshot = (errorCode: string) => ({ schemaVersion: 3, source: OWNERSHIP_READ_SOURCE, state: "unavailable",
  errorCode, observedAt: at, completedAt: "2026-01-01T00:00:09.500Z", agents: [] });

for (const errorCode of OWNERSHIP_READ_ERRORS) test(`ownership ${errorCode} survives inspection and refusal without altering admission`, () => {
  const raw = { ...snapshot(errorCode), readObservation: { ...detail, errorCode } };
  expect(inspectOwnership({ agentIds: ["agent"], snapshot: raw })).toMatchObject({ readObservation: { errorCode }, serverRead: { state: "unavailable", errorCode } });
  expect(decideManagedOwnership({ agentId: "agent", snapshot: raw, nowMs: Date.parse(at) + 9500 })).toMatchObject({
    ok: false, reason: "server_read_unavailable", class: "unavailable", ownershipRead: { errorCode, durationMs: 9500, phase: "server" },
  });
  const summary = projectFailureSummary({ version: 1, code: "not_admitted", phase: "admission", progress: { canonicalEvents: 0, backendAttempts: 0 },
    diagnostic: { authority: { reason: "server_read_unavailable", checkpoint: "admission", durationMs: 9500, waitBudgetMs: 10000, ownershipRead: raw.readObservation } } })!;
  const presented = presentFailure(summary);
  const action = errorCode === "authorization_unavailable" ? "check_ownership_access"
    : ["unsupported_rpc", "invalid_request", "invalid_response"].includes(errorCode) ? "align_local_components" : "check_ownership";
  expect(presented).toMatchObject({ action, replayAuthorized: false,
    next: action === "align_local_components" ? "grokbox doctor" : "grokbox agents ownership <agent>" });
  expect(presented.message).toContain(`Ownership-read detail: ${errorCode}`);
  expect(presented.message).toContain("Authority checkpoint: admission (9500 ms)");
  expect(presented.message).toContain("No model request was dispatched by this STEP");
  expect(presented.message).not.toContain("upstream model endpoint");
});

test("legacy Host snapshots preserve their actual subcode, without inventing missing instrumentation", () => {
  expect(ownershipReadObservationFromSnapshot(snapshot("authorization_unavailable"))).toEqual({
    version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "authorization_unavailable", durationMs: 9500,
  });
  const oldJournal = failureSummaryFromObservation({ failureCode: "not_admitted", phase: "admission",
    diagnostic: { authority: { reason: "server_read_unavailable", checkpoint: "admission", durationMs: 9396 } } })!;
  expect(oldJournal.diagnostic?.authority?.ownershipRead).toBeUndefined();
  expect(oldJournal.progress).toBeUndefined();
  const message = presentFailure(oldJournal).message;
  expect(message).toContain("underlying read error was not recorded");
  expect(message).not.toContain("timed out");
  expect(message).not.toContain("No model request was dispatched");
  expect(message).not.toContain("No tools were released");
});

test("observation metadata cannot override a failed native read or grant eligibility", () => {
  const raw = { ...snapshot("timeout"), readObservation: { ...detail, state: "observed", errorCode: undefined } };
  expect(ownershipReadObservationFromSnapshot(raw)).toMatchObject({ state: "unavailable", errorCode: "timeout" });
  expect(decideManagedOwnership({ agentId: "agent", snapshot: raw, nowMs: Date.parse(at) + 9500 }).ok).toBe(false);
});

test("sanitization at every projection drops secrets, unknown subcodes, impossible times, RPC codes and getters", () => {
  let reads = 0;
  const unsafe = { ...detail, errorCode: "PRIVATE_SENTINEL", rpcCode: 99, durationMs: -1, deadlineMs: Infinity,
    serverWaitMs: 1.5, endpoint: "PRIVATE_SENTINEL", response: "PRIVATE_SENTINEL", credential: "PRIVATE_SENTINEL",
    get serverEvidenceAgeMs() { reads++; throw Error("PRIVATE_SENTINEL"); } };
  const safe = projectOwnershipReadObservation(unsafe)!;
  expect(safe).toEqual({ version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", phase: "server", serverRead: "request" });
  const diagnostic = projectStreamDiagnostic({ authority: { reason: "server_read_unavailable", ownershipRead: unsafe, waitBudgetMs: 10000 } })!;
  const summary = projectFailureSummary({ version: 1, code: "not_admitted", phase: "authority", diagnostic })!;
  expect(reads).toBe(0);
  expect(JSON.stringify([safe, diagnostic, summary, presentFailure(summary)])).not.toContain("PRIVATE_SENTINEL");
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw Error("PRIVATE_SENTINEL"); } });
  expect(projectOwnershipReadObservation(hostile)).toBeUndefined();
  expect(ownershipReadObservationFromSnapshot(hostile)).toBeUndefined();
});

test("successful reads do not carry failure codes and stale evidence is not mislabelled as timeout", () => {
  const read = projectOwnershipReadObservation({ ...detail, state: "observed", errorCode: "timeout", rpcCode: 16, serverEvidenceAgeMs: 6000 });
  expect(read?.errorCode).toBeUndefined(); expect(read?.rpcCode).toBeUndefined();
  const summary = projectFailureSummary({ version: 1, code: "not_admitted", phase: "authority", progress: { backendAttempts: 1, canonicalEvents: 2 },
    diagnostic: { authority: { reason: "ownership_evidence_stale", checkpoint: "tool_start", ownershipRead: read } } })!;
  const message = presentFailure(summary, { toolsReleased: 0 }).message;
  expect(message).toContain("too old"); expect(message).not.toContain("timed out");
  expect(message).not.toContain("No model request was dispatched");
});
