import { LIVE_SLICE_PATCHES } from "./live-slices.ts";
import { NATIVE_CHECKPOINT_HOST_SLICES } from "./native-checkpoint-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES } from "./native-current-state-slices.ts";
import type { SlicePatch } from "./profile.ts";

const immutable = (slices: readonly SlicePatch[]): readonly SlicePatch[] => Object.freeze(slices.map(slice => Object.freeze({ ...slice })));
/** One maintained authoring recipe, consumed by default authoring, capability
 * upgrades and analysis. No historical recipe selector or per-SHA name rewrite.
 * A new source must pass exact ordered application and explicit profile review;
 * unchanged layout alone never extends the independent native ABI qualification. */
export const HOST_RECIPE = Object.freeze({
  id: "host-managed-current",
  core: immutable(LIVE_SLICE_PATCHES),
  checkpoint: immutable(NATIVE_CHECKPOINT_HOST_SLICES),
  currentState: immutable(NATIVE_CURRENT_STATE_SLICES),
});
