import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { profileObserveThenWriteNext, reviewedProfilePath } from "@grokbox/box-runtime/runtime";
import type { CliDeps } from "./deps.ts";

/** Default live Host entry; keep in lockstep with box-runtime `LIVE_HOST_BUNDLE`. */
export const LIVE_HOST_BUNDLE_PATH = "/home/box/sand-host/host-main.cjs";
export const PROFILE_WRITE_NEXT = profileObserveThenWriteNext(LIVE_HOST_BUNDLE_PATH);

const HEX64 = /^[a-f0-9]{64}$/;

export type SourceMatch = "match" | "mismatch" | "unavailable";

export function classifySourceMatch(liveSha: string | null, profileSha: string | null): SourceMatch {
  if (liveSha === null || profileSha === null) return "unavailable";
  if (!HEX64.test(liveSha) || !HEX64.test(profileSha)) return "unavailable";
  return liveSha === profileSha ? "match" : "mismatch";
}

export function shaPrefix(sha: string | null): string | undefined {
  if (sha === null || !HEX64.test(sha)) return undefined;
  return sha.slice(0, 12);
}

export function overlaySourceMatch<T extends { host: "official" | "custom" | "unknown"; hostReason: string | null }>(
  classified: T,
  match: SourceMatch,
): T {
  if (match !== "mismatch") return classified;
  return { ...classified, host: "unknown", hostReason: "source_mismatch" };
}

export async function readLiveShaFromPath(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

export async function readProfileShaFromRoot(boxRuntimeRoot: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(reviewedProfilePath(boxRuntimeRoot), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const sha = (parsed as { sourceSha256?: unknown }).sourceSha256;
    return typeof sha === "string" && HEX64.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export const hostSourcePorts = {
  readLiveSha: async (_deps: CliDeps): Promise<string | null> => await readLiveShaFromPath(LIVE_HOST_BUNDLE_PATH),
  readProfileSha: async (deps: CliDeps): Promise<string | null> => await readProfileShaFromRoot(deps.boxRuntimeRoot),
};
