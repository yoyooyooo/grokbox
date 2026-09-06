import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../src/hash.ts";
import { writeReviewedProfileFromCopy } from "../src/h3-live.ts";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/live-slices.ts";
import { loadDurableReviewedProfile } from "../src/reviewed-profile.ts";
import { reviewedProfilePath } from "../src/paths.ts";
import { applyPatchProfile } from "../src/transform.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";

async function liveSnapshot(): Promise<{ digest: string | null; pids: string[] }> {
  let digest: string | null = null;
  try {
    digest = sha256Bytes(await readFile(LIVE_HOST_BUNDLE));
  } catch {
    digest = null;
  }
  const pids: string[] = [];
  try {
    const proc = Bun.spawn(["ps", "-eo", "pid,args"], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of text.split("\n")) {
      if (line.includes("host-main.cjs")) pids.push(line.trim().split(/\s+/, 1)[0] ?? "");
    }
  } catch {
    /* ignore */
  }
  return { digest, pids: pids.filter(Boolean) };
}

describe("offline reviewed profile authoring", () => {
  test("writes reviewed.json from synthetic hostBundle + slices under disposable destDir", async () => {
    const before = await liveSnapshot();
    const root = await mkdtemp(join(tmpdir(), "grokbox-reviewed-root-"));
    const destDir = join(root, "profiles");
    const hostBundle = join(root, "synthetic-host.cjs");
    await writeFile(hostBundle, SYNTHETIC_HOST);
    const originalBundle = await readFile(hostBundle, "utf8");

    const written = await writeReviewedProfileFromCopy({
      destDir,
      hostBundle,
      slices: SYNTHETIC_SLICES,
      profileId: "offline-synth",
    });

    expect(written.profilePath).toBe(join(destDir, "reviewed.json"));
    expect(written.profile.profileId).toBe("offline-synth");
    expect(written.sourceSha256).toBe(written.profile.sourceSha256);
    expect(written.transformedSourceSha256).toBe(written.profile.transformedSourceSha256);
    expect(written.diskSha).toBe(sha256Bytes(Buffer.from(SYNTHETIC_HOST, "utf8")));
    expect(written.sourceSha256.length).toBe(64);
    expect(written.transformedSourceSha256.length).toBe(64);
    expect(written.transformedSourceSha256).not.toBe(written.sourceSha256);

    const onDisk = JSON.parse(await readFile(written.profilePath, "utf8"));
    expect(onDisk).toEqual(written.profile);
    expect(loadDurableReviewedProfile(root)).toEqual(written.profile);
    expect(reviewedProfilePath(root)).toBe(written.profilePath);

    const source = await readFile(written.copyPath, "utf8");
    const applied = applyPatchProfile(source, written.profile);
    expect(applied.ok).toBe(true);

    // Source bundle and live Host untouched.
    expect(await readFile(hostBundle, "utf8")).toBe(originalBundle);
    const after = await liveSnapshot();
    expect(after).toEqual(before);
  });

  test("live-shaped fixture authors with default LIVE_SLICE_PATCHES without live Host", async () => {
    const before = await liveSnapshot();
    const root = await mkdtemp(join(tmpdir(), "grokbox-reviewed-live-shaped-"));
    const destDir = join(root, "profiles");
    const hostBundle = join(root, "live-shaped-host.cjs");
    await writeFile(hostBundle, LIVE_SHAPED_HOST);

    const written = await writeReviewedProfileFromCopy({
      destDir,
      hostBundle,
      profileId: "reviewed-copy",
    });

    expect(written.profile.slices).toEqual(LIVE_SLICE_PATCHES);
    const applied = applyPatchProfile(LIVE_SHAPED_HOST, written.profile);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.source).toContain("agentId: host.getConversationId()");
      expect(applied.source).toContain("invocationId: inferenceRequestId");
      expect(applied.source).toContain("originalSession: session");
    }
    expect(await readFile(hostBundle, "utf8")).toBe(LIVE_SHAPED_HOST);
    const after = await liveSnapshot();
    expect(after).toEqual(before);
  });

  test("does not require the official live Host path as the only fixture", () => {
    expect(existsSync(join(import.meta.dir, "live-shaped-host.ts"))).toBe(true);
    // Explicit hostBundle is part of the API; live path is optional input, not hardcoded in call sites under test.
    const src = readFileSync(new URL("../src/h3-live.ts", import.meta.url), "utf8");
    expect(src).toContain("hostBundle: string");
    expect(src).toMatch(/await copyFile\(hostBundle, copyPath\)/);
    expect(src).not.toMatch(/await copyFile\(LIVE_HOST_BUNDLE, copyPath\)/);
  });
});
