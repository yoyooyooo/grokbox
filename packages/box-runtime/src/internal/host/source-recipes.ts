import { LIVE_SLICE_PATCHES } from "./live-slices.ts";
import { NATIVE_CHECKPOINT_HOST_SLICES } from "./native-checkpoint-slices.ts";
import { NATIVE_CURRENT_STATE_SLICES, nativeCurrentStateSlices } from "./native-current-state-slices.ts";
import { IDLE_CHECKPOINT_PAIR } from "./native-checkpoint-pair.ts";
import { type SlicePatch, type SliceId } from "./profile.ts";

/** A maintained authoring layout for these exact inspected bytes. This is NOT
 * a reviewed profile, a new SHA admission rule, or Host/worker qualification.
 * Existing persisted profiles keep their own exact source/candidate hashes.
 * Unknown sources retain the original recipe and ordinary explicit review. */
export const IDLE_COMPACTION_HOST_SHA = IDLE_CHECKPOINT_PAIR.host;
const fields = ["startAnchor", "endAnchor", "find", "replacement"] as const;
function names(slice: SlicePatch, bindings: ReadonlyArray<readonly [string, string]>): SlicePatch {
  const result = { ...slice };
  // This finite, source-pinned layout map changes only the named slice's local
  // bindings. It is never applied to the Host text or an arbitrary new bundle.
  for (const key of fields) for (const [from, to] of bindings) result[key] = result[key].replaceAll(from, to);
  return result;
}
const changed = new Set<SliceId>(["managed-retry-gate", "managed-output-retry-gate", "managed-summary-retry-gate", "tool-execution-failure-observation"]);
const core = LIVE_SLICE_PATCHES.map(slice => {
  if (changed.has(slice.id)) return names(slice, [["error41", "error42"]]);
  if (slice.id === "alert-main-decision") return names(slice, [["error41", "error42"], ["description10", "description9"]]);
  if (slice.id === "alert-automation-decision" || slice.id === "alert-automation-throttle") return names(slice, [["description10", "description9"]]);
  if (slice.id === "context-manual-native-action") return {
    ...slice,
    find: "          action: promptlessAction,\n          automationStatusReminder: null,\n",
    // Preserve native idle-summary and resume choices unless the original
    // WeakMap owner supplied this explicitly admitted manual operation.
    replacement: slice.replacement.replace("? RESUME_TURN_ACTION :", "? promptlessAction :"),
  };
  if (slice.id === "context-manual-summary-owner") return names(slice, [["_mcpTools", "mcpTools"]]);
  return { ...slice };
});
const currentState = nativeCurrentStateSlices(IDLE_CHECKPOINT_PAIR).map(slice => {
  if (slice.id === "continuity-native-startup-input") return {
    ...slice, find: "      if (!actionOnly && trimmedPrompt.length === 0",
    replacement: slice.replacement.replace("!resumeTurn &&", "!actionOnly &&"),
  };
  if (slice.id === "continuity-native-startup-action") return {
    ...slice, find: "        } = actionOnly ? {\n",
    replacement: slice.replacement.replace(": resumeTurn ? {", ": actionOnly ? {"),
  };
  return { ...slice };
});
export const IDLE_COMPACTION_RECIPE = Object.freeze({
  id: "host-idle-compaction-2380c2c7", core: Object.freeze(core.map(slice => Object.freeze(slice))),
  checkpoint: NATIVE_CHECKPOINT_HOST_SLICES, currentState: Object.freeze(currentState.map(slice => Object.freeze(slice))),
});
export function hostRecipeForSourceSha(sourceSha: string) {
  return sourceSha === IDLE_COMPACTION_HOST_SHA ? IDLE_COMPACTION_RECIPE : {
    id: "original-maintained-recipe", core: LIVE_SLICE_PATCHES,
    checkpoint: NATIVE_CHECKPOINT_HOST_SLICES, currentState: NATIVE_CURRENT_STATE_SLICES,
  };
}
