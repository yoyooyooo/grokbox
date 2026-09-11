import { describe, expect, test } from "bun:test";
import { attachHostAuxStreamContext, grokboxAuxFrom } from "../src/internal/host/aux-request.ts";
import { hostAuxIntentFrom, wrapHostAuxExecutor } from "../src/internal/host/aux-purpose.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, approvedSliceSet, profileFromSource, transformUnchecked } from "../src/internal/host/profile.ts";
import { parseReviewedProfile, validateReviewedProfile } from "../src/internal/process/profile.node.ts";
import { asHostPromptSession, createStreamingPromptSession } from "../src/internal/host/session.ts";
import { projectHostSeamStage } from "../src/internal/host/terminal-journal.node.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import { loadE07Host } from "./e07-host-fixture.ts";

const PARENT = {
  agentId: "agent-tom", turnId: "turn-1", stepId: "step-main",
  modelId: "openai/gpt-4o-mini", selectionRevision: "rev-1",
};
const PURPOSE_SLICES = LIVE_SLICE_PATCHES.filter((slice) => slice.id.endsWith("-purpose"));
const OLD_SLICES = LIVE_SLICE_PATCHES.filter((slice) => !slice.id.endsWith("-purpose"));

describe("E07 Host admission D2", () => {
  test("optional purpose slices replay with all strict profile gates; older profiles remain valid", () => {
    expect(LIVE_SLICE_PATCHES.map((slice) => slice.id)).toEqual([
      "create-session", "agent-id", "compact-register", "activity-bridge", "memory-purpose", "episode-purpose", "harness-blank", "harness-summary",
    ]);
    for (const slices of [OLD_SLICES.slice(0, 2), OLD_SLICES, [...OLD_SLICES, PURPOSE_SLICES[0]!], LIVE_SLICE_PATCHES]) {
      const profile = profileFromSource(LIVE_SHAPED_HOST, slices, "e07-admission");
      expect(approvedSliceSet(slices)).toBe(true);
      expect(parseReviewedProfile(profile)).toEqual(profile);
      expect(validateReviewedProfile(profile, LIVE_SHAPED_HOST).ok).toBe(true);
      expect(applyPatchProfile(LIVE_SHAPED_HOST, profile).ok).toBe(true);
    }
    for (const slices of [PURPOSE_SLICES, [...LIVE_SLICE_PATCHES, LIVE_SLICE_PATCHES[0]!], [...OLD_SLICES, { id: "guessed-purpose" }]]) {
      expect(approvedSliceSet(slices)).toBe(false);
    }
  });

  test.each(PURPOSE_SLICES)("E07 $id missing/duplicate anchors/find and wrong SHA fail closed", (slice) => {
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "e07-exact");
    expect(applyPatchProfile(LIVE_SHAPED_HOST + "\n// drift", profile)).toMatchObject({ ok: false, code: "unknown-sha" });
    expect(applyPatchProfile(LIVE_SHAPED_HOST, { ...profile, transformedSourceSha256: "0".repeat(64) })).toMatchObject({ ok: false, code: "transformed-mismatch" });
    expect(transformUnchecked(LIVE_SHAPED_HOST.replace(slice.startAnchor, ""), [slice])).toMatchObject({ ok: false, code: "anchor-missing" });
    expect(transformUnchecked(LIVE_SHAPED_HOST + slice.startAnchor, [slice])).toMatchObject({ ok: false, code: "anchor-duplicate" });
    const start = LIVE_SHAPED_HOST.indexOf(slice.startAnchor);
    const at = LIVE_SHAPED_HOST.indexOf(slice.find, start);
    const duplicated = LIVE_SHAPED_HOST.slice(0, at) + slice.find + LIVE_SHAPED_HOST.slice(at);
    expect(transformUnchecked(duplicated, [slice])).toMatchObject({ ok: false, code: "find-duplicate" });
    expect(transformUnchecked(LIVE_SHAPED_HOST.slice(0, at) + LIVE_SHAPED_HOST.slice(at + slice.find.length), [slice])).toMatchObject({ ok: false, code: "find-missing" });
  });

  test("E07 unpatched sites and absent hook remain official, never infer purpose from text", async () => {
    for (const config of [{ slices: OLD_SLICES }, { auxHook: null }]) {
      const host = loadE07Host({ hook: (args) => args.originalSession, ...config });
      const ctx = host.fixtureContext();
      await host.runTurnMemory({ addMemory() {} }, ["one", "two"], await host.fixtureSession(), ctx, 1, { user: "purpose: memory-extraction", agent: "purpose: episode" });
      expect(host.fixtureOfficial).toHaveLength(2);
      for (const call of host.fixtureOfficial) {
        expect(call.ctx).toBe(ctx);
        expect(grokboxAuxFrom(call.ctx)).toBeUndefined();
        expect(hostAuxIntentFrom(call.options)).toBeUndefined();
      }
    }
  });

  test.each([
    { purpose: "purpose: episode", parent: PARENT, auxRequestId: "aux-fake" },
    { purpose: "memory-extraction", parent: undefined, auxRequestId: "aux-missing" },
    { purpose: "episode", parent: { ...PARENT, stepId: "" }, auxRequestId: "aux-missing-step" },
    { purpose: "episode", parent: { ...PARENT, selectionRevision: "" }, auxRequestId: "aux-missing-selection" },
    { purpose: "memory-extraction", parent: PARENT, auxRequestId: PARENT.stepId },
  ])("E07 invalid attach leaves ctx unchanged ($auxRequestId)", (input) => {
    const ctx = Object.freeze({ signal: new AbortController().signal, text: "purpose: episode" });
    const before = Object.getOwnPropertyDescriptors(ctx);
    expect(attachHostAuxStreamContext({ ...input, ctx })).toBeUndefined();
    expect(Object.getOwnPropertyDescriptors(ctx)).toEqual(before);
    expect(grokboxAuxFrom(ctx)).toBeUndefined();
  });

  test("E07 valid attach is detached and preserves cancellation", () => {
    const ctx = Object.freeze({ signal: new AbortController().signal });
    for (const purpose of ["memory-extraction", "episode"] as const) {
      const attached = attachHostAuxStreamContext({ purpose, auxRequestId: `aux-${purpose}`, parent: PARENT, ctx });
      expect(attached?.aux).toEqual({ purpose, auxRequestId: `aux-${purpose}`, parent: PARENT });
      expect(attached?.ctx).not.toBe(ctx);
      expect(attached?.ctx.signal).toBe(ctx.signal);
      expect(grokboxAuxFrom(ctx)).toBeUndefined();
    }
  });

  test("E07 purpose hook is explicit and options/body cannot mint its capability", () => {
    const executor = asHostPromptSession(createStreamingPromptSession({ modelId: "stub/echo", vision: false, parallel: "fail-closed", produce: async function* () {} }), "stub/echo").getExecutor();
    const ctx = {};
    expect(wrapHostAuxExecutor({ executor, purpose: "text: memory-extraction", turnId: "turn", ctx })).toBeUndefined();
    expect(wrapHostAuxExecutor({ executor, purpose: "episode", turnId: "", ctx })).toBeUndefined();
    expect(hostAuxIntentFrom({ purpose: "episode", auxRequestId: "fake", parent: PARENT })).toBeUndefined();
  });

  test("E07 Host journal admits only bounded correlated auxiliary facts", () => {
    const row = { name: "host_seam_stage", schemaVersion: 1, at: "2026-09-11T00:00:00.000Z", stage: "stream_enter", result: "entered", agentId: PARENT.agentId, turnId: PARENT.turnId, stepId: "aux-id", auxPurpose: "episode", parentStepId: PARENT.stepId };
    expect(projectHostSeamStage({ ...row, body: "not a purpose", apiKey: "never-copy" })).toEqual(row);
    for (const patch of [{ auxPurpose: "anything" }, { parentStepId: "" }, { stepId: PARENT.stepId }, { stage: "hook_enter" }]) {
      expect(projectHostSeamStage({ ...row, ...patch })).toBeNull();
    }
  });
});
