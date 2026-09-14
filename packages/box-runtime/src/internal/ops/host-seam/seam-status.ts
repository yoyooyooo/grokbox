import { observeHostBundles } from "../../io/provenance.node.ts";
import { classifyUpgradeSense, type UpgradeSenseInput, type UpgradeSenseVerdict } from "./upgrade-sense.ts";
import { REPLAY_TOOL_REVISION, readLastReplayReport, recipeRevisionOf, liveKnifeRecipe, type ReplayReport } from "./replay.ts";
import {
  observeRetainedEnvelopeDrift,
  type EnvelopeDriftObservation,
  type EnvelopeWindows,
} from "./envelope-windows.ts";

export type HostSeamStatusFacets = {
  upstreamUpgrade: {
    pending: boolean;
    staged: boolean;
    sourceKind: UpgradeSenseVerdict["sourceKind"];
    pointerFreshness: "unknown";
    observedAt: string | null;
  };
  installation: {
    consistency: UpgradeSenseVerdict["installationConsistency"];
    mixed: boolean;
    rollbackRisk: "unknown";
  };
  loadedHost: {
    pidOnly: boolean;
    helperOnly: boolean;
    compileReceipt: string | "unknown" | null;
  };
  provenance: {
    head: string | null;
    generations: number;
    protectedShas: string[];
    truncated: boolean;
  };
  replay: {
    lastKey: string | null;
    staleGreen: boolean;
    supportGatePassed: boolean | null;
    truncated: boolean;
    toolRevision: string;
  };
  review: { lastReviewedMatch: string | null };
  /** 19-slice window golden vs prior retained golden. Not driftedSlices / patchImpact. */
  envelopeDrift: EnvelopeDriftObservation;
  adoptEligibility: false;
  gaps: string[];
};

export async function projectHostSeamStatus(input: {
  root: string;
  sha?: string;
  sense?: UpgradeSenseInput;
  previousSense?: UpgradeSenseInput;
  currentRecipeRevision?: string;
  envelopeWindows?: { previous: EnvelopeWindows; current: EnvelopeWindows };
}): Promise<HostSeamStatusFacets> {
  const bundles = await observeHostBundles(input.root);
  const sense = classifyUpgradeSense(input.sense ?? { schemaVersion: 1 }, input.previousSense);
  const last = await readLastReplayReport(input.root);
  const recipeRevision = input.currentRecipeRevision ?? recipeRevisionOf(liveKnifeRecipe());
  const staleGreen = Boolean(
    last
    && last.supportGatePassed
    && (last.toolRevision !== REPLAY_TOOL_REVISION || last.recipeRevision !== recipeRevision),
  );
  const pidOnly = Boolean(
    input.previousSense?.installed?.entrySha
    && input.sense?.installed?.entrySha
    && input.previousSense.installed.entrySha === input.sense.installed.entrySha
    && input.previousSense.loaded?.hostPid !== undefined
    && input.sense.loaded?.hostPid !== undefined
    && input.previousSense.loaded.hostPid !== input.sense.loaded.hostPid,
  );
  const helperOnly = Boolean(
    input.previousSense?.installed?.entrySha
    && input.sense?.installed?.entrySha
    && input.previousSense.installed.entrySha === input.sense.installed.entrySha
    && input.previousSense.installed.companionDigest
    && input.sense.installed.companionDigest
    && input.previousSense.installed.companionDigest !== input.sense.installed.companionDigest,
  );
  const envelopeDrift = await observeRetainedEnvelopeDrift({
    root: input.root,
    bundles,
    ...(input.sha ? { sha: input.sha } : {}),
    ...(input.envelopeWindows ? { envelopeWindows: input.envelopeWindows } : {}),
  });
  const gaps = [...sense.gaps];
  if (staleGreen) gaps.push("stale_replay_cache");
  if (bundles.state === "missing") gaps.push("corpus_missing");
  if (last?.truncated) gaps.push("replay_truncated");
  // Observation-only. envelope_windows_* gaps are not a doctor/heal Host-seam surface.
  if (envelopeDrift.state === "missing") gaps.push("envelope_windows_missing");
  if (envelopeDrift.state === "partial") gaps.push("envelope_windows_incomplete");
  if (envelopeDrift.state === "invalid" || envelopeDrift.state === "unavailable") gaps.push("envelope_windows_invalid");

  return {
    upstreamUpgrade: {
      pending: Boolean(input.sense?.staged?.pending || input.sense?.rpc?.accepted),
      staged: Boolean(input.sense?.staged?.pending || input.sense?.staged?.archiveDigest),
      sourceKind: sense.sourceKind,
      pointerFreshness: "unknown",
      observedAt: sense.freshness.observedAt,
    },
    installation: {
      consistency: sense.installationConsistency,
      mixed: sense.installationConsistency === "mixed",
      rollbackRisk: "unknown",
    },
    loadedHost: {
      pidOnly,
      helperOnly,
      compileReceipt: input.sense?.loaded?.compileReceiptSha ?? null,
    },
    provenance: {
      head: bundles.head,
      generations: bundles.generations.length,
      protectedShas: input.sha ? [input.sha] : bundles.head ? [bundles.head] : [],
      truncated: bundles.truncated,
    },
    replay: {
      lastKey: last?.replayKey ?? null,
      staleGreen,
      supportGatePassed: staleGreen ? null : last?.supportGatePassed ?? null,
      truncated: last?.truncated ?? false,
      toolRevision: REPLAY_TOOL_REVISION,
    },
    review: {
      lastReviewedMatch: bundles.generations.find((row) => row.metadata?.matchedProfileId)?.sourceSha ?? null,
    },
    envelopeDrift,
    adoptEligibility: false,
    gaps,
  };
}
