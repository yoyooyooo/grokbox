import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, profileFromSource } from "../src/internal/host/profile.ts";
import { bindHostProfileTitle } from "../src/internal/host/title-marker.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOWING = "coding | owner=box,m=old";

function modelsRoot(body: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "gbox-title-"));
  writeFileSync(join(root, "models.json"), `${JSON.stringify(body)}\n`);
  return root;
}

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
    expect(hook({ profile: { title: "coding" }, localHarness: "box", agentId: AGENT })).toBeUndefined();
    expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: AGENT })).toBeUndefined();
    expect(hook({ profile: { title: "coding | owner=box,m=g46" }, localHarness: "temporal" })).toEqual({
      title: "coding | owner=temporal",
    });
    expect(hook({ profile: { title: "coding | owner=box" }, localHarness: "box" })).toBeUndefined();
  });

  test("missing models file or unresolved assignment keeps showing m=", () => {
    const missing = bindHostProfileTitle({ durableRoot: "/tmp/grokbox-missing-runtime" });
    expect(missing({ profile: { title: SHOWING }, localHarness: "box", agentId: AGENT })).toBeUndefined();

    const root = modelsRoot({
      version: 1,
      models: {},
      assignments: { main: null, agents: { [AGENT]: "openai-responses/grok-4.6" } },
    });
    try {
      const hook = bindHostProfileTitle({ durableRoot: root });
      expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: AGENT })).toBeUndefined();
      expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: AGENT.toUpperCase() })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-uuid agentId keeps showing m=", () => {
    const root = modelsRoot({
      version: 1,
      models: {},
      assignments: { main: null, agents: { [AGENT]: "openai-responses/grok-4.6" } },
    });
    try {
      const hook = bindHostProfileTitle({ durableRoot: root });
      expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: "3081925" })).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no assignment clears showing m=", () => {
    const root = modelsRoot({
      version: 1,
      models: {},
      assignments: { main: null, agents: { [AGENT]: "openai-responses/grok-4.6" } },
    });
    try {
      const hook = bindHostProfileTitle({ durableRoot: root });
      expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: OTHER })).toEqual({
        title: "coding | owner=box",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolved token refreshes showing m=", () => {
    const root = modelsRoot({
      version: 1,
      models: {
        "openai-responses/grok-4.6": {
          provider: "openai-responses",
          model: "grok-4.6",
          endpoint: "https://example.invalid/v1",
          apiKeyRef: "env:GROKBOX_KEY",
          alias: "g46",
        },
      },
      assignments: { main: null, agents: { [AGENT]: "openai-responses/grok-4.6" } },
    });
    try {
      const hook = bindHostProfileTitle({ durableRoot: root });
      expect(hook({ profile: { title: SHOWING }, localHarness: "box", agentId: AGENT })).toEqual({
        title: "coding | owner=box,m=g46",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
