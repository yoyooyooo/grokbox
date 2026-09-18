import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectNativeOwnershipLocal, OWNERSHIP_LOCAL_SOURCE, projectStreamDiagnostic, streamFailureDiagnostic, presentAuthorityFailure } from "@grokbox/runtime-kernel/contract";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { preflightProfileRecipe, profileFromSource } from "../src/internal/host/profile.ts";
import { retainHostBundle } from "../src/internal/io/provenance.node.ts";
import { retainedGenerationSourcePath } from "../src/internal/io/paths.ts";
import { ownershipUseError } from "../src/internal/io/ownership-admission.node.ts";
import { inspectRetainedWriteEnvelope, writeReviewedProfileFromCopy } from "../src/internal/process/profile.node.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const A = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-01-01T00:00:10.000Z");
const fresh = () => ({
  schemaVersion: 1, source: OWNERSHIP_LOCAL_SOURCE as string, state: "observed", observedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
  scope: { id: "a".repeat(64), stable: true },
  localExecution: { before: { allowed: true, bound: true }, after: { allowed: true, bound: true } },
  localMigrationWindow: { before: { kind: "inactive" }, after: { kind: "inactive" } },
  agents: [{ agentId: A, local: { stable: true, before: { harness: "box", serverId: "1" }, after: { harness: "box", serverId: "1" } } }],
});

test("preflight, analyze and writer preserve the same slice failure and do not publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "grokbox-hcr-recipe-")); roots.push(root);
  const source = LIVE_SHAPED_HOST, sha = sha256Text(source);
  const baseline = profileFromSource(source, LIVE_SLICE_PATCHES, "baseline");
  await retainHostBundle({ root, source, sourceSha: sha, observedAt: new Date(now).toISOString(), profile: baseline });
  const input = { destDir: join(root, "profiles"), hostBundle: retainedGenerationSourcePath(root, sha) };
  await writeReviewedProfileFromCopy(input);
  const before = await readFile(join(input.destDir, "reviewed.json"), "utf8");
  const broken = LIVE_SLICE_PATCHES.map(slice => slice.id === "alert-main-decision" ? { ...slice, find: slice.find + "missing-fixture-only" } : slice);
  const failure = { ok: false, code: "find-missing", sliceId: "alert-main-decision" } as const;
  expect(preflightProfileRecipe(source, broken)).toEqual(failure);
  const inspect = await inspectRetainedWriteEnvelope(root, sha, broken);
  expect(inspect).toMatchObject({ refusal: "recipe_unapplicable", recipeFailure: failure, sliceReviewRequired: false, requiredIds: [] });
  expect(inspect.limitations).toContain("recipe_unapplicable");
  expect(inspect.next).toContain("runtime profile propose --from");
  expect(inspect.next).not.toContain("profile write");
  await expect(writeReviewedProfileFromCopy({ ...input, slices: broken, lineage: { root, retainedSha: sha } }))
    .rejects.toMatchObject({ refusal: "recipe_unapplicable", next: inspect.next, details: { recipeFailure: failure } });
  expect(await readFile(join(input.destDir, "reviewed.json"), "utf8")).toBe(before);
  expect(await readFile(input.hostBundle, "utf8")).toBe(source);
});

test("valid local witness stays qualified; execution pause is not a bridge format failure", () => {
  expect(inspectNativeOwnershipLocal({ agentId: A, nowMs: now, snapshot: fresh() })).toMatchObject({ valid: true, ready: true, failure: null });
  const paused = fresh(); paused.localExecution.after.allowed = false;
  expect(inspectNativeOwnershipLocal({ agentId: A, nowMs: now, snapshot: paused })).toMatchObject({ valid: true, ready: false, failure: null });
});

const cases: Array<[string, (value: ReturnType<typeof fresh>) => void]> = [
  ["source_mismatch", v => { v.source = "Host.official-client/ListGrokBotAgents"; }],
  ["schema_mismatch", v => { v.schemaVersion = 3; }],
  ["observation_unavailable", v => { v.state = "unavailable"; }],
  ["scope_unavailable", v => { v.scope.id = "unknown"; }],
  ["scope_changed", v => { v.scope.stable = false; }],
  ["target_missing", v => { v.agents = []; }],
  ["target_ambiguous", v => { v.agents.push(v.agents[0]!); }],
  ["target_limit", v => { v.agents = Array.from({ length: 33 }, () => v.agents[0]!); }],
  ["clock_invalid", v => { v.completedAt = new Date(now + 1).toISOString(); }],
  ["clock_invalid", v => { v.completedAt = new Date(now - 1).toISOString(); }],
  ["evidence_expired", v => { v.observedAt = new Date(now - 5001).toISOString(); }],
];
for (const [failure, mutate] of cases) test(`local witness remains refused with finite ${failure}`, () => {
  const value = fresh(); mutate(value);
  const witness = inspectNativeOwnershipLocal({ agentId: A, nowMs: now, snapshot: value });
  expect(witness).toMatchObject({ valid: false, ready: false, failure });
  const error = ownershipUseError("ownership_bridge_unavailable", "unavailable", A, undefined, { localWitnessFailure: witness.failure! });
  expect(streamFailureDiagnostic(error)?.authority).toMatchObject({ reason: "ownership_bridge_unavailable", localWitnessFailure: failure });
});

test("diagnostic projection rejects arbitrary strings, accessors and unrelated reasons", () => {
  let calls = 0;
  const raw = { reason: "ownership_bridge_unavailable" as const, get localWitnessFailure() { calls++; return "scope_changed"; } };
  expect(projectStreamDiagnostic({ authority: raw })?.authority).toEqual({ reason: raw.reason });
  expect(calls).toBe(0);
  expect(projectStreamDiagnostic({ authority: { reason: raw.reason, localWitnessFailure: "private-source-text" } })?.authority).toEqual({ reason: raw.reason });
  expect(projectStreamDiagnostic({ authority: { reason: "confirmed_temporal", localWitnessFailure: "scope_changed" } })?.authority).toEqual({ reason: "confirmed_temporal" });
});

test("expiry and unstable scope do not recommend component alignment", () => {
  for (const localWitnessFailure of ["evidence_expired", "scope_changed"] as const) {
    expect(presentAuthorityFailure({ reason: "ownership_bridge_unavailable", localWitnessFailure }, { agentId: A }).action).toBe("inspect_local_runtime");
  }
  expect(presentAuthorityFailure({ reason: "ownership_bridge_unavailable", localWitnessFailure: "source_mismatch" }).action).toBe("align_local_components");
});
