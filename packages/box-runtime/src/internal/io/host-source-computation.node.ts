import { setImmediate } from "node:timers/promises";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { containsRetiredHarnessWrite } from "../host/harness-stick.ts";
import { approvedSliceSet, profileTransformSteps, type PatchProfile, type SlicePatch, type TransformFailure, type TransformResult } from "../host/profile.ts";

/** Background inspection must not monopolize the management event loop. Run
 * the original pure transformation one slice at a time, with scoped aborts.
 * No worker process, native mutation, new qualification or second interpreter. */
async function transform(source: string, slices: readonly SlicePatch[], signal?: AbortSignal): Promise<TransformResult> {
  const steps = profileTransformSteps(source, slices);
  for (;;) {
    signal?.throwIfAborted();
    const result = steps.next();
    if (result.done) return result.value;
    await setImmediate(undefined, { signal });
  }
}
export async function applyPatchProfileCooperatively(source: string, profile: PatchProfile, signal?: AbortSignal): Promise<TransformResult> {
  signal?.throwIfAborted();
  const frozen = { ...profile, slices: profile.slices.map(slice => ({ ...slice })) };
  if (sha256Text(source) !== frozen.sourceSha256) return { ok: false, code: "unknown-sha" };
  if (containsRetiredHarnessWrite(frozen.slices)) return { ok: false, code: "retired-slice" };
  if (!approvedSliceSet(frozen.slices)) return { ok: false, code: "slice-not-unique" };
  const result = await transform(source, frozen.slices, signal);
  if (!result.ok) return result;
  return result.transformedSha256 === frozen.transformedSourceSha256 ? result : { ok: false, code: "transformed-mismatch" };
}
export async function preflightProfileRecipeCooperatively(source: string, slices: readonly SlicePatch[], profileId: string,
  signal?: AbortSignal): Promise<{ ok: true; profile: PatchProfile } | TransformFailure> {
  const selected = slices.map(slice => ({ ...slice }));
  const result = await transform(source, selected, signal);
  return result.ok ? { ok: true, profile: { profileId, sourceSha256: result.sourceSha256,
    transformedSourceSha256: result.transformedSha256, slices: selected } } : result;
}
