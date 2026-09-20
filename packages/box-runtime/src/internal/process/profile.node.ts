import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { sha256Bytes } from "@grokbox/runtime-kernel/hash";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../host/live-slices.ts";
import { hostRecipeForSourceSha } from "../host/source-recipes.ts";
import { parseProfileCapability, upgradeProfileCapability, type CapabilityUpgradeReceipt, type ProfileCapability } from "../host/profile-capabilities.ts";
import { acquireAdvisoryGate } from "../io/advisory-gate.node.ts";
import {
  ALL_ENVELOPE_SLICE_IDS,
  admitWriteEnvelope,
  envelopeProfileShape,
  envelopeWindowsFromRecipe,
  envelopeWindowsFromReviewed,
  generationEnvelopePath,
  observeEnvelopeWindowsFile,
  type EnvelopeInsertionGroup,
  type EnvelopeWindows,
  type WriteEnvelopeAdmission,
} from "../ops/host-seam/envelope-windows.ts";
import { readHostBundleSource } from "../io/provenance.node.ts";
import { retainedGenerationSourcePath, reviewedProfilePath } from "../io/paths.ts";
import { applyPatchProfile, approvedSliceSet, MAX_APPROVED_SLICES, OPTIONAL_SLICE_IDS, preflightProfileRecipe, type TransformFailure, type PatchProfile, type SliceId, type SlicePatch } from "../host/profile.ts";

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

const SHA = /^[a-f0-9]{64}$/;
const ENVELOPE_SLICE_SET = new Set<string>(ALL_ENVELOPE_SLICE_IDS);

export type ProfileWriteLineage = {
  /** Runtime root for retain dir + current reviewed.json pin. */
  root: string;
  /** When set, hostBundle must be that generation's retain `source`. */
  retainedSha?: string;
  /** Waives retain-dir bind (A) only; never skips envelope reject-on-drift (B). */
  allowUnretained?: boolean;
  /** Exact rejecting slice ids (windowSha / count / find.inWindow). No superset. */
  sliceReview?: readonly string[];
};

export type WriteReviewedProfileFromCopyInput = {
  destDir: string;
  /** Explicit absolute path to a read-only Host bundle input. No full-bundle copy is retained. */
  hostBundle: string;
  slices?: readonly SlicePatch[];
  capability?: string;
  /** Exact durable bytes observed during capability analysis, not the source digest. */
  expectedReviewedSha?: string;
  profileId?: string;
  /** Optional. CLI always supplies this; library tests may omit it. */
  lineage?: ProfileWriteLineage;
};

export type ProfileWriteRefusal =
  | "unretained_source"
  | "retained_missing"
  | "missing_golden"
  | "envelope_unmeasurable"
  | "envelope_drift"
  | "recipe_unapplicable"
  | "capability_baseline_invalid"
  | "capability_baseline_changed";

export type WriteEnvelopeReceipt = {
  bootstrap: boolean;
  baselineSourceSha: string | null;
  rejectingIds: SliceId[];
  informationalIds: SliceId[];
  insertionGroups: EnvelopeInsertionGroup[];
  sliceReview: string[];
};

export type WriteReviewedProfileReceipt = {
  profilePath: string;
  profile: PatchProfile;
  sourceSha256: string;
  transformedSourceSha256: string;
  diskSha: string;
  unretained_source?: true;
  envelope?: WriteEnvelopeReceipt;
  capabilityUpgrade?: CapabilityUpgradeReceipt;
};

export function profileWriteUnretainedNext(fromPath: string): string {
  return `grokbox runtime profile observe --from ${fromPath}`;
}

/** Observe → write `--sha` when the live digest is a full hex SHA; otherwise observe-only. */
export function profileObserveThenWriteNext(fromPath: string, sourceSha256?: string | null): string {
  const observe = profileWriteUnretainedNext(fromPath);
  return typeof sourceSha256 === "string" && SHA.test(sourceSha256)
    ? `${observe} then grokbox runtime profile write --sha ${sourceSha256}`
    : observe;
}

export function profileWriteMissingGoldenNext(pinSourcePath: string): string {
  return `grokbox runtime profile observe --from ${pinSourcePath}`;
}

export function profileWriteDriftNext(candidateSha: string, driftedIds: readonly string[], capability?: ProfileCapability, baselineSha?: string): string {
  const ids = driftedIds.length > 0 ? driftedIds.join(",") : "<drifted-slice-ids>";
  const select = capability ? ` --capability ${capability}` : "";
  const expected = capability ? ` --expected-reviewed-sha ${baselineSha ?? "<reviewed-sha>"}` : "";
  return `grokbox runtime profile analyze --sha ${candidateSha} --out <abs>${select} then grokbox runtime profile write --sha ${candidateSha}${select}${expected} --slice-review ${ids}`;
}

/** Write command after analyze has named reject ids. Does not loop back to analyze. */
export function profileWriteExecutableNext(candidateSha: string, driftedIds: readonly string[], capability?: ProfileCapability, baselineSha?: string): string {
  const select = capability ? ` --capability ${capability} --expected-reviewed-sha ${baselineSha ?? "<reviewed-sha>"}` : "";
  return driftedIds.length > 0
    ? `grokbox runtime profile write --sha ${candidateSha}${select} --slice-review ${driftedIds.join(",")}`
    : `grokbox runtime profile write --sha ${candidateSha}${select}`;
}

/** A failed recipe needs adaptation, not a replay of the same write command. */
export function profileRecipeFailureNext(fromPath: string): string {
  const quoted = `'${fromPath.replace(/'/g, "'\\''")}'`;
  return `grokbox runtime profile propose --from ${quoted} --out <abs>`;
}

export type ProfileWriteInspect = {
  pinSha: string | null;
  candidateSha: string;
  bootstrap: boolean;
  refusal: "missing_golden" | "envelope_unmeasurable" | "envelope_drift" | "recipe_unapplicable" | null;
  recipeFailure?: TransformFailure;
  capabilityUpgrade?: CapabilityUpgradeReceipt;
  requiredIds: SliceId[];
  informationalIds: SliceId[];
  insertionGroups: EnvelopeInsertionGroup[];
  sliceReviewRequired: boolean;
  generationPresent: boolean;
  limitations: string[];
  next: string;
};

async function loadWriteEnvelopeBaseline(root: string): Promise<{
  pin: PatchProfile | undefined;
  pinSha: string | null;
  golden: EnvelopeWindows | null;
  goldenInvalid: boolean;
}> {
  const pin = loadDurableReviewedProfile(root);
  const pinSha = pin && SHA.test(pin.sourceSha256) ? pin.sourceSha256 : null;
  let golden: EnvelopeWindows | null = null;
  let goldenInvalid = false;
  if (pinSha) {
    const goldenRead = await observeEnvelopeWindowsFile(generationEnvelopePath(root, pinSha));
    if (goldenRead.state === "present") golden = goldenRead.value;
    else if (goldenRead.state !== "missing") goldenInvalid = true;
  }
  return { pin, pinSha, golden, goldenInvalid };
}

async function retainedGenerationPresent(root: string, sha: string): Promise<boolean> {
  try {
    const info = await lstat(retainedGenerationSourcePath(root, sha));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

type CapabilityBaseline = { path: string; info: Stats; sha: string; slices: SlicePatch[]; receipt: CapabilityUpgradeReceipt };

function capabilityBaseline(root: string, source: string, capability: ProfileCapability): CapabilityBaseline {
  const path = reviewedProfilePath(root);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("invalid_baseline");
    const bytes = readFileSync(path);
    if (!sameSource(info, lstatSync(path))) throw new Error("baseline_changed");
    const checked = validateReviewedProfile(JSON.parse(bytes.toString("utf8")), source);
    if (!checked.ok) throw new Error("invalid_baseline");
    const selected = upgradeProfileCapability(source, checked.profile, capability);
    const sha = sha256Bytes(bytes);
    return { path, info, sha, slices: selected.slices, receipt: { capability, baselineProfileSha256: sha,
      updatedIds: selected.updatedIds, addedIds: selected.addedIds } };
  } catch {
    refuse("capability_baseline_invalid", "Capability upgrade requires a regular, applicable same-source reviewed baseline.",
      "grokbox runtime profile status --json", { capability });
  }
}

function recheckCapabilityBaseline(baseline: CapabilityBaseline): void {
  try {
    if (!sameSource(baseline.info, lstatSync(baseline.path)) || sha256Bytes(readFileSync(baseline.path)) !== baseline.sha) throw new Error("changed");
  } catch {
    refuse("capability_baseline_changed", "Reviewed baseline changed during capability authoring; nothing was published.",
      "grokbox runtime profile status --json", { capability: baseline.receipt.capability });
  }
}

async function loadCandidateEnvelopeWindows(
  root: string,
  candidateSha: string,
  recipe: readonly SlicePatch[] | undefined,
  generationPresent: boolean,
  capability?: ProfileCapability,
): Promise<{ candidate: EnvelopeWindows | null; sourceAvailable: boolean; recipeFailure?: TransformFailure; capabilityUpgrade?: CapabilityUpgradeReceipt }> {
  if (!generationPresent) return { candidate: null, sourceAvailable: false };
  const source = await readHostBundleSource(root, candidateSha);
  if (!source) return { candidate: null, sourceAvailable: false };
  // Match the exact recipe the writer will apply; historical windows cannot
  // establish that newly selected patches apply to this generation.
  const selected = capability ? capabilityBaseline(root, source, capability) : undefined;
  const inspected = preflightProfileRecipe(source, authoringSlices(selected?.slices ?? recipe ?? hostRecipeForSourceSha(candidateSha).core), "write-envelope-candidate");
  const extra = selected ? { capabilityUpgrade: selected.receipt } : {};
  if (!inspected.ok) return { candidate: null, sourceAvailable: true, recipeFailure: inspected, ...extra };
  if (selected) recheckCapabilityBaseline(selected);
  return { candidate: envelopeWindowsFromRecipe(source, inspected.profile), sourceAvailable: true, ...extra };
}

/** Read-only write-gate compare for analyze. Never authors reviewed.json. */
export async function inspectRetainedWriteEnvelope(root: string, candidateSha: string, recipe?: readonly SlicePatch[], capabilityName?: string): Promise<ProfileWriteInspect> {
  const capability = capabilityName === undefined ? undefined : parseProfileCapability(capabilityName);
  if (typeof root !== "string" || !isAbsolute(root)) invalid("Profile write lineage requires an absolute runtime root.");
  if (!SHA.test(candidateSha)) invalid("--sha must be a 64-character lowercase hex source digest.");
  const resolved = resolve(root);
  const baseline = await loadWriteEnvelopeBaseline(resolved);
  const generationPresent = await retainedGenerationPresent(resolved, candidateSha);
  const { candidate, sourceAvailable, recipeFailure, capabilityUpgrade } = await loadCandidateEnvelopeWindows(resolved, candidateSha, recipe, generationPresent, capability);
  const admission = admitWriteEnvelope({
    pinSha: baseline.pinSha,
    golden: baseline.golden,
    goldenInvalid: baseline.goldenInvalid,
    candidate,
    sliceReview: [],
  });
  const requiredIds = admission.requiredIds;
  const sliceReviewRequired = !recipeFailure && !admission.ok && admission.refusal === "envelope_drift";
  const limitations: string[] = [];
  if (!generationPresent) limitations.push("retained_generation_missing");
  if (recipeFailure) limitations.push("recipe_unapplicable");
  else if (generationPresent && (!sourceAvailable || !candidate && !admission.ok)) limitations.push("candidate_unmeasurable");
  let next: string;
  if (!generationPresent) {
    next = profileWriteUnretainedNext(LIVE_HOST_BUNDLE);
  } else if (recipeFailure || !sourceAvailable || !candidate && !admission.ok && admission.refusal === "envelope_unmeasurable") {
    next = profileRecipeFailureNext(retainedGenerationSourcePath(resolved, candidateSha));
  } else if (!admission.ok && admission.refusal === "missing_golden" && baseline.pinSha) {
    next = profileWriteMissingGoldenNext(retainedGenerationSourcePath(resolved, baseline.pinSha));
  } else {
    next = profileWriteExecutableNext(candidateSha, requiredIds, capability, capabilityUpgrade?.baselineProfileSha256);
  }
  return {
    pinSha: baseline.pinSha,
    candidateSha,
    bootstrap: admission.bootstrap,
    refusal: recipeFailure ? "recipe_unapplicable" : !sourceAvailable && generationPresent ? "envelope_unmeasurable" : admission.ok ? null : admission.refusal,
    ...(recipeFailure ? { recipeFailure } : {}),
    ...(capabilityUpgrade ? { capabilityUpgrade } : {}),
    requiredIds,
    informationalIds: admission.informational.map((row) => row.id),
    insertionGroups: admission.insertionGroups,
    sliceReviewRequired,
    generationPresent,
    limitations,
    next,
  };
}

export class ProfileWriteRefused extends BoxRuntimeError {
  readonly refusal: ProfileWriteRefusal;
  readonly next: string;
  readonly details: Record<string, unknown>;

  constructor(
    refusal: ProfileWriteRefusal,
    message: string,
    next: string,
    details: Record<string, unknown> = {},
  ) {
    super("invalid_usage", message);
    this.name = "ProfileWriteRefused";
    this.refusal = refusal;
    this.next = next;
    this.details = details;
  }

  /** Public diagnostic is a finite projection, never the authoring payload or source bytes. */
  publicDiagnostic(): { refusal: ProfileWriteRefusal; recipeFailure?: TransformFailure } {
    const descriptor = Object.getOwnPropertyDescriptor(this.details, "recipeFailure");
    const raw = descriptor && "value" in descriptor ? descriptor.value : null;
    const own = (key: string): unknown => {
      if (!raw || typeof raw !== "object") return undefined;
      const field = Object.getOwnPropertyDescriptor(raw, key);
      return field && "value" in field ? field.value : undefined;
    };
    const code = own("code"), sliceId = own("sliceId");
    const codes = ["unknown-sha", "anchor-missing", "anchor-duplicate", "find-missing", "find-duplicate", "transformed-mismatch", "slice-not-unique", "retired-slice"];
    if (this.refusal !== "recipe_unapplicable" || own("ok") !== false || typeof code !== "string" || !codes.includes(code)) return { refusal: this.refusal };
    const ids = new Set<string>(["create-session", "agent-id", ...OPTIONAL_SLICE_IDS]);
    return { refusal: this.refusal, recipeFailure: { ok: false, code: code as TransformFailure["code"],
      ...(typeof sliceId === "string" && ids.has(sliceId) ? { sliceId: sliceId as SliceId } : {}) } };
  }
}

function invalid(message: string): never {
  throw new BoxRuntimeError("invalid_usage", message);
}

function refuse(
  refusal: ProfileWriteRefusal,
  message: string,
  next: string,
  details: Record<string, unknown> = {},
): never {
  throw new ProfileWriteRefused(refusal, message, next, details);
}

function normalizeSliceReview(ids: readonly string[] | undefined): string[] {
  if (!ids) return [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string" || raw.length === 0) invalid("Invalid slice-review id.");
    for (const id of raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0)) {
      if (!ENVELOPE_SLICE_SET.has(id)) invalid(`Unknown slice-review id '${id}'.`);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
  }
  return unique;
}

function envelopeReceipt(admission: WriteEnvelopeAdmission, sliceReview: readonly string[]): WriteEnvelopeReceipt {
  return {
    bootstrap: admission.bootstrap,
    baselineSourceSha: admission.baselineSourceSha,
    rejectingIds: admission.requiredIds,
    informationalIds: admission.informational.map((row) => row.id),
    insertionGroups: admission.insertionGroups,
    sliceReview: [...sliceReview],
  };
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
export async function writeReviewedProfileFromCopy(
  input: WriteReviewedProfileFromCopyInput,
): Promise<WriteReviewedProfileReceipt> {
  if (typeof input.hostBundle !== "string" || !isAbsolute(input.hostBundle) ||
    typeof input.destDir !== "string" || !isAbsolute(input.destDir)) {
    invalid("Profile authoring requires absolute Host bundle and destination paths.");
  }
  const hostBundle = resolve(input.hostBundle);
  const destDir = resolve(input.destDir);
  const profilePath = join(destDir, "reviewed.json");
  if (hostBundle === profilePath) invalid("Host bundle input must not be the reviewed artifact.");
  const capability = input.capability === undefined ? undefined : parseProfileCapability(input.capability);
  if (capability && (input.slices !== undefined || !input.lineage?.retainedSha || input.lineage.allowUnretained || process.platform !== "linux")) {
    invalid("Capability upgrades require a retained source on the local Linux Box; explicit slices and unretained input are not allowed.");
  }
  if (capability ? typeof input.expectedReviewedSha !== "string" || !SHA.test(input.expectedReviewedSha) : input.expectedReviewedSha !== undefined) {
    invalid("--expected-reviewed-sha is required only with --capability and must be the analyzed baseline's 64-character digest.");
  }
  let slices = authoringSlices(input.slices === undefined ? LIVE_SLICE_PATCHES : input.slices);
  const profileId = input.profileId === undefined ? "live-h3-copy" : input.profileId;
  if (typeof profileId !== "string" || !profileId.trim() || profileId.length > 128 || /[\r\n]/.test(profileId)) {
    invalid("Profile id must be a non-empty bounded string.");
  }
  const lineage = input.lineage;
  if (lineage && (typeof lineage.root !== "string" || !isAbsolute(lineage.root))) {
    invalid("Profile write lineage requires an absolute runtime root.");
  }
  const sliceReview = normalizeSliceReview(lineage?.sliceReview);
  const allowUnretained = lineage?.allowUnretained === true;
  if (lineage && allowUnretained && lineage.retainedSha !== undefined) {
    invalid("Profile write --sha cannot be combined with --allow-unretained.");
  }
  let retainedInfo: Stats | undefined;
  let retainedPath: string | undefined;
  if (lineage && !allowUnretained) {
    if (typeof lineage.retainedSha !== "string" || !SHA.test(lineage.retainedSha)) {
      refuse(
        "unretained_source",
        "Profile write requires a retained source SHA, or --from with --allow-unretained --confirm.",
        profileWriteUnretainedNext(hostBundle),
      );
    }
    retainedPath = retainedGenerationSourcePath(resolve(lineage.root), lineage.retainedSha);
    try {
      retainedInfo = await lstat(retainedPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        refuse(
          "retained_missing",
          `No retained generation for ${lineage.retainedSha}.`,
          profileWriteUnretainedNext(LIVE_HOST_BUNDLE),
          { retainedSha: lineage.retainedSha },
        );
      }
      throw error;
    }
    if (!retainedInfo.isFile() || retainedInfo.isSymbolicLink()) {
      refuse(
        "retained_missing",
        `No retained generation for ${lineage.retainedSha}.`,
        profileWriteUnretainedNext(LIVE_HOST_BUNDLE),
        { retainedSha: lineage.retainedSha },
      );
    }
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
  if (input.slices === undefined && !capability) slices = authoringSlices(hostRecipeForSourceSha(diskSha).core);

  if (lineage && !allowUnretained) {
    const retainedSha = lineage.retainedSha as string;
    if (retainedSha !== diskSha) {
      refuse(
        "unretained_source",
        "Retained source SHA does not match the Host bundle bytes.",
        profileWriteUnretainedNext(LIVE_HOST_BUNDLE),
        { retainedSha, diskSha },
      );
    }
    if (!retainedInfo || !retainedPath || !sameFile(sourceInfo, retainedInfo)) {
      refuse(
        "unretained_source",
        "Profile write --sha must load bytes from the retain directory.",
        profileWriteUnretainedNext(LIVE_HOST_BUNDLE),
        { retainedSha, retainedPath, hostBundle },
      );
    }
  }

  const selected = capability ? capabilityBaseline(resolve(lineage!.root), source, capability) : undefined;
  if (selected) {
    if (resolve(selected.path) !== profilePath) invalid("Capability upgrades must publish to the baseline's canonical reviewed profile.");
    if (selected.sha !== input.expectedReviewedSha) {
      refuse("capability_baseline_changed", "Reviewed baseline differs from the analyzed digest; nothing was published.",
        `grokbox runtime profile analyze --sha ${diskSha} --out <abs> --capability ${capability}`, { capability });
    }
    slices = authoringSlices(selected.slices);
  }
  const inspected = preflightProfileRecipe(source, slices, profileId);
  if (!inspected.ok) {
    refuse("recipe_unapplicable", "Host bundle does not match the approved profile slices.",
      profileRecipeFailureNext(hostBundle), { recipeFailure: inspected });
  }
  const profile = inspected.profile;
  const applied = applyPatchProfile(source, profile);
  if (!applied.ok || profile.sourceSha256 !== diskSha ||
    sha256Bytes(Buffer.from(applied.source, "utf8")) !== profile.transformedSourceSha256) {
    invalid("Reviewed profile failed source/transformed hash validation.");
  }

  let envelope: WriteEnvelopeReceipt | undefined;
  if (lineage) {
    const root = resolve(lineage.root);
    const baseline = await loadWriteEnvelopeBaseline(root);
    const pinSha = baseline.pinSha;
    const candidate = envelopeWindowsFromReviewed(source, profile, diskSha);
    const admission = admitWriteEnvelope({
      pinSha,
      golden: baseline.golden,
      goldenInvalid: baseline.goldenInvalid,
      candidate,
      sliceReview,
    });
    envelope = envelopeReceipt(admission, sliceReview);
    if (!admission.ok) {
      if (admission.refusal === "missing_golden") {
        const pinSource = retainedGenerationSourcePath(root, pinSha!);
        refuse(
          "missing_golden",
          `Pinned generation ${pinSha} has no envelope-windows.json golden. Re-observe that generation before write.`,
          profileWriteMissingGoldenNext(pinSource),
          { pinSha, candidateSha: diskSha },
        );
      }
      if (admission.refusal === "envelope_unmeasurable") {
        refuse(
          "envelope_unmeasurable",
          "Candidate recipe has no measurable envelope; adapt the recipe before writing.",
          profileRecipeFailureNext(hostBundle),
          { pinSha, candidateSha: diskSha },
        );
      }
      const groups = admission.insertionGroups.map((group) => group.id).join(", ") || "none";
      refuse(
        "envelope_drift",
        `Envelope windows drifted at ${admission.requiredIds.join(",") || "(none)"} ` +
          `(insertion groups: ${groups}). --slice-review must list exactly those ids; one review note per group.`,
        profileWriteDriftNext(diskSha, admission.requiredIds, capability, selected?.sha),
        {
          pinSha,
          candidateSha: diskSha,
          requiredIds: admission.requiredIds,
          informationalIds: admission.informational.map((row) => row.id),
          insertionGroups: admission.insertionGroups,
          sliceReview,
        },
      );
    }
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
  // All new Linux publishers share the same permanent gate. Under that gate a
  // capability writer rechecks its baseline before rename; default writers keep
  // their explicit last-rename-wins behavior. Older/uncooperative writers must
  // be stopped for maintenance and do not gain transactional guarantees here.
  const gate = process.platform === "linux"
    ? await acquireAdvisoryGate(join(dirname(destDir), "state", "profile-publication.gate"), 2000) : undefined;
  if (gate === null) invalid("Another profile publisher is busy; no profile was published.");
  try {
    if (!sameSource(sourceInfo, await stat(hostBundle))) invalid("Host bundle changed during authoring.");
    await checkDestination(profilePath, sourceInfo);
    if (selected) recheckCapabilityBaseline(selected);
    await rename(stagingPath, profilePath);
  } finally {
    await gate?.release();
  }
  // No post-commit read: another successful writer may already have published next.
  return {
    profilePath,
    profile,
    sourceSha256: profile.sourceSha256,
    transformedSourceSha256: profile.transformedSourceSha256,
    diskSha,
    ...(allowUnretained ? { unretained_source: true as const } : {}),
    ...(envelope ? { envelope } : {}),
    ...(selected ? { capabilityUpgrade: selected.receipt } : {}),
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
