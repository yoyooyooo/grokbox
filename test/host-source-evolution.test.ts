import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describeHostSourceEvolution, projectHostSourceEvolution } from "../packages/runtime-kernel/src/host-source-evolution.ts";
const reference = { host: "a".repeat(64), worker: "b".repeat(64) };
test("explicit comparison digests must be a full pair before any source capture", () => {
  for (const args of [["--reference-host-sha", "a".repeat(64)], ["--reference-host-sha", "latest", "--reference-worker-sha", "b".repeat(64)]]) {
    const result=spawnSync(process.execPath,["scripts/qualify-host-health.ts","--source","/unavailable/source","--worker","/unavailable/worker","--binary-directory","/unavailable/verifier",...args],
      {cwd:resolve(import.meta.dir,".."),env:{PATH:process.env.PATH},encoding:"utf8",timeout:10000});
    expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stderr).toContain("reference_requires_exact_host_worker_digests");
    expect(result.stdout).toBe("");
  }
});

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

test("recipe, semantic, ABI and coverage facts stay separate from source identity", () => {
  const row = { id: "native.message", revision: 1, code: "field-changed" };
  const result = describeHostSourceEvolution(reference, reference, "applicable-not-reviewed", {
    semantics: { state: "passed", failed: [], unsupported: [] },
    nativeAbi: { state: "failed", failed: [row], unsupported: [] }, uncoveredSlices: ["create-session"],
  });
  expect(result.identityState).toBe("unchanged"); expect(result.recipeState).toBe("applicable-not-reviewed");
  expect(result.semantics.state).toBe("passed"); expect(result.nativeAbi.failed).toEqual([row]);
  expect(result.coverage.state).toBe("incomplete"); expect(result.adoptionAuthorized).toBe(false);
  expect(projectHostSourceEvolution(result)).toEqual(result);
  const unknown = describeHostSourceEvolution(reference, reference, "applicable-not-reviewed");
  expect(unknown.nativeAbi.state).toBe("not-run"); expect(unknown.semantics.state).toBe("not-run"); expect(unknown.coverage.state).toBe("not-evaluated");
});

test("failed complete recipe retains exact slice/code without inventing a native ABI failure", () => {
  const result = describeHostSourceEvolution(reference, { ...reference, worker: "c".repeat(64) }, "mismatch", {
    recipeFailure: { code: "match-count", sliceId: "compact-register" }, uncoveredSlices: [],
  });
  expect(result.changedComponents).toEqual(["worker"]); expect(result.recipeFailure?.sliceId).toBe("compact-register");
  expect(result.nativeAbi.state).toBe("not-run"); expect(result.adoptionAuthorized).toBe(false);
  expect(projectHostSourceEvolution({ ...result, secret: "private-source" })).toBeNull();
  expect(projectHostSourceEvolution({ ...result, nativeAbi: { state: "passed", failed: [{ id: "native.message", revision: 1, code: "broken" }], unsupported: [] } })).toBeNull();
  expect(projectHostSourceEvolution({ ...result, reference: { ...reference, path: "/private" } })).toBeNull();
});
