import { randomUUID } from "node:crypto";
import { constants, readFileSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../host/live-slices.ts";
import { reviewedProfilePath } from "../io/paths.ts";
import { applyPatchProfile, approvedSliceSet, MAX_APPROVED_SLICES, OPTIONAL_SLICE_IDS, profileFromSource, type PatchProfile, type SlicePatch } from "../host/profile.ts";

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

export type WriteReviewedProfileFromCopyInput = {
  destDir: string;
  /** Explicit absolute path to a read-only Host bundle input. No full-bundle copy is retained. */
  hostBundle: string;
  slices?: readonly SlicePatch[];
  profileId?: string;
};

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

/** Snapshot caller-owned patches before any await; authoring is not approval of their semantics. */
function authoringSlices(value: unknown): SlicePatch[] {
  const fields = ["id", "startAnchor", "endAnchor", "find", "replacement"] as const;
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_APPROVED_SLICES) {
    invalid(`Profile authoring requires two to ${MAX_APPROVED_SLICES} approved slices.`);
  }
  const ids = new Set<string>();
  const approvedIds = new Set<string>(["create-session", "agent-id", ...OPTIONAL_SLICE_IDS]);
  const patches = value.map((slice: unknown) => {
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) invalid("Invalid profile slice.");
    const record = slice as Record<string, unknown>;
    if (
      Object.keys(record).length !== fields.length ||
      fields.some((key) => typeof record[key] !== "string" || record[key].length === 0)
    ) {
      invalid("Invalid profile slice fields.");
    }
    if (typeof record.id !== "string" || !approvedIds.has(record.id)) {
      invalid("Invalid profile slice id.");
    }
    if (ids.has(record.id)) invalid("Profile slice ids must be unique.");
    ids.add(record.id);
    const patch = Object.fromEntries(fields.map((key) => [key, record[key]])) as SlicePatch;
    if (patch.find === patch.replacement) invalid("Profile slices must change the source.");
    return patch;
  });
  if (!approvedSliceSet(patches)) invalid(`Profile authoring requires two to ${MAX_APPROVED_SLICES} approved slices.`);
  return patches;
}


/** Structural parsing for observation. Does not assert replayability against an unobserved source. */
export function parseReviewedProfile(value: unknown): PatchProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid reviewed profile.");
  const row = value as Record<string, unknown>;
  if (typeof row.profileId !== "string" || !row.profileId.trim() || row.profileId.length > 128 || /[\r\n]/.test(row.profileId) ||
    typeof row.sourceSha256 !== "string" || !row.sourceSha256 || row.sourceSha256.length > 128 ||
    typeof row.transformedSourceSha256 !== "string" || !row.transformedSourceSha256 || row.transformedSourceSha256.length > 128) invalid("Invalid reviewed profile.");
  return { profileId: row.profileId, sourceSha256: row.sourceSha256, transformedSourceSha256: row.transformedSourceSha256, slices: authoringSlices(row.slices) };
}

/** Pure admission check shared by coordinator and H3 preflight; returns a detached target. */
export function validateReviewedProfile(value: unknown, source: string):
  | { ok: true; profile: PatchProfile }
  | { ok: false; code: string } {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "unreviewed-profile" };
    const row = value as Record<string, unknown>;
    if (typeof row.profileId !== "string" || !row.profileId.trim() || row.profileId.length > 128 || /[\r\n]/.test(row.profileId) ||
      typeof row.sourceSha256 !== "string" || typeof row.transformedSourceSha256 !== "string") {
      return { ok: false, code: "unreviewed-profile" };
    }
    const profile: PatchProfile = {
      profileId: row.profileId,
      sourceSha256: row.sourceSha256,
      transformedSourceSha256: row.transformedSourceSha256,
      slices: authoringSlices(row.slices),
    };
    const applied = applyPatchProfile(source, profile);
    if (!applied.ok) return { ok: false, code: applied.code };
    return { ok: true, profile };
  } catch {
    return { ok: false, code: "unreviewed-profile" };
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSource(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function checkDestination(path: string, source: Stats): Promise<void> {
  let existing: Stats;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (sameFile(source, existing)) invalid("Host bundle input must not be the reviewed artifact.");
  if (!existing.isFile() || existing.isSymbolicLink()) invalid("Reviewed artifact must be a regular non-symlink file.");
}

/**
 * Unique protected staging + one atomic rename: readers see a complete old or new artifact.
 * Concurrent successful writers are last-rename-wins. Failed staging is retained, never promoted
 * or automatically deleted; canonical readers ignore it. This is authoring, not live approval.
 */
export async function writeReviewedProfileFromCopy(input: WriteReviewedProfileFromCopyInput): Promise<{
  profilePath: string;
  profile: PatchProfile;
  sourceSha256: string;
  transformedSourceSha256: string;
  diskSha: string;
}> {
  if (typeof input.hostBundle !== "string" || !isAbsolute(input.hostBundle) ||
    typeof input.destDir !== "string" || !isAbsolute(input.destDir)) {
    invalid("Profile authoring requires absolute Host bundle and destination paths.");
  }
  const hostBundle = resolve(input.hostBundle);
  const destDir = resolve(input.destDir);
  const profilePath = join(destDir, "reviewed.json");
  if (hostBundle === profilePath) invalid("Host bundle input must not be the reviewed artifact.");
  const slices = authoringSlices(input.slices === undefined ? LIVE_SLICE_PATCHES : input.slices);
  const profileId = input.profileId === undefined ? "live-h3-copy" : input.profileId;
  if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 128 || /[\r\n]/.test(profileId)) {
    invalid("Profile id must be a non-empty bounded string.");
  }

  const sourceHandle = await open(hostBundle, constants.O_RDONLY | constants.O_NONBLOCK);
  let sourceInfo: Stats;
  let sourceBytes: Buffer;
  try {
    sourceInfo = await sourceHandle.stat();
    if (!sourceInfo.isFile()) invalid("Host bundle input must be a regular file.");
    await checkDestination(profilePath, sourceInfo);
    sourceBytes = await sourceHandle.readFile();
    if (!sameSource(sourceInfo, await sourceHandle.stat()) || sourceBytes.length !== sourceInfo.size) {
      invalid("Host bundle changed during authoring.");
    }
  } finally {
    await sourceHandle.close();
  }
  const source = sourceBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(sourceBytes)) invalid("Host bundle must be valid UTF-8.");
  const diskSha = sha256Bytes(sourceBytes);
  let profile: PatchProfile;
  try {
    profile = profileFromSource(source, slices, profileId);
  } catch {
    invalid("Host bundle does not match the approved profile slices.");
  }
  const applied = applyPatchProfile(source, profile);
  if (!applied.ok || profile.sourceSha256 !== diskSha ||
    sha256Bytes(Buffer.from(applied.source, "utf8")) !== profile.transformedSourceSha256) {
    invalid("Reviewed profile failed source/transformed hash validation.");
  }
  const body = `${JSON.stringify(profile)}\n`;

  await mkdir(destDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(destDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid("Profile directory must not be a symlink.");
  await chmod(destDir, 0o700);
  const stagingPath = join(destDir, `.reviewed-${randomUUID()}.tmp`);
  await writeFile(stagingPath, body, { flag: "wx", mode: 0o600 });
  await chmod(stagingPath, 0o600);
  const staged = await open(stagingPath, "r");
  try {
    if (await staged.readFile("utf8") !== body) invalid("Incomplete staged reviewed artifact.");
    await staged.sync();
  } finally {
    await staged.close();
  }
  if (!sameSource(sourceInfo, await stat(hostBundle))) invalid("Host bundle changed during authoring.");
  await checkDestination(profilePath, sourceInfo);
  await rename(stagingPath, profilePath);
  // No fallible post-commit read: another successful writer may already have published next.
  return {
    profilePath,
    profile,
    sourceSha256: profile.sourceSha256,
    transformedSourceSha256: profile.transformedSourceSha256,
    diskSha,
  };
}

/** Launch never reopens the mutable authoring path. Only profile JSON is pinned, never Host source. */
export async function pinLaunchProfile(root: string, profile: PatchProfile): Promise<string> {
  const bytes = `${JSON.stringify(profile)}\n`;
  const dir = join(root, "state", "launch-profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${randomUUID()}.json`);
  const file = await open(path, "wx+", 0o600);
  try {
    await file.writeFile(bytes, "utf8");
    const buffer = Buffer.alloc(Buffer.byteLength(bytes));
    const read = await file.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== buffer.length || !buffer.equals(Buffer.from(bytes))) throw new Error("launch-profile-readback-failed");
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
