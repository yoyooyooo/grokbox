import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../packages/box-runtime/src/internal/host/live-slices.ts";
import { CONTEXT_SLICE_IDS, profileFromSource } from "../packages/box-runtime/src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "../packages/box-runtime/test/live-shaped-host.ts";
import { retainHostBundle } from "../packages/box-runtime/src/internal/io/provenance.node.ts";
import { captureCli, parseJson } from "./helpers.ts";

function data(stdout: string): Record<string, unknown> {
  return (parseJson(stdout) as { data: Record<string, unknown> }).data;
}

describe("HSO-3 analyze CLI", () => {
  test("missing runner settles with zero effects and refuses leak paths", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso3-cli-analyze-"));
    const outDir = join(boxRuntimeRoot, "private");
    await mkdir(outDir);
    const sha = "a".repeat(64);
    const out = join(outDir, "analysis.json");
    const result = await captureCli(
      ["runtime", "profile", "analyze", "--sha", sha, "--out", out],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(result.code, result.stderr).toBe(0);
    const body = data(result.stdout);
    expect(body.settled).toBe("missing_runner");
    expect(body.approved).toBe(false);
    expect(body.adopt).toBe(false);
    expect(body.published).toBe(false);
    expect(body.effects).toEqual({ uploads: 0, executes: 0, writes: 0, publish: 0, upgradeRpc: 0 });
    expect(body.limitations).toEqual(expect.arrayContaining(["source_directives_are_data", "retained_generation_missing"]));
    expect(body.next).toBe(`grokbox runtime profile observe --from ${LIVE_HOST_BUNDLE}`);
    const envelope = body.envelope as { requiredIds: string[]; sliceReviewRequired: boolean; generationPresent: boolean };
    expect(envelope.requiredIds).toEqual([]);
    expect(envelope.sliceReviewRequired).toBe(false);
    expect(envelope.generationPresent).toBe(false);
    const saved = JSON.parse(await readFile(out, "utf8"));
    expect(saved.settled).toBe("missing_runner");
    expect(saved.next).toBe(body.next);
    expect(saved.envelope.requiredIds).toEqual([]);
    const leak = await captureCli(
      ["runtime", "profile", "analyze", "--sha", sha, "--out", join(boxRuntimeRoot, "reviewed.json")],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(leak.code).toBe(2);
  });

  test("missing runner still emits write-gate reject ids and executable write next", async () => {
    const boxRuntimeRoot = await mkdtemp(join(tmpdir(), "grokbox-hso3-cli-analyze-drift-"));
    // The CLI inspects the current write recipe, not an arbitrary historical
    // toy recipe. A legacy observation must not hide the added context slices.
    const legacy = LIVE_SLICE_PATCHES.filter(slice => !(CONTEXT_SLICE_IDS as readonly string[]).includes(slice.id));
    const before = { source: LIVE_SHAPED_HOST, profile: profileFromSource(LIVE_SHAPED_HOST, legacy, "pre-context") };
    const after = { source: `${LIVE_SHAPED_HOST}\n// owned next generation\n` };
    const pinSha = sha256Text(before.source);
    const nextSha = sha256Text(after.source);
    await retainHostBundle({
      root: boxRuntimeRoot, source: before.source, sourceSha: pinSha, observedAt: "2026-01-01T00:00:00.000Z",
      profile: before.profile, matchedProfileId: before.profile.profileId,
    });
    await mkdir(join(boxRuntimeRoot, "profiles"), { recursive: true, mode: 0o700 });
    await writeFile(join(boxRuntimeRoot, "profiles", "reviewed.json"), `${JSON.stringify(before.profile)}\n`);
    await retainHostBundle({
      root: boxRuntimeRoot, source: after.source, sourceSha: nextSha, observedAt: "2026-01-01T00:00:01.000Z",
    });
    const out = join(boxRuntimeRoot, "private", "analysis.json");
    await mkdir(join(boxRuntimeRoot, "private"));
    const result = await captureCli(
      ["runtime", "profile", "analyze", "--sha", nextSha, "--out", out],
      { discoveryPath: "/dev/null", boxRuntimeRoot },
    );
    expect(result.code, result.stderr).toBe(0);
    const body = data(result.stdout);
    expect(body.settled).toBe("missing_runner");
    expect(body.approved).toBe(false);
    expect(body.adopt).toBe(false);
    const envelope = body.envelope as {
      requiredIds: string[];
      sliceReviewRequired: boolean;
      refusal: string | null;
    };
    expect(envelope.refusal).toBe("envelope_drift");
    expect(new Set(envelope.requiredIds)).toEqual(new Set(CONTEXT_SLICE_IDS));
    expect(envelope.sliceReviewRequired).toBe(true);
    expect(body.next).toBe(
      `grokbox runtime profile write --sha ${nextSha} --slice-review ${envelope.requiredIds.join(",")}`,
    );
    const saved = JSON.parse(await readFile(out, "utf8"));
    expect(saved.settled).toBe("missing_runner");
    expect(saved.next).toBe(body.next);
    expect(saved.envelope.requiredIds).toEqual(envelope.requiredIds);
  });
});
