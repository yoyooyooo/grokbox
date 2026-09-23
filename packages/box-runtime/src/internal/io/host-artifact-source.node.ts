import { canonicalJson, sha256Bytes, sha256Text } from "@grokbox/runtime-kernel/hash";
import { parseConfigJson } from "@grokbox/runtime-kernel/config";
import { nativeCheckpointPair } from "../host/native-checkpoint-pair.ts";
import { applyPatchProfile, approvedSliceSet, MAX_APPROVED_SLICES, type PatchProfile } from "../host/profile.ts";
import { readStableSourceSet } from "./stable-source-set.node.mjs";
export class HostSourceFailure extends Error { constructor(readonly code: "source-unavailable" | "source-changed" | "invalid-profile") { super(code); } }
export type HostArtifactPaths = { source: string; worker: string; profile: string | null };
export type HostArtifacts = { source: Uint8Array; worker: Uint8Array; candidate: Uint8Array | null; sourceSha: string; workerSha: string; profileDigest: string | null;
  sourceSet: string; profile: PatchProfile | null; companionQualification: "not-required" | "matched" | "unreviewed"; applicability: "exact" | "mismatch" | "profile-unavailable"; failureCode: string | null; sliceId: string | null; current: () => Promise<boolean> };
/** Stable reads share the same bounded FD/digest owner with development
 * snapshots. Snapshot identity never becomes installation/load authority. */
export async function readHostArtifacts(paths: HostArtifactPaths, signal?: AbortSignal): Promise<HostArtifacts> {
  try {
    const set = await readStableSourceSet([{ path: paths.source, maxBytes: 64 * 1024 * 1024 }, { path: paths.worker, maxBytes: 64 * 1024 * 1024 },
      ...(paths.profile === null ? [] : [{ path: paths.profile, maxBytes: 1024 * 1024, optional: true }])], signal);
    const source = set.files[0]!.bytes!, worker = set.files[1]!.bytes!, profileBytes = set.files[2]?.bytes ?? null;
    const sourceSha = sha256Bytes(source), workerSha = sha256Bytes(worker), profileDigest = profileBytes ? sha256Bytes(profileBytes) : null;
    let profile: PatchProfile | null = null;
    if (profileBytes) { try {
      const v = parseConfigJson(new TextDecoder("utf-8", { fatal: true }).decode(profileBytes)) as PatchProfile;
      if (!v || typeof v.profileId !== "string" || v.profileId.length > 128 || !Array.isArray(v.slices) || v.slices.length > MAX_APPROVED_SLICES || !approvedSliceSet(v.slices)
        || !/^[a-f0-9]{64}$/.test(v.sourceSha256) || !/^[a-f0-9]{64}$/.test(v.transformedSourceSha256) || v.slices.some(s => [s.startAnchor, s.endAnchor, s.find, s.replacement].some(x => typeof x !== "string" || x.length > 65536))) throw Error();
      profile = v;
    } catch { profile = null; } }
    const result = profile ? applyPatchProfile(new TextDecoder("utf-8", { fatal: true }).decode(source), profile) : null;
    return { source, worker, sourceSha, workerSha, profileDigest, profile,
      companionQualification: profile?.slices.some(s => s.id.startsWith("continuity-native-")) ? (nativeCheckpointPair(sourceSha, workerSha) ? "matched" : "unreviewed") : "not-required",
      candidate: result?.ok ? Buffer.from(result.source) : null,
      applicability: result === null ? "profile-unavailable" : result.ok ? "exact" : "mismatch",
      failureCode: result && !result.ok ? result.code : profileBytes && !profile ? "invalid-profile" : null, sliceId: result && !result.ok ? result.sliceId ?? null : null,
      sourceSet: sha256Text(canonicalJson([sourceSha, workerSha, profileDigest])), current: set.current };
  } catch (error) {
    if (error instanceof HostSourceFailure) throw error;
    throw new HostSourceFailure((error as { code?: string })?.code === "source-changed" ? "source-changed" : "source-unavailable");
  }
}
