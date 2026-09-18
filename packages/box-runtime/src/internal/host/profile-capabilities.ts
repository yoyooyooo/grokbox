import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { LIVE_SLICE_PATCHES } from "./live-slices.ts";
import { applyPatchProfile, CONTEXT_SLICE_IDS, type PatchProfile, type SliceId, type SlicePatch } from "./profile.ts";
import { NATIVE_CHECKPOINT_HOST_SLICES } from "./native-checkpoint-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "./native-current-state-slices.ts";
import { NATIVE_CHECKPOINT_PAIR } from "./native-checkpoint-worker-hook.ts";

export const PROFILE_CAPABILITIES = ["ownership-local", "current-state"] as const;
export type ProfileCapability = typeof PROFILE_CAPABILITIES[number];
const OWNERSHIP_DEPENDENCIES: readonly SliceId[] = ["ownership-read-schema", "ownership-read-api", "ownership-resume-gate"];
export type CapabilityUpgradeReceipt = {
  capability: ProfileCapability;
  baselineProfileSha256: string;
  updatedIds: SliceId[];
  addedIds: SliceId[];
};

export function parseProfileCapability(value: string): ProfileCapability {
  if (value !== "ownership-local" && value !== "current-state") throw new BoxRuntimeError("invalid_usage", "Unknown profile capability; supported: ownership-local, current-state.");
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
  if (capability === "current-state" && baseline.sourceSha256 !== NATIVE_CHECKPOINT_PAIR.host) {
    throw new BoxRuntimeError("invalid_usage", "Current-state capability requires the independently qualified Host/worker pair.");
  }
  const extras = capability === "current-state" ? [...NATIVE_CHECKPOINT_HOST_SLICES, ...NATIVE_CURRENT_STATE_SLICES] : [];
  const dependencies: readonly SliceId[] = capability === "current-state"
    ? [...OWNERSHIP_DEPENDENCIES, ...CONTEXT_SLICE_IDS, ...extras.map(slice => slice.id)] : OWNERSHIP_DEPENDENCIES;
  const target = new Set<SliceId>(dependencies);
  const replacements = new Map([...LIVE_SLICE_PATCHES, ...extras].filter(slice => target.has(slice.id)).map(slice => [slice.id, slice]));
  if (replacements.size !== target.size) throw new BoxRuntimeError("invalid_usage", "Capability dependency recipe is incomplete.");
  const updatedIds: SliceId[] = [], addedIds: SliceId[] = [];
  const slices = baseline.slices.map(slice => {
    const next = replacements.get(slice.id);
    if (!next) return { ...slice };
    updatedIds.push(slice.id);
    return { ...next };
  });
  for (const id of dependencies) if (!slices.some(slice => slice.id === id)) {
    slices.push({ ...replacements.get(id)! }); addedIds.push(id);
  }
  return { slices, updatedIds, addedIds };
}
