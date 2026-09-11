import { describe, expect, test } from "bun:test";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { applyPatchProfile, extractContractSlices, profileFromSource, sliceHashes, type PatchProfile, type SlicePatch } from "../src/internal/host/profile.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { observeKnifePoints, firstHitIndex } from "../src/internal/ops/host-seam/knife-points.ts";
import { observeLegacyWindows } from "../src/internal/ops/host-seam/legacy-windows.ts";
import { SYNTHETIC_HOST, SYNTHETIC_SLICES } from "./synthetic-host.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const BACKGROUND_HOST = `"use strict";
function backgroundShell(host) {
  return { agentId: host.getConversationId() };
}
function otherHandler(host) {
  return { agentId: host.getConversationId() };
}
const decoy = {
  createSession(onRequestId, sessionOptions) {
    return null;
    },
    recordPostTurnLabeling(args) {
      return args;
    },
};
const api = {
  createSession(onRequestId, sessionOptions) {
    const inferenceOptions = { sessionOptions, onRequestId };
      return createCursorInferencePromptSession(inferenceOptions);
    },
    recordPostTurnLabeling(args) {
      return args;
    },
};
function runTurn(host) {
  const inferenceRequestId = "inv-bg";
  const emitRequestId = () => inferenceRequestId;
  const mainSessionOptions = {
          modelId: host.subagentModelId,
  };
  return (async () => host.inference.createSession(emitRequestId, mainSessionOptions))();
}
`;

const TWO_LIVE = LIVE_SLICE_PATCHES.filter((slice) => slice.id === "create-session" || slice.id === "agent-id");

function recipeProfile(source: string, slices: readonly SlicePatch[]): PatchProfile {
  return {
    profileId: "hso-0",
    sourceSha256: sha256Text(source),
    transformedSourceSha256: "0".repeat(64),
    slices: [...slices],
  };
}

describe("HSO-0 knife-point observation", () => {
  test("background getter and labeling duplicates stay loud on both rows; no first hit", () => {
    const source = BACKGROUND_HOST;
    expect(source.split("agentId: host.getConversationId()").length).toBeGreaterThan(2);
    expect(source.split("recordPostTurnLabeling").length).toBeGreaterThan(2);
    const extracted = extractContractSlices(source);
    const firstAgent = firstHitIndex(source, "agentId: host.getConversationId()");
    expect(firstAgent).toBeGreaterThanOrEqual(0);
    expect(extracted["agent-id"]?.startsWith("agentId: host.getConversationId()")).toBe(true);

    const profile = recipeProfile(source, TWO_LIVE);
    const obs = observeKnifePoints(source, profile);
    expect(obs.traceMismatch).toBe(false);
    expect(obs.rows).toHaveLength(2);
    const create = obs.rows[0];
    const agent = obs.rows[1];
    expect(create.sliceId).toBe("create-session");
    expect(agent.sliceId).toBe("agent-id");
    expect(create.endCount).toBeGreaterThan(1);
    expect(create.code).toBe("anchor-duplicate");
    expect(create.semanticLabelState).toBe("ambiguous");
    expect(create.locationRange).toBeNull();
    expect(agent.startCount).toBe(1);
    expect(agent.code).toBe("ok");
    expect(applyPatchProfile(source, profile)).toMatchObject({ ok: false, code: "anchor-duplicate", sliceId: "create-session" });

    const legacy = observeLegacyWindows(source);
    const legacyAgent = legacy.find((row) => row.name === "contract:agent-id");
    expect(legacyAgent?.hitCount).toBeGreaterThan(1);
    expect(legacyAgent?.patchImpact).toBe("unknown");
    expect(legacy.every((row) => row.patchImpact === "unknown")).toBe(true);
    expect(legacy.every((row) => row.selectorVersion === "hso-0.legacy-window.v1")).toBe(true);
  });

  test("missing and multi-match appear on both slice rows", () => {
    const missing = SYNTHETIC_HOST.replace("function createSession(sessionOptions) {", "function other() {");
    const profile = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);
    const missingProfile: PatchProfile = { ...profile, sourceSha256: sha256Text(missing) };
    const obs = observeKnifePoints(missing, missingProfile);
    expect(obs.rows).toHaveLength(2);
    expect(obs.rows[0]?.code).toBe("anchor-missing");
    expect(obs.rows[0]?.semanticLabelState).toBe("missing");
    expect(obs.rows[0]?.startCount).toBe(0);
    expect(obs.rows[1]?.sliceId).toBe("agent-id");
    expect(obs.traceMismatch).toBe(false);
    const missingApply = applyPatchProfile(missing, missingProfile);
    expect(missingApply.ok).toBe(false);
    if (!missingApply.ok) expect(missingApply.code).toBe("anchor-missing");
  });

  test("trace matches applyPatchProfile for sha drift, reversed anchors, duplicates, cross-slice, and transformed mismatch", () => {
    const base = profileFromSource(SYNTHETIC_HOST, SYNTHETIC_SLICES);

    const drift = observeKnifePoints(`${SYNTHETIC_HOST}\n// drift\n`, base);
    expect(drift.applyCode).toBe("unknown-sha");
    expect(drift.rows.every((row) => row.code === "unknown-sha" && row.sourceIntegrity === "unknown-sha")).toBe(true);
    expect(drift.traceMismatch).toBe(false);
    expect(applyPatchProfile(`${SYNTHETIC_HOST}\n// drift\n`, base)).toMatchObject({ code: "unknown-sha" });

    const reversedSlices: SlicePatch[] = [
      { ...SYNTHETIC_SLICES[0]!, startAnchor: SYNTHETIC_SLICES[0]!.endAnchor, endAnchor: SYNTHETIC_SLICES[0]!.startAnchor },
      SYNTHETIC_SLICES[1]!,
    ];
    const reversed: PatchProfile = { ...base, slices: reversedSlices };
    const reversedObs = observeKnifePoints(SYNTHETIC_HOST, reversed);
    expect(reversedObs.rows[0]?.endAfterStart).toBe(false);
    expect(reversedObs.rows[0]?.code).toBe("anchor-missing");
    expect(reversedObs.traceMismatch).toBe(false);
    expect(applyPatchProfile(SYNTHETIC_HOST, reversed)).toMatchObject({ ok: false, code: "anchor-missing" });

    const dupSource = SYNTHETIC_HOST.replace(
      "function createSession(sessionOptions) {",
      "function createSession(sessionOptions) {\nfunction createSession(sessionOptions) {",
    );
    const dupProfile = { ...base, sourceSha256: sha256Text(dupSource) };
    const dupObs = observeKnifePoints(dupSource, dupProfile);
    expect(dupObs.rows[0]?.startCount).toBeGreaterThan(1);
    expect(dupObs.rows[0]?.code).toBe("anchor-duplicate");
    expect(dupObs.rows[1]?.sliceId).toBe("agent-id");
    expect(dupObs.traceMismatch).toBe(false);
    expect(applyPatchProfile(dupSource, dupProfile).ok).toBe(false);

    const crossProfile = recipeProfile(SYNTHETIC_HOST, [
      {
        ...SYNTHETIC_SLICES[0]!,
        replacement: `${SYNTHETIC_SLICES[0]!.replacement}const mainSessionOptions = {\n`,
      },
      SYNTHETIC_SLICES[1]!,
    ]);
    const crossObs = observeKnifePoints(SYNTHETIC_HOST, crossProfile);
    expect(crossObs.rows[0]?.code).toBe("ok");
    expect(crossObs.rows[1]?.startCount).toBeGreaterThan(1);
    expect(crossObs.rows[1]?.code).toBe("anchor-duplicate");
    expect(crossObs.traceMismatch).toBe(false);
    expect(applyPatchProfile(SYNTHETIC_HOST, crossProfile)).toMatchObject({ ok: false, code: "anchor-duplicate", sliceId: "agent-id" });

    const badHash = { ...base, transformedSourceSha256: "0".repeat(64) };
    const mismatch = observeKnifePoints(SYNTHETIC_HOST, badHash);
    expect(mismatch.rows.every((row) => row.code === "ok")).toBe(true);
    expect(mismatch.applyCode).toBe("transformed-mismatch");
    expect(mismatch.traceMismatch).toBe(false);
    expect(applyPatchProfile(SYNTHETIC_HOST, badHash)).toMatchObject({ code: "transformed-mismatch" });
  });

  test("first-hit indexOf / old window hash cannot report unchanged or empty drift success", () => {
    const source = BACKGROUND_HOST;
    const firstHitMutant = {
      patchImpact: "unchanged" as const,
      driftedSlices: [] as string[],
      windowHash: sliceHashes(extractContractSlices(source))["agent-id"],
    };
    expect(firstHitMutant.patchImpact).toBe("unchanged");
    expect(firstHitMutant.driftedSlices).toEqual([]);

    const legacy = observeLegacyWindows(source);
    expect(legacy.map((row) => row.patchImpact as string)).not.toContain("unchanged");
    expect(legacy.find((row) => row.name === "contract:agent-id")?.hitCount).toBeGreaterThan(1);
    const live = profileFromSource(LIVE_SHAPED_HOST, TWO_LIVE, "hso-0-live");
    const ok = observeKnifePoints(LIVE_SHAPED_HOST, live);
    expect(ok.traceMismatch).toBe(false);
    expect(ok.apply.ok).toBe(true);
    expect(ok.rows.every((row) => row.code === "ok" && row.semanticLabelState === "unique")).toBe(true);
    expect(ok.rows[0]?.locationRange).not.toBeNull();
    const firstLabel = firstHitIndex(BACKGROUND_HOST, "recordPostTurnLabeling");
    const bg = observeKnifePoints(BACKGROUND_HOST, recipeProfile(BACKGROUND_HOST, TWO_LIVE));
    expect(bg.rows[0]?.locationRange).toBeNull();
    expect(firstLabel).toBeGreaterThanOrEqual(0);
  });
});
