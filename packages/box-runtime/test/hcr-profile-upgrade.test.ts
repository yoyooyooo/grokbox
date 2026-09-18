import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { OBSERVATION_SLICE_IDS, profileFromSource, type SliceId, type SlicePatch } from "../src/internal/host/profile.ts";
import { retainHostBundle } from "../src/internal/io/provenance.node.ts";
import { retainedGenerationSourcePath } from "../src/internal/io/paths.ts";
import { inspectRetainedWriteEnvelope, writeReviewedProfileFromCopy } from "../src/internal/process/profile.node.ts";
import { acquireAdvisoryGate } from "../src/internal/io/advisory-gate.node.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const linuxTest = process.platform === "linux" ? test : test.skip;
const targets: SliceId[] = ["ownership-read-schema", "ownership-read-api", "ownership-resume-gate"];
function legacySlices(): SlicePatch[] {
  return LIVE_SLICE_PATCHES.filter(slice => !(OBSERVATION_SLICE_IDS as readonly string[]).includes(slice.id)).map(slice => ({ ...slice,
    replacement: slice.id === "ownership-read-api" ? slice.replacement.replace("localOnly: grokboxOwnershipLocalOnly === true", "localOnly: false").replace("read.capabilities(1)", "read.capabilities(0)") : slice.replacement,
  }));
}
async function fixture(source = LIVE_SHAPED_HOST, slices = legacySlices()) {
  const root = await fs.mkdtemp(join(tmpdir(), "grokbox-hcr-upgrade-")); roots.push(root);
  const sha = sha256Text(source), profile = profileFromSource(source, slices, "baseline");
  await retainHostBundle({ root, source, sourceSha: sha, observedAt: "2026-01-01T00:00:00.000Z", profile });
  const input = { destDir: join(root, "profiles"), hostBundle: retainedGenerationSourcePath(root, sha), lineage: { root, retainedSha: sha } };
  await writeReviewedProfileFromCopy({ ...input, slices, profileId: profile.profileId });
  const path = join(input.destDir, "reviewed.json"), before = await fs.readFile(path, "utf8");
  return { root, sha, source, slices, input: { ...input, expectedReviewedSha: sha256Text(before) }, path, before };
}

linuxTest("bounded capability upgrade bypasses no required dependency and preserves all non-target slices", async () => {
  const alert = LIVE_SLICE_PATCHES.find(slice => slice.id === "alert-main-decision")!;
  const f = await fixture(LIVE_SHAPED_HOST.replace(alert.find, "/* unrelated changed alert implementation */"));
  expect((await inspectRetainedWriteEnvelope(f.root, f.sha)).refusal).toBe("recipe_unapplicable");
  const inspected = await inspectRetainedWriteEnvelope(f.root, f.sha, undefined, "ownership-local");
  expect(inspected.refusal).toBeNull();
  expect(inspected.next).toContain("--capability ownership-local");
  expect(inspected.next).toContain(`--expected-reviewed-sha ${sha256Text(f.before)}`);
  const result = await writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local" });
  expect(result.capabilityUpgrade).toMatchObject({ capability: "ownership-local", baselineProfileSha256: sha256Text(f.before), addedIds: [] });
  expect(result.profile.slices).toHaveLength(f.slices.length);
  for (const slice of result.profile.slices) {
    expect(slice).toEqual((targets.includes(slice.id) ? LIVE_SLICE_PATCHES.find(row => row.id === slice.id) : f.slices.find(row => row.id === slice.id))!);
  }
  expect(await fs.readFile(f.input.hostBundle, "utf8")).toBe(f.source);
});

linuxTest("a target seam failure still refuses with the exact slice; no arbitrary fallback", async () => {
  const source = LIVE_SHAPED_HOST.replace("var hostStatusArgs = rpcObject({", "var historicalStatusArgs = rpcObject({");
  const slices = legacySlices().map(slice => slice.id === "ownership-read-schema" ? { ...slice, startAnchor: "var historicalStatusArgs = rpcObject({" } : slice);
  const f = await fixture(source, slices);
  const inspected = await inspectRetainedWriteEnvelope(f.root, f.sha, undefined, "ownership-local");
  expect(inspected).toMatchObject({ refusal: "recipe_unapplicable", recipeFailure: { code: "anchor-missing", sliceId: "ownership-read-schema" } });
  expect(inspected.next).not.toContain("profile write");
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local" })).rejects.toMatchObject({ refusal: "recipe_unapplicable" });
  expect(await fs.readFile(f.path, "utf8")).toBe(f.before);
});

linuxTest("missing baseline, wrong source, unsupported selectors and unretained selection refuse", async () => {
  const f = await fixture();
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "skip-alerts" })).rejects.toMatchObject({ code: "invalid_usage" });
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local", slices: f.slices })).rejects.toMatchObject({ code: "invalid_usage" });
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local", lineage: { root: f.root, allowUnretained: true } })).rejects.toMatchObject({ code: "invalid_usage" });
  await fs.writeFile(f.path, JSON.stringify({ ...JSON.parse(f.before), sourceSha256: "a".repeat(64) }));
  await expect(inspectRetainedWriteEnvelope(f.root, f.sha, undefined, "ownership-local")).rejects.toMatchObject({ refusal: "capability_baseline_invalid" });
  await fs.unlink(f.path);
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local" })).rejects.toMatchObject({ refusal: "capability_baseline_invalid" });
});

linuxTest("a concurrent baseline replacement cannot be overwritten by a stale capability writer", async () => {
  const f = await fixture();
  const winner = JSON.stringify({ ...JSON.parse(f.before), profileId: "concurrent-winner" }) + "\n";
  const original = fs.writeFile;
  const spy = spyOn(fs, "writeFile").mockImplementation(async (path, body, options) => {
    await original(path, body, options);
    if (String(path).includes(".reviewed-")) await original(f.path, winner);
  });
  try {
    await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local" })).rejects.toMatchObject({ refusal: "capability_baseline_changed" });
    expect(await fs.readFile(f.path, "utf8")).toBe(winner);
  } finally { spy.mockRestore(); }
});

linuxTest("analysis approval is bound to the baseline bytes across separate commands", async () => {
  const f = await fixture();
  const inspection = await inspectRetainedWriteEnvelope(f.root, f.sha, undefined, "ownership-local");
  expect(inspection.capabilityUpgrade?.baselineProfileSha256).toBe(sha256Text(f.before));
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local", expectedReviewedSha: undefined })).rejects.toMatchObject({ code: "invalid_usage" });
  const replacement = JSON.stringify({ ...JSON.parse(f.before), profileId: "changed-after-analysis" }) + "\n";
  await fs.writeFile(f.path, replacement);
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local" })).rejects.toMatchObject({ refusal: "capability_baseline_changed" });
  expect(await fs.readFile(f.path, "utf8")).toBe(replacement);
});

linuxTest("the complete dependency set is proposed, but an unmeasurable baseline cannot bypass golden review", async () => {
  const f = await fixture(LIVE_SHAPED_HOST, legacySlices().filter(slice => !targets.includes(slice.id)));
  const inspection = await inspectRetainedWriteEnvelope(f.root, f.sha, undefined, "ownership-local");
  expect(inspection.capabilityUpgrade?.addedIds).toEqual(targets);
  expect(inspection.refusal).toBe("missing_golden");
  await expect(writeReviewedProfileFromCopy({ ...f.input, capability: "ownership-local", lineage: { ...f.input.lineage, sliceReview: inspection.requiredIds } })).rejects.toMatchObject({ refusal: "missing_golden" });
  expect(await fs.readFile(f.path, "utf8")).toBe(f.before);
});

linuxTest("the kernel gate survives helper exit, rejects a competitor, and releases with its descriptor", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "grokbox-hcr-gate-")); roots.push(root);
  const path = join(root, "writer.gate");
  const gate = await acquireAdvisoryGate(path);
  expect(gate).not.toBeNull();
  const before = await fs.stat(path);
  try { expect(await acquireAdvisoryGate(path)).toBeNull(); } finally { await gate?.release(); }
  const next = await acquireAdvisoryGate(path);
  expect(next).not.toBeNull();
  await next?.release();
  expect((await fs.stat(path)).ino).toBe(before.ino);
});
