import { readFileSync } from "node:fs";
import { reviewedProfilePath } from "./paths.ts";
import type { PatchProfile } from "./transform.ts";

export function loadDurableReviewedProfile(root: string): PatchProfile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(reviewedProfilePath(root), "utf8")) as PatchProfile;
    if (!parsed || typeof parsed !== "object") return undefined;
    if (typeof parsed.profileId !== "string" || parsed.profileId.length === 0) return undefined;
    if (typeof parsed.sourceSha256 !== "string" || parsed.sourceSha256.length === 0) return undefined;
    if (typeof parsed.transformedSourceSha256 !== "string" || parsed.transformedSourceSha256.length === 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
