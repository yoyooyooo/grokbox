import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { profileFromSource, type SlicePatch } from "../src/internal/host/profile.ts";
import { observeHostProvenance } from "../src/internal/ops/host-seam/observe.ts";
import {
  assertReplayCoverage,
  bindReviewedProfile,
  liveKnifeRecipe,
  readLastReplayReport,
  replayHostSeam,
  writeGoldenLabels,
  writeReplayReport,
  type GoldenSiteLabel,
} from "../src/internal/ops/host-seam/replay.ts";
import { projectHostSeamStatus } from "../src/internal/ops/host-seam/seam-status.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";
import { snapshotTree } from "./observation-fixture.ts";

const TWO_LIVE = LIVE_SLICE_PATCHES.filter((slice) => slice.id === "create-session" || slice.id === "agent-id");

function pin(source: string, slices: readonly SlicePatch[]): GoldenSiteLabel[] {
  return (["create-session", "agent-id"] as const).map((sliceId) => {
    const slice = slices.find((item) => item.id === sliceId);
    if (!slice) throw new Error(sliceId);
    const start = source.indexOf(slice.startAnchor);
    const end = source.indexOf(slice.endAnchor, start);
    return {
      sliceId,
      startByte: Buffer.byteLength(source.slice(0, start), "utf8"),
      endByte: Buffer.byteLength(source.slice(0, end), "utf8"),
      role: sliceId,
      source: "human-review" as const,
    };
  });
}

async function retain(root: string, from: string, body: string, at: string): Promise<string> {
  await writeFile(from, body);
  const receipt = await observeHostProvenance({ root, from, now: () => at });
  return receipt.observedSha;
}

describe("HSO-2 loud replay", () => {
  test("reviewed A matches; B+old profile is unknown-sha; B+LIVE recipe stays unreviewed", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso2-ab-"));
    const hostA = join(root, "a.cjs");
    const hostB = join(root, "b.cjs");
    const shaA = await retain(root, hostA, LIVE_SHAPED_HOST, "2026-01-01T00:00:00.000Z");
    const bodyB = `${LIVE_SHAPED_HOST}\n// generation-B\n`;
    const shaB = await retain(root, hostB, bodyB, "2026-01-01T00:00:01.000Z");
    const profileA = profileFromSource(LIVE_SHAPED_HOST, TWO_LIVE, "reviewed-a");
    await bindReviewedProfile(root, shaA, profileA);
    await writeGoldenLabels(root, shaA, pin(LIVE_SHAPED_HOST, TWO_LIVE));
    const replayA = await replayHostSeam({ root, sha: shaA, profile: profileA });
    assertReplayCoverage(replayA);
    expect(replayA.supportGatePassed).toBe(true);
    expect(replayA.rows.every((row) => row.support === "reviewed_match" && row.goldenState === "match")).toBe(true);

    const stale = await replayHostSeam({ root, sha: shaB, profile: profileA });
    expect(stale.rows).toHaveLength(2);
    expect(stale.rows.every((row) => row.code === "unknown-sha" && row.support === "unknown-sha")).toBe(true);
    expect(stale.regressionPassed).toBe(true);
    expect(stale.supportGatePassed).toBe(false);

    const liveB = await replayHostSeam({ root, sha: shaB, liveRecipe: true });
    expect(liveB.rows).toHaveLength(2);
    expect(liveB.rows.every((row) => row.support === "unique_unreviewed")).toBe(true);
    expect(liveB.supportGatePassed).toBe(false);
  });

  test("matrix keeps both slice rows; corrupt/missing/truncated/stale cache are non-green", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso2-fail-"));
    const missing = await replayHostSeam({ root, all: true });
    expect(missing.corpus).toBe("missing");
    expect(missing.supportGatePassed).toBe(false);
    expect(() => assertReplayCoverage({ ...missing, regressionPassed: true })).toThrow(/0\/0/);

    const host = join(root, "a.cjs");
    const sha = await retain(root, host, SYNTHETIC_HOST, "2026-01-01T00:00:00.000Z");
    await writeFile(join(root, "host-bundles", "generations", sha, "source"), "truncated-not-matching-sha");
    const corrupt = await replayHostSeam({ root, sha, liveRecipe: true });
    expect(corrupt.rows).toHaveLength(2);
    expect(corrupt.rows[1]?.sliceId).toBe("agent-id");
    expect(corrupt.codes).toContain("corpus_corrupt");
    expect(corrupt.supportGatePassed).toBe(false);

    const skip = await replayHostSeam({ root, all: true, skipShas: [sha] });
    expect(() => assertReplayCoverage(skip)).toThrow(/skipped/);

    const empty = await mkdtemp(join(tmpdir(), "grokbox-hso2-empty-"));
    const sha2 = await retain(empty, join(empty, "a.cjs"), LIVE_SHAPED_HOST, "2026-01-01T00:00:00.000Z");
    await writeFile(join(empty, "host-bundles", "generations", sha2, "reviewed-profile.sha"), `${"f".repeat(64)}\n`);
    const noCopy = await replayHostSeam({ root: empty, sha: sha2 });
    expect(noCopy.codes).toContain("missing_profile");
    expect(noCopy.rows).toHaveLength(2);

    const staleRoot = await mkdtemp(join(tmpdir(), "grokbox-hso2-stale-"));
    const s = await retain(staleRoot, join(staleRoot, "a.cjs"), LIVE_SHAPED_HOST, "2026-01-01T00:00:00.000Z");
    const profile = profileFromSource(LIVE_SHAPED_HOST, TWO_LIVE, "reviewed-a");
    await bindReviewedProfile(staleRoot, s, profile);
    await writeGoldenLabels(staleRoot, s, pin(LIVE_SHAPED_HOST, TWO_LIVE));
    const good = await replayHostSeam({ root: staleRoot, sha: s, profile });
    await writeReplayReport(staleRoot, { ...good, toolRevision: "old-tool", recipeRevision: "old-recipe" });
    const status = await projectHostSeamStatus({ root: staleRoot });
    expect(status.replay.staleGreen).toBe(true);
    expect(status.replay.supportGatePassed).toBeNull();
    expect(status.adoptEligibility).toBe(false);
  });

  test("unique-but-wrong site vs independent golden is loud fail", async () => {
    const decoy = SYNTHETIC_HOST.replace(
      "module.exports = { createSession, runTurn };",
      "function unusedFactory() {\n  const session = { kind: \"decoy\" };\n  return session;\n}\nmodule.exports = { createSession, runTurn };",
    );
    const wrong: SlicePatch[] = [
      {
        id: "create-session",
        startAnchor: "function unusedFactory() {",
        endAnchor: "module.exports = { createSession, runTurn };",
        find: "  return session;\n",
        replacement: "  return session;\n  void 0;\n",
      },
      SYNTHETIC_SLICES[1]!,
    ];
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso2-wrong-"));
    const from = join(root, "host.cjs");
    const sha = await retain(root, from, decoy, "2026-01-01T00:00:00.000Z");
    const profile = profileFromSource(decoy, wrong, "wrong-site");
    await bindReviewedProfile(root, sha, profile);
    await writeGoldenLabels(root, sha, pin(decoy, SYNTHETIC_SLICES));
    const replay = await replayHostSeam({ root, sha, profile });
    expect(replay.rows[0]?.goldenState).toBe("mismatch");
    expect(replay.rows[0]?.support).toBe("wrong-site");
    expect(replay.supportGatePassed).toBe(false);
    const matcherUpdated = pin(decoy, wrong);
    expect(matcherUpdated[0]?.startByte).not.toBe(pin(decoy, SYNTHETIC_SLICES)[0]?.startByte);
  });

  test("status facets distinguish pending/staged/mixed/pid-only/helper-only and do not mutate", async () => {
    const root = await mkdtemp(join(tmpdir(), "grokbox-hso2-status-"));
    const sha = await retain(root, join(root, "a.cjs"), LIVE_SHAPED_HOST, "2026-01-01T00:00:00.000Z");
    const previous = {
      schemaVersion: 1 as const,
      installed: { entrySha: sha, version: "bb6a405", companionDigest: "c".repeat(64) },
      loaded: { hostPid: 1, start: 10, compileReceiptSha: "unknown" as const },
    };
    const pid = await projectHostSeamStatus({
      root,
      previousSense: previous,
      sense: { ...previous, loaded: { hostPid: 2, start: 11, compileReceiptSha: "unknown" } },
    });
    expect(pid.loadedHost.pidOnly).toBe(true);
    expect(pid.loadedHost.helperOnly).toBe(false);
    expect(pid.upstreamUpgrade.pointerFreshness).toBe("unknown");
    const helper = await projectHostSeamStatus({
      root,
      previousSense: previous,
      sense: { ...previous, installed: { ...previous.installed, companionDigest: "d".repeat(64) } },
    });
    expect(helper.loadedHost.helperOnly).toBe(true);
    const mixed = await projectHostSeamStatus({
      root,
      sense: { schemaVersion: 1, marker: { kind: "failed", present: true, version: "bb6a405" } },
    });
    expect(mixed.installation.mixed).toBe(true);
    expect(mixed.installation.rollbackRisk).toBe("unknown");
    const pending = await projectHostSeamStatus({
      root,
      sense: { schemaVersion: 1, staged: { pending: true, archiveDigest: "e".repeat(64) }, rpc: { accepted: true } },
    });
    expect(pending.upstreamUpgrade.pending).toBe(true);
    expect(pending.upstreamUpgrade.staged).toBe(true);
    const before = await snapshotTree(root);
    await projectHostSeamStatus({ root, sha });
    expect(await snapshotTree(root)).toEqual(before);
    expect(readLastReplayReport(root)).resolves.toBeNull();
  });
});
