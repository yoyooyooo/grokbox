import { expect, test } from "bun:test";
import { parseLiveIndex, validateReceipt } from "../scripts/live-validation.mjs";

test("live controller parses the current index without creating a second status source", () => {
  const rows = parseLiveIndex();
  expect(rows.length).toBeGreaterThanOrEqual(69);
  const model = rows.find((row) => row.id === "live-model-sol-high");
  expect(model).toBeDefined();
  if (!model) throw new Error("model scenario missing from LIVE index");
  expect(model).toMatchObject({
    stableId: "LIVE-MODEL-SOL-HIGH",
    gate: "G1",
    implementation: "integrated",
    currentResult: "not-run",
  });
  expect(model.sourceLinks.length).toBeGreaterThan(0);
});

test("receipt validation distinguishes structurally eligible evidence from product acceptance", () => {
  const receipt = {
    version: 1,
    kind: "grokbox-live-receipt",
    windowId: "RC-E2E-test",
    scenario: "live-model-sol-high",
    candidate: { sourceCommit: "0123456789abcdef0123456789abcdef01234567" },
    steps: [{
      id: "LIVE-MODEL-SOL-HIGH/01",
      status: "passed",
      observation: "The bounded observation completed.",
      evidenceRef: "private:window-receipt-1",
    }],
    cleanup: { state: "complete" },
    notProven: [],
  };
  const result = validateReceipt(receipt);
  expect(result.ok).toBe(true);
  expect(result.derived.indexEligible).toBe(true);
  expect(result.derived.currentResult).toBe("not-run");
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
