import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { LIVE_SLICE_PATCHES } from "./live-slices.ts";
import { applyPatchProfile, type PatchProfile, type SliceId, type SlicePatch } from "./profile.ts";

export const PROFILE_CAPABILITIES = ["ownership-local"] as const;
export type ProfileCapability = typeof PROFILE_CAPABILITIES[number];
const OWNERSHIP_DEPENDENCIES: readonly SliceId[] = ["ownership-read-schema", "ownership-read-api", "ownership-resume-gate"];
export type CapabilityUpgradeReceipt = {
  capability: ProfileCapability;
  baselineProfileSha256: string;
  updatedIds: SliceId[];
  addedIds: SliceId[];
};

export function parseProfileCapability(value: string): ProfileCapability {
  if (value !== "ownership-local") throw new BoxRuntimeError("invalid_usage", "Unknown profile capability; supported: ownership-local.");
  return value;
}

/** Finite maintained recipe upgrade, never a user-supplied skip list. The caller
 * supplies a structurally validated baseline, bound to the exact source bytes.
 */
export function upgradeProfileCapability(source: string, baseline: PatchProfile, capability: ProfileCapability): {
  slices: SlicePatch[]; updatedIds: SliceId[]; addedIds: SliceId[];
} {
  parseProfileCapability(capability);
  if (!applyPatchProfile(source, baseline).ok) throw new BoxRuntimeError("invalid_usage", "Capability upgrade requires an applicable same-source reviewed baseline.");
  const target = new Set<SliceId>(OWNERSHIP_DEPENDENCIES);
  const replacements = new Map(LIVE_SLICE_PATCHES.filter(slice => target.has(slice.id)).map(slice => [slice.id, slice]));
  if (replacements.size !== target.size) throw new BoxRuntimeError("invalid_usage", "Capability dependency recipe is incomplete.");
  const updatedIds: SliceId[] = [], addedIds: SliceId[] = [];
  const slices = baseline.slices.map(slice => {
    const next = replacements.get(slice.id);
    if (!next) return { ...slice };
    updatedIds.push(slice.id);
    return { ...next };
  });
  for (const id of OWNERSHIP_DEPENDENCIES) if (!slices.some(slice => slice.id === id)) {
    slices.push({ ...replacements.get(id)! }); addedIds.push(id);
  }
  return { slices, updatedIds, addedIds };
}
