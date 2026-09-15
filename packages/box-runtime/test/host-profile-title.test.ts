import { describe, expect, test } from "bun:test";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, profileFromSource } from "../src/internal/host/profile.ts";
import { bindHostProfileTitle } from "../src/internal/host/title-marker.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

describe("host profile title marker", () => {
  test("live-shaped Host accepts the profile-title-marker slice", () => {
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "title-shaped");
    const applied = applyPatchProfile(LIVE_SHAPED_HOST, profile);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain("grokbox.box-runtime.profile-title.v1");
  });

  test("write hook refreshes showing trailers and leaves hidden titles", () => {
    const hook = bindHostProfileTitle({ durableRoot: "/tmp/grokbox-missing-runtime" });
    expect(hook({ profile: { title: "coding" }, localHarness: "box", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).toBeUndefined();
    expect(hook({ profile: { title: "coding | owner=box,m=old" }, localHarness: "box" })).toEqual({
      title: "coding | owner=box",
    });
    expect(hook({ profile: { title: "coding | owner=box,m=g46" }, localHarness: "temporal" })).toEqual({
      title: "coding | owner=temporal",
    });
    expect(hook({ profile: { title: "coding | owner=box" }, localHarness: "box" })).toBeUndefined();
  });
});
