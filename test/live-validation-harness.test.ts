import { expect, test } from "bun:test";
import { parseLiveIndex, selectLiveScenarios, validateReceipt, READ_ONLY_PROBES } from "../scripts/live-validation.mjs";
import { LEAF_COMMANDS } from "../packages/cli/src/registry.ts";

test("live controller parses scenario routes without freezing a historical inventory or implementation state", () => {
  const rows = parseLiveIndex();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.stableId).toBe(row.id.toUpperCase());
    expect(row.sourceLinks.length).toBeGreaterThan(0);
    expect(row.oracle.length).toBeGreaterThan(0);
    expect(row.currentResult).not.toBeNull();
    expect(["not-run", "awaiting-integration", "ready", "running", "passed", "failed", "blocked", "needs-revalidation", "excluded", "superseded"])
      .toContain(row.currentResult!);
  }
});

test("live result parsing accepts normal state changes without freezing today's index", () => {
  for (const status of ["not-run", "ready", "running", "passed", "failed", "blocked", "needs-revalidation", "excluded", "superseded", "awaiting-integration"]) {
    const fixture = `| <a id="live-fixture"></a>**LIVE-FIXTURE**<br>G1 | \`integrated\`; \`${status}\` | Observe the complete bounded fixture result. | DEP: [source](fixture.md) |`;
    expect(parseLiveIndex(fixture)).toEqual([{
      id: "live-fixture", stableId: "LIVE-FIXTURE", title: "LIVE-FIXTURE", gate: "G1",
      implementation: "integrated", currentResult: status,
      oracle: "Observe the complete bounded fixture result.", blocker: "DEP: [source](fixture.md)", sourceLinks: ["fixture.md"],
    }]);
  }
});

test("receipt validation distinguishes structurally eligible evidence from product acceptance", () => {
  const receipt = {
    version: 1,
    kind: "grokbox-live-receipt",
    windowId: "RC-E2E-test",
    scenario: "live-model-sol-high",
    candidate: {
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceDigest: "a".repeat(64),
      artifactHash: "b".repeat(64),
      loadedIdentities: ["cli:fixed", "modeld:fixed", "host:fixed"],
    },
    window: {
      operator: "maintainer-session",
      lane: "core-runtime",
      authorizationRef: "private:window-authorization",
      targetRef: "private:window-target",
      durationMinutes: 20,
      budget: { currency: "USD", maxCost: 0 },
    },
    evidence: { kind: "native-isolated", candidateBound: true, nativeObservation: true },
    review: {
      reviewerRef: "private:reviewer",
      sessionRef: "private:review-session",
      workPackage: "Q-PREP",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      tipCommit: "0123456789abcdef0123456789abcdef01234567",
      independent: true,
      notImplementer: true,
      result: "accepted",
      findings: [],
      recheck: "accepted",
    },
    steps: [{
      id: "LIVE-MODEL-SOL-HIGH/01",
      status: "passed",
      observation: "The bounded observation completed.",
      evidenceRef: "private:window-receipt-1",
    }],
    cleanup: { state: "complete" },
    notProven: [],
  };
  const priorResult = parseLiveIndex().find((row) => row.id === receipt.scenario)?.currentResult;
  if (typeof priorResult !== "string") throw new Error("receipt scenario has no current result");
  const result = validateReceipt(receipt);
  expect(result.ok).toBe(true);
  expect(result.status).toBe("eligible");
  expect(result.derived.indexEligible).toBe(true);
  expect(result.derived.currentResult).toBe(priorResult);
  expect(parseLiveIndex().find((row) => row.id === receipt.scenario)?.currentResult).toBe(priorResult);

  receipt.evidence.kind = "browser";
  const browserResult = validateReceipt(receipt);
  expect(browserResult.status).toBe("structural-only");
  expect(browserResult.derived.eligibilityReasons).toContain("CORE_REQUIRES_NATIVE");
  receipt.evidence.kind = "native-isolated";
});

test("a structurally valid fixture or self-review never becomes live-eligible", () => {
  const result = validateReceipt({
    version: 1,
    kind: "grokbox-live-receipt",
    windowId: "fixture-window",
    scenario: "live-model-sol-high",
    candidate: {
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      sourceDigest: "a".repeat(64),
      artifactHash: "b".repeat(64),
      loadedIdentities: ["fixture:cli"],
    },
    window: {
      operator: "fixture",
      lane: "core-runtime",
      authorizationRef: "private:fixture",
      targetRef: "private:fixture-target",
      durationMinutes: 1,
      budget: { currency: "USD", maxCost: 0 },
    },
    evidence: { kind: "fixture", candidateBound: true, nativeObservation: false },
    review: {
      reviewerRef: "private:self",
      sessionRef: "private:self-session",
      workPackage: "Q-PREP",
      baseCommit: "0123456789abcdef0123456789abcdef01234567",
      tipCommit: "0123456789abcdef0123456789abcdef01234567",
      independent: false,
      notImplementer: false,
      result: "accepted",
      findings: [],
      recheck: "accepted",
    },
    steps: [{ id: "LIVE-MODEL-SOL-HIGH/01", status: "passed", observation: "Fixture only.", evidenceRef: "private:fixture" }],
    cleanup: { state: "complete" },
    notProven: [],
  });
  expect(result.ok).toBe(true);
  expect(result.status).toBe("structural-only");
  expect(result.derived.indexEligible).toBe(false);
  expect(result.derived.eligibilityReasons).toEqual(expect.arrayContaining([
    "LOADED_IDENTITY_NOT_ACTUAL", "NON_NATIVE_EVIDENCE", "NATIVE_OBSERVATION_MISSING", "INDEPENDENT_REVIEW_NOT_ACCEPTED",
  ]));
});

test("plans and new receipts cannot revive a superseded scenario", () => {
  const rows = parseLiveIndex([
    '| <a id="live-current"></a>**LIVE-CURRENT**<br>G1 | `planned`; `not-run` | Current obligation. | [source](fixture.md) |',
    '| <a id="live-retired"></a>**LIVE-RETIRED**<br>D | `partial`; `superseded` | Replaced obligation. | [source](fixture.md) |',
  ].join("\n"));
  expect(selectLiveScenarios(["LIVE-CURRENT"], rows)).toEqual([rows[0]!]);
  expect(() => selectLiveScenarios([], rows)).toThrow("requires at least one");
  expect(() => selectLiveScenarios(["live-missing"], rows)).toThrow("unknown LIVE scenario");
  expect(() => selectLiveScenarios(["live-current", "live-retired"], rows)).toThrow("superseded LIVE scenario");
  const result = validateReceipt({
    version: 1, kind: "grokbox-live-receipt", windowId: "fixture-window", scenario: "live-retired",
    candidate: { sourceCommit: "0123456789abcdef0123456789abcdef01234567" },
    steps: [{ id: "LIVE-RETIRED/01", status: "passed", observation: "Old contract checked.", evidenceRef: "private:fixture" }],
    cleanup: { state: "complete" }, notProven: [],
  }, rows);
  expect(result.errors).toContain("scenario_superseded");
  expect(result.derived.indexEligible).toBe(false);
});

test("read-only probes use actual registered leaves and declared options, not future syntax", () => {
  for (const [name, argv] of Object.entries(READ_ONLY_PROBES)) {
    const leaf = LEAF_COMMANDS.find(candidate => candidate.path.every((part, index) => argv[index] === part));
    expect(leaf, name).toBeDefined();
    if (!leaf) throw new Error(`unregistered probe: ${name}`);
    expect(leaf.destructive, name).toBe(false);
    for (const flag of argv.slice(leaf.path.length).filter(value => value.startsWith("--"))) {
      expect(leaf.options.some(option => option.flags.split(/[ ,<]/).includes(flag)), `${name}: ${flag}`).toBe(true);
    }
  }
});

test("receipt validation rejects secrets, machine paths and unknown scenarios", () => {
  const receipt = {
    version: 1,
    kind: "grokbox-live-receipt",
    windowId: "RC-E2E-test",
    scenario: "live-does-not-exist",
    candidate: { sourceCommit: "0123456789abcdef0123456789abcdef01234567" },
    steps: [{
      id: "LIVE-UNKNOWN/01",
      status: "passed",
      observation: "Bearer secret-token",
      evidenceRef: "/home/box/private/report.md",
    }],
    cleanup: { state: "complete" },
    notProven: [],
  };
  const result = validateReceipt(receipt);
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("unknown_scenario");
  expect(result.errors).toContain("secret_or_machine_path");
});
