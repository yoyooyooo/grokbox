import { expect, test } from "bun:test";
import { STRICT_AUTHORITY_POLICY, authorityReadCanRecover, projectOwnershipWaitObservation, projectStreamDiagnostic,
  decideManagedOwnership, OWNERSHIP_LOCAL_SOURCE } from "../src/contract.ts";

const waiterId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceOperationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const observation = { version: 1, policyId: "strict-observation-v1", waiterId, sourceOperationId,
  state: "shared", outcome: "source_deadline", durationMs: 120, waitBudgetMs: 1000,
  sourceBudgetMs: 500, sourceAgeMs: 501, sourceSettlement: "pending" } as const;

test("structural policy keeps strict age and finite resource bounds, not latency-dependent permission", () => {
  expect(STRICT_AUTHORITY_POLICY.evidenceMaxAgeMs).toBe(5000);
  expect(STRICT_AUTHORITY_POLICY.sourceWaitMs).toBe(10000);
  expect(STRICT_AUTHORITY_POLICY.cacheMs).toBe(2000);
  expect(Object.isFrozen(STRICT_AUTHORITY_POLICY)).toBe(true);
  expect(authorityReadCanRecover("ownership_identity_changed")).toBe(false);
  expect(authorityReadCanRecover("native_execution_not_ready")).toBe(false);
  expect(authorityReadCanRecover("ownership_read_timeout")).toBe(true);
  expect(authorityReadCanRecover("ownership_evidence_stale")).toBe(true);
});

test("waiter and source evidence survive the safe authority projection without granting authority", () => {
  expect(projectOwnershipWaitObservation(observation)).toEqual(observation);
  expect(projectStreamDiagnostic({ authority: { reason: "ownership_read_timeout", ownershipWait: observation } }))
    .toMatchObject({ authority: { ownershipWait: observation } });
  const fakePermission = { ...observation, schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE, state: "observed", admitted: true };
  expect(decideManagedOwnership({ agentId: "agent", snapshot: fakePermission, nowMs: 1000 }).ok).toBe(false);
});

test("coordination projection excludes arbitrary IDs, policy names, free-form causes and getters", () => {
  let getterCalls = 0;
  const hostile = { ...observation, token: "PRIVATE_SENTINEL", sourceOperationId: "PRIVATE_SENTINEL" };
  Object.defineProperty(hostile, "sourceAgeMs", { get: () => { getterCalls++; return 1; } });
  const safe = projectOwnershipWaitObservation(hostile);
  expect(getterCalls).toBe(0);
  expect(JSON.stringify(safe)).not.toContain("PRIVATE_SENTINEL");
  expect(safe?.sourceOperationId).toBeUndefined();
  expect(safe?.sourceAgeMs).toBeUndefined();
  for (const change of [{ version: 2 }, { policyId: "unapproved-window" }, { waiterId: "bad" },
    { outcome: "PRIVATE_SENTINEL" }, { state: "infinite-retry" }, { durationMs: -1 }, { waitBudgetMs: Infinity }]) {
    expect(projectOwnershipWaitObservation({ ...observation, ...change })).toBeUndefined();
  }
});
