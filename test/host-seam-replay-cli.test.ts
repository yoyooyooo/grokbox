import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../packages/box-runtime/src/internal/host/live-slices.ts";
import { profileFromSource } from "../packages/box-runtime/src/internal/host/profile.ts";
import { observeHostProvenance } from "../packages/box-runtime/src/internal/ops/host-seam/observe.ts";
import { bindReviewedProfile, writeGoldenLabels, type GoldenSiteLabel } from "../packages/box-runtime/src/internal/ops/host-seam/replay.ts";
import { LIVE_SHAPED_HOST } from "../packages/box-runtime/test/live-shaped-host.ts";
import { snapshotTree } from "../packages/box-runtime/test/observation-fixture.ts";
import { captureCli, parseJson } from "./helpers.ts";

const TWO_LIVE = LIVE_SLICE_PATCHES.filter((slice) => slice.id === "create-session" || slice.id === "agent-id");

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

function pin(source: string): GoldenSiteLabel[] {
  return (["create-session", "agent-id"] as const).map((sliceId) => {
    const slice = TWO_LIVE.find((item) => item.id === sliceId)!;
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

describe("HSO-2 replay CLI", () => {
  test("reviewed A exits 0; B LIVE recipe support gate is non-zero; --all does not 0/0 missing corpus", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso2-cli-"));
    const hostA = join(boxRuntimeRoot, "a.cjs");
    const hostB = join(boxRuntimeRoot, "b.cjs");
    await writeFile(hostA, LIVE_SHAPED_HOST);
    await writeFile(hostB, `${LIVE_SHAPED_HOST}\n// B\n`);
    const deps = { discoveryPath: "/dev/null" as const, boxRuntimeRoot };
    expect((await captureCli(["runtime", "profile", "observe", "--from", hostA], deps)).code).toBe(0);
    expect((await captureCli(["runtime", "profile", "observe", "--from", hostB], deps)).code).toBe(0);
    const shaA = sha256Text(LIVE_SHAPED_HOST);
    const shaB = sha256Text(`${LIVE_SHAPED_HOST}\n// B\n`);
    const profile = profileFromSource(LIVE_SHAPED_HOST, TWO_LIVE, "reviewed-a");
    await bindReviewedProfile(boxRuntimeRoot, shaA, profile);
    await writeGoldenLabels(boxRuntimeRoot, shaA, pin(LIVE_SHAPED_HOST));

    const replayA = await captureCli(["runtime", "profile", "replay", "--sha", shaA], deps);
    expect(replayA.code, replayA.stderr).toBe(0);
    expect(data(replayA.stdout).supportGatePassed).toBe(true);

    const replayB = await captureCli(["runtime", "profile", "replay", "--sha", shaB], deps);
    expect(replayB.code).not.toBe(0);
    expect(data(replayB.stdout).supportGatePassed).toBe(false);
    const rows = data(replayB.stdout).rows as Array<{ support: string }>;
    expect(rows.every((row) => row.support === "unique_unreviewed")).toBe(true);

    const both = await captureCli(["runtime", "profile", "replay", "--sha", shaA, "--all"], deps);
    expect(both.code).toBe(2);

    const empty = await mkdtemp(join(tmpdir(), "grokbox-hso2-cli-empty-"));
    const missing = await captureCli(["runtime", "profile", "replay", "--all"], {
      discoveryPath: "/dev/null",
      boxRuntimeRoot: empty,
    });
    expect(missing.code).not.toBe(0);
    expect(data(missing.stdout).corpus).toBe("missing");
    expect(data(missing.stdout).supportGatePassed).toBe(false);
  });

  test("profile status is read-only and does not reuse stale green as adopt", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso2-status-cli-"));
    const host = join(boxRuntimeRoot, "a.cjs");
    await writeFile(host, LIVE_SHAPED_HOST);
    const deps = { discoveryPath: "/dev/null" as const, boxRuntimeRoot };
    await captureCli(["runtime", "profile", "observe", "--from", host], deps);
    const before = await snapshotTree(boxRuntimeRoot);
    const status = await captureCli(["runtime", "profile", "status"], deps);
    expect(status.code, status.stderr).toBe(0);
    expect(data(status.stdout).adoptEligibility).toBe(false);
    expect((data(status.stdout).upstreamUpgrade as { pointerFreshness: string }).pointerFreshness).toBe("unknown");
    const envelopeDrift = data(status.stdout).envelopeDrift as { evidenceKind: string; state: string };
    expect(envelopeDrift.evidenceKind).toBe("envelope-windows");
    expect(envelopeDrift.state).toBe("missing");
    expect(await snapshotTree(boxRuntimeRoot)).toEqual(before);
  });
});
