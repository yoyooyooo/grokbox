import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Script } from "node:vm";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const HARNESS_SLICES = LIVE_SLICE_PATCHES.filter((slice) => slice.id.startsWith("harness-"));
const ALWAYS_EMIT = 'harness: readSandProfileHarness(profilePath) ?? undefined';
const OMIT_BOX = '? { harness: "temporal" } : {}';

describe("L2 Host harness always-emit", () => {
  test("harness-blank and harness-summary slices emit box|temporal", () => {
    const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(ALWAYS_EMIT);
    expect(applied.source).not.toContain(OMIT_BOX);
    expect(LIVE_SLICE_PATCHES.map((slice) => slice.id)).toEqual([
      "create-session",
      "agent-id",
      "compact-register",
      "compact-background-start",
      "compact-background-response",
      "managed-retry-gate",
      "managed-turn-retry-gate",
      "managed-step-error-scope",
      "managed-output-retry-gate",
      "managed-summary-retry-gate",
      "activity-bridge",
      "memory-purpose",
      "episode-purpose",
      "harness-blank",
      "profile-title-marker",
      "harness-summary",
      "ownership-read-schema",
      "ownership-read-api",
      "ownership-resume-gate",
    ]);
  });

  test.each(HARNESS_SLICES)("$id preserves unknown instead of fabricating box", (slice) => {
    for (const harness of ["box", "temporal", null, undefined]) {
      const projected = new Script(`({${slice.replacement}})`).runInNewContext({ profilePath: "/owned/profile", readSandProfileHarness: () => harness });
      const wire = JSON.parse(JSON.stringify(projected));
      if (harness == null) expect(wire).not.toHaveProperty("harness");
      else expect(wire.harness).toBe(harness);
    }
  });

  test.each(HARNESS_SLICES)("$id startAnchor is before find and fail-closed on missing/duplicate", (slice) => {
    expect(slice.startAnchor.includes(slice.find) || LIVE_SHAPED_HOST.indexOf(slice.startAnchor) < LIVE_SHAPED_HOST.indexOf(slice.find)).toBe(true);
    expect(transformUnchecked(LIVE_SHAPED_HOST.replace(slice.startAnchor, ""), [slice])).toMatchObject({
      ok: false,
      code: "anchor-missing",
    });
    expect(transformUnchecked(LIVE_SHAPED_HOST + slice.startAnchor, [slice])).toMatchObject({
      ok: false,
      code: "anchor-duplicate",
    });
  });

  const describeLive = existsSync(LIVE_HOST_BUNDLE) ? describe : describe.skip;
  describeLive("local-real Host bundle copy", () => {
    test("approved slices replace omit-box on a read-only live copy", () => {
      const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
      const applied = transformUnchecked(source, LIVE_SLICE_PATCHES);
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.source).toContain(ALWAYS_EMIT);
      expect(applied.source).not.toContain(OMIT_BOX);
      expect(readFileSync(LIVE_HOST_BUNDLE, "utf8")).toBe(source);
    });
  });
});
