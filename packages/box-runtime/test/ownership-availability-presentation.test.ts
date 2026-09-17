import { expect, test } from "bun:test";
import { OWNERSHIP_READ_SOURCE, STRICT_AUTHORITY_POLICY, presentAuthorityFailure, presentFailure, projectFailureSummary,
  projectStreamDiagnostic, projectAuthorityProgress, projectOwnershipWaitObservation, type AuthorityDiagnostic } from "@grokbox/runtime-kernel/contract";
import { ownershipUseError } from "../src/internal/io/ownership-admission.node.ts";

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const stepId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = { agentId, stepId, turnId: "turn", hostGenerationId: "host", serviceEpoch: "service" };
const cases: Array<[AuthorityDiagnostic, string, string, string]> = [
  [{ reason: "ownership_evidence_stale", availabilityCause: "read_elapsed", evidenceAgeMs: 5503 }, "read returned", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "ownership_evidence_stale", availabilityCause: "evidence_elapsed" }, "subsequent qualification", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "ownership_evidence_stale", availabilityCause: "permit_elapsed" }, "permit expired", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "ownership_evidence_stale" }, "not recorded", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "ownership_read_timeout", availabilityCause: "wait_budget" }, "remaining qualification wait budget", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "confirmed_temporal" }, "server-side agent loop", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "harness_mismatch" }, "identities disagree", "check_ownership", `grokbox agents ownership ${agentId}`],
  [{ reason: "ownership_reader_unavailable" }, "does not establish that the Host is stopped", "inspect_local_runtime", "grokbox doctor"],
  [{ reason: "ownership_bridge_unavailable" }, "loaded components", "align_local_components", "grokbox doctor"],
  [{ reason: "server_read_unavailable", ownershipRead: { version: 1, source: OWNERSHIP_READ_SOURCE, state: "unavailable", errorCode: "authorization_unavailable" } }, "not a model-provider credential failure", "check_ownership_access", `grokbox agents ownership ${agentId}`],
];

for (const [diagnostic, phrase, action, next] of cases) test(`shared refusal guidance: ${diagnostic.reason}/${diagnostic.availabilityCause ?? diagnostic.ownershipRead?.errorCode ?? "unknown"}`, () => {
  const projected = presentAuthorityFailure(diagnostic, { agentId });
  const cli = ownershipUseError(diagnostic.reason, diagnostic.reason === "confirmed_temporal" ? "temporal" : "unconfirmed", agentId,
    diagnostic.ownershipRead, diagnostic);
  const summary = projectFailureSummary({ version: 1, code: "not_admitted", phase: "authority", diagnostic: { authority: diagnostic },
    progress: { backendAttempts: 0, canonicalEvents: 0 } })!;
  const displayed = presentFailure(summary, { toolsReleased: 0 });
  expect(projected).toMatchObject({ action, next });
  expect(projected.message).toContain(phrase); expect(cli.message).toBe(projected.message); expect(cli.next).toBe(next);
  expect(displayed.message).toContain(projected.message); expect(displayed.action).toBe(action); expect(displayed.replayAuthorized).toBe(false);
  expect(displayed.message).toContain("No model request was dispatched"); expect(displayed.message).toContain("No tools were released");
  for (const value of [cli.next, displayed.message]) { expect(value).not.toContain("host start"); expect(value).not.toContain("title sync"); }
});

test("post-inference refusal links the exact incident and never claims zero dispatch or safe replay", () => {
  const summary = projectFailureSummary({ version: 1, code: "not_admitted", phase: "authority", identity,
    diagnostic: { authority: { reason: "ownership_evidence_stale", availabilityCause: "evidence_elapsed", checkpoint: "finish" } },
    progress: { backendAttempts: 1, canonicalEvents: 4 } })!;
  const displayed = presentFailure(summary, { receivedOutput: true, toolsReleased: 1 });
  expect(displayed.next).toBe(`grokbox runtime incident ${stepId} --agent ${agentId} --json`);
  expect(displayed.message).not.toContain("No model request was dispatched");
  expect(displayed.message).toContain("Tools had already been released");
  expect(displayed.message).toContain("does not establish that ownership changed");
  expect(displayed.replayAuthorized).toBe(false);
});

test("availability explanations cannot override classification or manufacture historical latency", () => {
  expect(projectStreamDiagnostic({ authority: { reason: "confirmed_temporal", availabilityCause: "read_elapsed" } })?.authority)
    .toEqual({ reason: "confirmed_temporal" });
  expect(projectStreamDiagnostic({ authority: { reason: "ownership_evidence_stale", availabilityCause: "wait_budget" } })?.authority)
    .toEqual({ reason: "ownership_evidence_stale" });
  const legacy = presentAuthorityFailure({ reason: "ownership_evidence_stale", ownershipRead: {
    version: 1, source: OWNERSHIP_READ_SOURCE, state: "observed", serverWaitMs: 9000,
  } });
  expect(legacy.message).toContain("not recorded"); expect(legacy.message).not.toContain("read returned");
  let getters = 0;
  const invalid = { reason: "ownership_evidence_stale", get availabilityCause() { getters++; throw Error("PRIVATE_SENTINEL"); },
    get evidenceOwner() { getters++; throw Error("PRIVATE_SENTINEL"); }, private: "PRIVATE_SENTINEL" };
  const safe = projectStreamDiagnostic({ authority: invalid });
  expect(getters).toBe(0); expect(JSON.stringify(safe)).not.toContain("PRIVATE_SENTINEL");
  expect(presentAuthorityFailure(safe?.authority, { agentId: "bad\ncommand", stepId: "--bad" }).next).toBe("grokbox agents ownership <agent>");
});

for (const policyId of ["strict-observation-v1", "strict-observation-v2"] as const) test(`${policyId} is readable observation, not a selectable execution policy`, () => {
  const wait = projectOwnershipWaitObservation({ version: 1, policyId, waiterId: stepId, state: "validating", outcome: "observed",
    durationMs: 0, waitBudgetMs: 10000, evidenceUse: policyId === "strict-observation-v2" ? "step" : "cache", evidenceOwner: { secret: "PRIVATE_SENTINEL" } });
  expect(wait?.policyId).toBe(policyId); expect(JSON.stringify(wait)).not.toContain("PRIVATE_SENTINEL");
  const progress = projectAuthorityProgress({ version: 1, policyId, phase: "authorized", checkpoint: "finish", check: 1,
    elapsedMs: 0, cumulativeMs: 0, remainingMs: 10000, retries: 0 });
  expect(progress?.policyId).toBe(policyId);
  expect(projectAuthorityProgress({ ...progress, policyId: "arbitrary-relaxed-policy" })).toBeUndefined();
  expect(STRICT_AUTHORITY_POLICY).toMatchObject({ version: 2, id: "strict-observation-v2", evidenceMaxAgeMs: 5000, cacheMs: 2000, stepWaitMs: 10000 });
});
