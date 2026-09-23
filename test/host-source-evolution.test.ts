import { expect, test } from "bun:test";
import { describeHostSourceEvolution } from "../scripts/host-source-evolution.ts";
const reference = { host: "a".repeat(64), worker: "b".repeat(64) };
test("unchanged bytes are not proof of loaded health or adoption", () => {
  expect(describeHostSourceEvolution(reference, reference, "applicable-not-reviewed")).toMatchObject({
    identityState: "unchanged", changedComponents: [], interpretation: "same-source-not-full-health",
    loadedState: "not-observed", adoptionAuthorized: false,
  });
});
for (const changed of [["host"], ["worker"], ["host", "worker"]] as const) test(`drift ${changed.join("+")} retains prior scope without inventing a regression`, () => {
  const observed = { ...reference }; for (const key of changed) observed[key] = "c".repeat(64);
  const result = describeHostSourceEvolution(reference, observed, "applicable-not-reviewed");
  expect(result).toMatchObject({ identityState: "changed", changedComponents: [...changed],
    interpretation: "source-change-needs-abi-proof", historicalEvidence: "retained-for-exact-source", adoptionAuthorized: false });
  expect(result.reference).toEqual(reference); expect(result.observed).toEqual(observed);
  observed.host = "d".repeat(64); expect(result.observed.host).not.toBe(observed.host);
});
test("actual recipe failure is distinct from a digest change", () => {
  expect(describeHostSourceEvolution(reference, { ...reference, host: "c".repeat(64) }, "mismatch").interpretation).toBe("recipe-regression");
  expect(describeHostSourceEvolution(reference, reference, "mismatch").interpretation).toBe("recipe-regression");
});
test("invalid identities and unrecognized recipe states cannot enter an observation", () => {
  expect(() => describeHostSourceEvolution(reference, { ...reference, worker: "unknown" }, "mismatch")).toThrow();
  expect(() => describeHostSourceEvolution(reference, reference, "passed" as never)).toThrow();
});

test("report exposes only the declared source digests, not caller metadata", () => {
  const withMetadata = { ...reference, secret: "synthetic-private-metadata" };
  expect(describeHostSourceEvolution(withMetadata, withMetadata, "mismatch").reference).toEqual(reference);
  expect(JSON.stringify(describeHostSourceEvolution(withMetadata, withMetadata, "mismatch"))).not.toContain("synthetic-private");
});
