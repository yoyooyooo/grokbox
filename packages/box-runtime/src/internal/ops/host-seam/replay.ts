import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../../host/live-slices.ts";
import { profileFromSource, type PatchProfile, type SlicePatch } from "../../host/profile.ts";
import { observeHostBundles, readHostBundleSource } from "../../io/provenance.node.ts";
import { hostBundlesDir } from "../../io/paths.ts";
import { KNIFE_SLICE_IDS, observeKnifePoints, profileDigest, type KnifePointRow, type KnifeSliceId } from "./knife-points.ts";

export const REPLAY_TOOL_REVISION = "hso-2.replay.v1";

export type GoldenSiteLabel = {
  sliceId: KnifeSliceId;
  startByte: number;
  endByte: number;
  role: string;
  source: "human-review";
};

export type ReplayRow = KnifePointRow & {
  support: "reviewed_match" | "unique_unreviewed" | "unsupported_bundle" | "unknown-sha" | "missing_profile" | "corpus_corrupt" | "wrong-site";
  goldenState: "match" | "mismatch" | "missing";
};

export type ReplayReport = {
  rows: ReplayRow[];
  requested: string[];
  completed: string[];
  truncated: boolean;
  regressionPassed: boolean;
  supportGatePassed: boolean;
  codes: string[];
  corpus: "present" | "missing";
  toolRevision: string;
  recipeRevision: string;
  replayKey: string;
};

export function liveKnifeRecipe(): SlicePatch[] {
  return LIVE_SLICE_PATCHES.filter((slice) => slice.id === "create-session" || slice.id === "agent-id");
}

export function recipeRevisionOf(slices: readonly SlicePatch[]): string {
  return sha256Text(JSON.stringify(slices));
}

export function publishedProfileSha(profile: PatchProfile): string {
  return sha256Text(`${JSON.stringify(profile)}\n`);
}

export function replayKeyOf(input: { sourceSha: string; profileSha: string; toolRevision: string; recipeRevision: string }): string {
  return sha256Text(`${input.sourceSha}:${input.profileSha}:${input.toolRevision}:${input.recipeRevision}`);
}

function emptyRow(sourceSha: string, sliceId: KnifeSliceId, code: ReplayRow["support"], profileSha = "0".repeat(64), recipeDigest = "0".repeat(64)): ReplayRow {
  return {
    sourceSha,
    profileSha,
    recipeDigest,
    sliceId,
    evidenceKind: "slice-patch",
    sourceIntegrity: code === "unknown-sha" ? "unknown-sha" : "ok",
    startCount: 0,
    endCount: 0,
    findInWindowCount: 0,
    findGlobalCount: 0,
    endAfterStart: false,
    locationRange: null,
    sourceRange: null,
    passRange: null,
    code: code === "unknown-sha" ? "unknown-sha" : "slice-not-unique",
    runtimeChecked: true,
    semanticLabelState: "unknown",
    support: code,
    goldenState: "missing",
  };
}

export async function writeReplayProfileCopy(root: string, profile: PatchProfile): Promise<string> {
  const sha = publishedProfileSha(profile);
  const dir = join(hostBundlesDir(root), "profiles");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${sha}.json`);
  try {
    await writeFile(path, `${JSON.stringify(profile)}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  return sha;
}

export async function bindReviewedProfile(root: string, sourceSha: string, profile: PatchProfile): Promise<string> {
  const sha = await writeReplayProfileCopy(root, profile);
  const dir = join(hostBundlesDir(root), "generations", sourceSha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "reviewed-profile.sha"), `${sha}\n`, { mode: 0o600 });
  return sha;
}

async function readBoundProfile(root: string, sourceSha: string): Promise<PatchProfile | "missing-copy" | null> {
  try {
    const sha = (await readFile(join(hostBundlesDir(root), "generations", sourceSha, "reviewed-profile.sha"), "utf8")).trim();
    const profile = await readReplayProfileCopy(root, sha);
    return profile ?? "missing-copy";
  } catch {
    return null;
  }
}

export async function writeGoldenLabels(root: string, sourceSha: string, labels: readonly GoldenSiteLabel[]): Promise<void> {
  const dir = join(hostBundlesDir(root), "generations", sourceSha);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "golden.json"), `${JSON.stringify({ schemaVersion: 1, labels }, null, 2)}\n`, { mode: 0o600 });
}

export async function readGoldenLabels(root: string, sourceSha: string): Promise<GoldenSiteLabel[] | "missing" | "invalid"> {
  try {
    const parsed = JSON.parse(await readFile(join(hostBundlesDir(root), "generations", sourceSha, "golden.json"), "utf8")) as {
      labels?: GoldenSiteLabel[];
    };
    if (!Array.isArray(parsed.labels) || parsed.labels.length !== 2) return "invalid";
    return parsed.labels;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
    return "invalid";
  }
}

export async function readReplayProfileCopy(root: string, profileSha: string): Promise<PatchProfile | null> {
  try {
    const text = await readFile(join(hostBundlesDir(root), "profiles", `${profileSha}.json`), "utf8");
    if (sha256Text(text) !== profileSha) return null;
    return JSON.parse(text) as PatchProfile;
  } catch {
    return null;
  }
}

function compareGolden(row: KnifePointRow, labels: GoldenSiteLabel[] | "missing" | "invalid"): ReplayRow["goldenState"] {
  if (labels === "missing" || labels === "invalid") return "missing";
  const label = labels.find((item) => item.sliceId === row.sliceId);
  if (!label || row.sourceRange == null) return "mismatch";
  if (row.sourceRange.startByte === label.startByte && row.sourceRange.endByte === label.endByte) return "match";
  return "mismatch";
}

function supportOf(input: {
  applyCode: string;
  goldenState: ReplayRow["goldenState"];
  reviewed: boolean;
  liveRecipe: boolean;
  sourceIntegrity: "ok" | "unknown-sha";
}): ReplayRow["support"] {
  if (input.sourceIntegrity === "unknown-sha") return "unknown-sha";
  if (input.goldenState === "mismatch") return "wrong-site";
  if (input.reviewed && input.applyCode === "ok" && input.goldenState === "match") return "reviewed_match";
  if (input.liveRecipe && input.applyCode === "ok") return "unique_unreviewed";
  if (!input.reviewed && input.goldenState === "missing" && input.applyCode === "ok") return "unique_unreviewed";
  return "unsupported_bundle";
}

export async function replayHostSeam(input: {
  root: string;
  sha?: string;
  all?: boolean;
  profile?: PatchProfile;
  liveRecipe?: boolean;
  skipShas?: readonly string[];
}): Promise<ReplayReport> {
  if (Boolean(input.sha) === Boolean(input.all)) {
    throw new Error("replay requires exactly one of sha or all");
  }
  const observed = await observeHostBundles(input.root);
  const available = observed.generations.map((row) => row.sourceSha);
  const requested = input.all ? available : input.sha ? [input.sha] : [];
  const recipe = liveKnifeRecipe();
  const recipeRevision = recipeRevisionOf(input.profile?.slices ?? recipe);
  const rows: ReplayRow[] = [];
  const completed: string[] = [];
  const codes: string[] = [];
  let truncated = false;
  const skip = new Set(input.skipShas ?? []);

  if (requested.length === 0) {
    return {
      rows: [],
      requested,
      completed,
      truncated: false,
      regressionPassed: false,
      supportGatePassed: false,
      codes: ["corpus_missing"],
      corpus: "missing",
      toolRevision: REPLAY_TOOL_REVISION,
      recipeRevision,
      replayKey: replayKeyOf({ sourceSha: "none", profileSha: "none", toolRevision: REPLAY_TOOL_REVISION, recipeRevision }),
    };
  }

  for (const sourceSha of requested) {
    if (skip.has(sourceSha)) {
      truncated = true;
      codes.push("skipped_sha");
      continue;
    }
    const source = await readHostBundleSource(input.root, sourceSha);
    if (source == null) {
      rows.push(emptyRow(sourceSha, "create-session", "corpus_corrupt"), emptyRow(sourceSha, "agent-id", "corpus_corrupt"));
      codes.push("corpus_corrupt");
      completed.push(sourceSha);
      continue;
    }
    let profile = input.profile;
    let reviewed = Boolean(profile && profile.sourceSha256 === sourceSha);
    let usedLive = input.liveRecipe === true;
    if (!profile) {
      const bound = await readBoundProfile(input.root, sourceSha);
      if (bound === "missing-copy") {
        rows.push(emptyRow(sourceSha, "create-session", "missing_profile"), emptyRow(sourceSha, "agent-id", "missing_profile"));
        codes.push("missing_profile");
        completed.push(sourceSha);
        continue;
      }
      if (bound) {
        profile = bound;
        reviewed = bound.sourceSha256 === sourceSha;
      } else {
        usedLive = true;
        try {
          profile = profileFromSource(source, recipe, "live-recipe");
        } catch {
          profile = {
            profileId: "live-recipe",
            sourceSha256: sourceSha,
            transformedSourceSha256: "0".repeat(64),
            slices: recipe,
          };
        }
        reviewed = false;
      }
    }
    const golden = await readGoldenLabels(input.root, sourceSha);
    if (golden === "invalid") truncated = true;
    const knife = observeKnifePoints(source, profile);
    const { profileSha, recipeDigest } = profileDigest(profile);
    for (const row of knife.rows) {
      const goldenState = compareGolden(row, golden);
      const support = supportOf({
        applyCode: knife.applyCode,
        goldenState,
        reviewed,
        liveRecipe: usedLive,
        sourceIntegrity: row.sourceIntegrity,
      });
      rows.push({ ...row, profileSha, recipeDigest, support, goldenState });
      codes.push(support === row.code ? row.code : support);
    }
    if (knife.traceMismatch) codes.push("trace_mismatch");
    completed.push(sourceSha);
  }

  const shaSupports = requested.map((sha) => {
    const pair = rows.filter((row) => row.sourceSha === sha);
    return pair.length === 2 && pair.every((row) => row.support === "reviewed_match");
  });
  const supportGatePassed = shaSupports.length > 0 && shaSupports.every(Boolean);
  const regressionPassed = rows.length > 0
    && !codes.includes("trace_mismatch")
    && requested.every((sha) => rows.some((row) => row.sourceSha === sha));

  return {
    rows,
    requested,
    completed,
    truncated,
    regressionPassed,
    supportGatePassed,
    codes: [...new Set(codes)],
    corpus: "present",
    toolRevision: REPLAY_TOOL_REVISION,
    recipeRevision,
    replayKey: replayKeyOf({
      sourceSha: requested.join(","),
      profileSha: input.profile ? publishedProfileSha(input.profile) : "live",
      toolRevision: REPLAY_TOOL_REVISION,
      recipeRevision,
    }),
  };
}

export function assertReplayCoverage(report: ReplayReport): void {
  if (report.corpus === "missing") {
    if (report.regressionPassed || report.supportGatePassed || report.rows.length === 0 && report.codes.includes("ok")) {
      throw new Error("missing corpus cannot 0/0 pass");
    }
    return;
  }
  for (const sha of report.requested) {
    const pair = report.rows.filter((row) => row.sourceSha === sha);
    if (pair.length !== 2) throw new Error(`skipped or swallowed SHA ${sha}`);
    if (pair[0]?.sliceId !== "create-session" || pair[1]?.sliceId !== "agent-id") {
      throw new Error("matrix must emit create-session then agent-id");
    }
  }
  if (report.codes.includes("skipped_sha")) throw new Error("skipped SHA is not a green replay");
}

export async function writeReplayReport(root: string, report: ReplayReport): Promise<void> {
  const dir = join(hostBundlesDir(root), "replay");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${report.replayKey}.json`), `${JSON.stringify(report)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "HEAD"), `${report.replayKey}\n`, { mode: 0o600 });
}

export async function readLastReplayReport(root: string): Promise<ReplayReport | null> {
  try {
    const key = (await readFile(join(hostBundlesDir(root), "replay", "HEAD"), "utf8")).trim();
    return JSON.parse(await readFile(join(hostBundlesDir(root), "replay", `${key}.json`), "utf8")) as ReplayReport;
  } catch {
    return null;
  }
}
