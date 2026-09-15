/** Parallel 19-slice envelope window observation.
 * Measure/encode may persist from retain when a 19-slice reviewed recipe exists
 * (passed or profiles/reviewed.json). The recipe pin SHA need not match the new generation.
 * Status loads/diffs only. Never invents without reviewed, never expands driftedSlices,
 * never applies, never writes/adopts reviewed.
 * YELLOW: four-window patchImpact green is not this file.
 */
import { join } from "node:path";
import { countOccurrences, sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  OPTIONAL_SLICE_IDS,
  REQUIRED_SLICE_IDS,
  type PatchProfile,
  type SliceId,
  type SlicePatch,
} from "../../host/profile.ts";
import { boundedText, count, isRecord, observeJson, type ObservationState } from "../../io/observation.node.ts";
import { retainedGenerationDir } from "../../io/paths.ts";
import type { HostBundlesObservation } from "../../io/provenance.node.ts";

/** 19 reviewed envelope slices. Parallel to the 4-name CONTRACT_SLICE_NAMES lock. */
export const ENVELOPE_SLICE_IDS = [...REQUIRED_SLICE_IDS, ...OPTIONAL_SLICE_IDS] as const satisfies readonly SliceId[];
export const ENVELOPE_SLICE_COUNT = ENVELOPE_SLICE_IDS.length;
export const ENVELOPE_WINDOWS_FILE = "envelope-windows.json";

const SHA = /^[a-f0-9]{64}$/;
const ENVELOPE_SLICE_SET = new Set<string>(ENVELOPE_SLICE_IDS);

export type EnvelopeByteRange = { startByte: number; endByte: number };

export type EnvelopeWindowSlice = {
  id: SliceId;
  count: { start: number; end: number };
  find: { inWindow: number; global: number };
  windowSha: string;
  byteRange: EnvelopeByteRange;
};

export type EnvelopeWindows = {
  sourceSha: string;
  profileId: string;
  slices: EnvelopeWindowSlice[];
};

export type EnvelopeDriftReason = "windowSha" | "byteRange" | "count" | "find";

export type EnvelopeDriftedSlice = {
  id: SliceId;
  reasons: EnvelopeDriftReason[];
  previousWindowSha: string | null;
  currentWindowSha: string | null;
  previousByteRange: EnvelopeByteRange | null;
  currentByteRange: EnvelopeByteRange | null;
  byteDelta: number | null;
  insertionGroup: string | null;
};

export type EnvelopeInsertionGroup = {
  id: string;
  sliceIds: SliceId[];
  kind: "overlapping-byte-range";
};

export type EnvelopeDrift = {
  evidenceKind: "envelope-windows";
  previousSourceSha: string;
  currentSourceSha: string;
  previousProfileId: string;
  currentProfileId: string;
  compared: number;
  unchangedCount: number;
  drifted: EnvelopeDriftedSlice[];
  missing: SliceId[];
  appeared: SliceId[];
  insertionGroups: EnvelopeInsertionGroup[];
};

export type EnvelopeDriftObservation = {
  evidenceKind: "envelope-windows";
  state: ObservationState | "partial";
  previousSourceSha: string | null;
  currentSourceSha: string | null;
  profileId: string | null;
  compared: number;
  unchangedCount: number;
  drifted: EnvelopeDriftedSlice[];
  missing: SliceId[];
  appeared: SliceId[];
  insertionGroups: EnvelopeInsertionGroup[];
};

function isSliceId(value: unknown): value is SliceId {
  return typeof value === "string" && ENVELOPE_SLICE_SET.has(value);
}

function utf8Offset(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}

function parseByteRange(value: unknown): EnvelopeByteRange | null {
  if (!isRecord(value) || !count(value.startByte) || !count(value.endByte) || value.endByte < value.startByte) return null;
  return { startByte: value.startByte, endByte: value.endByte };
}

function parseWindowSlice(value: unknown): EnvelopeWindowSlice | null {
  if (!isRecord(value) || !isSliceId(value.id) || !SHA.test(String(value.windowSha))) return null;
  if (!isRecord(value.count) || !count(value.count.start) || !count(value.count.end)) return null;
  if (!isRecord(value.find) || !count(value.find.inWindow) || !count(value.find.global)) return null;
  const byteRange = parseByteRange(value.byteRange);
  if (!byteRange) return null;
  return {
    id: value.id,
    count: { start: value.count.start, end: value.count.end },
    find: { inWindow: value.find.inWindow, global: value.find.global },
    windowSha: value.windowSha as string,
    byteRange,
  };
}

/** True for a complete 19-slice reviewed envelope recipe. SHA pin is not required. 2-slice recipes do not qualify. */
export function envelopeProfileShape(profile: PatchProfile | undefined): profile is PatchProfile {
  if (!profile || !Array.isArray(profile.slices) || profile.slices.length !== ENVELOPE_SLICE_COUNT) {
    return false;
  }
  const ids = new Set<string>();
  for (const slice of profile.slices) {
    if (!slice || !isSliceId(slice.id) || ids.has(slice.id)) return false;
    if (typeof slice.startAnchor !== "string" || slice.startAnchor.length === 0) return false;
    if (typeof slice.endAnchor !== "string" || slice.endAnchor.length === 0) return false;
    if (typeof slice.find !== "string" || slice.find.length === 0) return false;
    ids.add(slice.id);
  }
  return ids.size === ENVELOPE_SLICE_COUNT && ENVELOPE_SLICE_IDS.every((id) => ids.has(id));
}

/** True only for a 19-slice reviewed envelope pinned to this sourceSha. Write-gate / AH-85. */
export function reviewedEnvelopeProfile(profile: PatchProfile | undefined, sourceSha: string): profile is PatchProfile {
  return envelopeProfileShape(profile) && profile.sourceSha256 === sourceSha;
}

/** Same encode as `envelope-windows.cjs`: pretty JSON + trailing newline. */
export function encodeEnvelopeWindows(windows: EnvelopeWindows): string {
  return `${JSON.stringify(windows, null, 2)}\n`;
}

/** Measure 19 independent windows from a reviewed recipe. Pin SHA need not match this source. Returns null instead of inventing. */
export function envelopeWindowsFromRecipe(
  source: string,
  profile: PatchProfile | undefined,
): EnvelopeWindows | null {
  if (!envelopeProfileShape(profile)) return null;
  try {
    return measureEnvelopeWindows(source, profile);
  } catch {
    return null;
  }
}

/** Measure 19 independent windows from a reviewed profile pinned to this sourceSha. Returns null instead of inventing. */
export function envelopeWindowsFromReviewed(
  source: string,
  profile: PatchProfile | undefined,
  sourceSha: string,
): EnvelopeWindows | null {
  if (!reviewedEnvelopeProfile(profile, sourceSha)) return null;
  return envelopeWindowsFromRecipe(source, profile);
}

/** Loader for a retained generation / archive `envelope-windows.json`. Never invents rows. */
export function parseEnvelopeWindows(value: unknown): EnvelopeWindows {
  if (!isRecord(value) || typeof value.sourceSha !== "string" || !SHA.test(value.sourceSha) ||
    !boundedText(value.profileId, 128) || !Array.isArray(value.slices) || value.slices.length !== ENVELOPE_SLICE_COUNT) {
    throw new Error("invalid envelope-windows");
  }
  const ids = new Set<string>();
  const slices: EnvelopeWindowSlice[] = [];
  for (const row of value.slices) {
    const parsed = parseWindowSlice(row);
    if (!parsed || ids.has(parsed.id)) throw new Error("invalid envelope-windows");
    ids.add(parsed.id);
    slices.push(parsed);
  }
  if (ids.size !== ENVELOPE_SLICE_COUNT || ENVELOPE_SLICE_IDS.some((id) => !ids.has(id))) {
    throw new Error("invalid envelope-windows");
  }
  return { sourceSha: value.sourceSha, profileId: value.profileId as string, slices };
}

function measureOne(source: string, slice: SlicePatch): EnvelopeWindowSlice {
  for (const field of ["id", "startAnchor", "endAnchor", "find"] as const) {
    if (typeof slice[field] !== "string" || slice[field].length === 0) {
      throw new Error(`envelope slice missing ${field}`);
    }
  }
  const startCount = countOccurrences(source, slice.startAnchor);
  const endCount = countOccurrences(source, slice.endAnchor);
  const findGlobal = countOccurrences(source, slice.find);
  const start = source.indexOf(slice.startAnchor);
  const end = start >= 0 ? source.indexOf(slice.endAnchor, start) : -1;
  if (start < 0 || end < start) {
    throw new Error(`envelope slice ${slice.id}: no endAnchor at/after first startAnchor`);
  }
  const window = source.slice(start, end);
  return {
    id: slice.id,
    count: { start: startCount, end: endCount },
    find: { inWindow: countOccurrences(window, slice.find), global: findGlobal },
    windowSha: sha256Text(window),
    byteRange: { startByte: utf8Offset(source, start), endByte: utf8Offset(source, end) },
  };
}

/**
 * Independent `[start, end)` windows on unpatched source.
 * Matches `applyPatchProfile` / propose `sourceRange` (endAnchor excluded),
 * not sequential transform, not `extractContractSlices` first-hit.
 */
export function measureEnvelopeWindows(source: string, profile: PatchProfile): EnvelopeWindows {
  if (profile.slices.length !== ENVELOPE_SLICE_COUNT || !SHA.test(sha256Text(source))) {
    throw new Error("envelope measure requires 19 unique reviewed slices and UTF-8 source");
  }
  const ids = new Set<string>();
  const slices = profile.slices.map((slice) => {
    if (ids.has(slice.id)) throw new Error(`duplicate envelope slice id ${slice.id}`);
    ids.add(slice.id);
    return measureOne(source, slice);
  });
  if (ids.size !== ENVELOPE_SLICE_COUNT || ENVELOPE_SLICE_IDS.some((id) => !ids.has(id))) {
    throw new Error("envelope measure requires the full 19-slice envelope");
  }
  return {
    sourceSha: sha256Text(source),
    profileId: profile.profileId,
    slices,
  };
}

function rangeSize(range: EnvelopeByteRange | null): number | null {
  return range ? range.endByte - range.startByte : null;
}

function rangesOverlap(a: EnvelopeByteRange | null, b: EnvelopeByteRange | null): boolean {
  return Boolean(a && b && a.startByte < b.endByte && b.startByte < a.endByte);
}

type GroupableWindow = {
  id: SliceId;
  currentByteRange: EnvelopeByteRange | null;
  previousByteRange: EnvelopeByteRange | null;
  insertionGroup: string | null;
};

function driftedOverlap(a: GroupableWindow, b: GroupableWindow): boolean {
  return rangesOverlap(a.currentByteRange, b.currentByteRange)
    || rangesOverlap(a.previousByteRange, b.previousByteRange)
    || rangesOverlap(a.currentByteRange ?? a.previousByteRange, b.currentByteRange ?? b.previousByteRange);
}

function insertionGroupsOf(drifted: GroupableWindow[]): EnvelopeInsertionGroup[] {
  const parent = new Map<SliceId, SliceId>();
  const find = (id: SliceId): SliceId => {
    const next = parent.get(id) ?? id;
    if (next !== id) {
      const root = find(next);
      parent.set(id, root);
      return root;
    }
    return id;
  };
  const union = (a: SliceId, b: SliceId) => {
    const pa = find(a);
    const pb = find(b);
    if (pa !== pb) parent.set(pa, pb);
  };
  for (const row of drifted) parent.set(row.id, row.id);
  for (let i = 0; i < drifted.length; i += 1) {
    for (let j = i + 1; j < drifted.length; j += 1) {
      if (driftedOverlap(drifted[i]!, drifted[j]!)) union(drifted[i]!.id, drifted[j]!.id);
    }
  }
  const buckets = new Map<SliceId, SliceId[]>();
  for (const row of drifted) {
    const root = find(row.id);
    const bucket = buckets.get(root) ?? [];
    bucket.push(row.id);
    buckets.set(root, bucket);
  }
  const groups: EnvelopeInsertionGroup[] = [];
  for (const sliceIds of buckets.values()) {
    if (sliceIds.length < 2) continue;
    const sorted = [...sliceIds].sort();
    groups.push({ id: sorted.join("+"), sliceIds: sorted, kind: "overlapping-byte-range" });
  }
  groups.sort((a, b) => a.id.localeCompare(b.id));
  const groupById = new Map<SliceId, string>();
  for (const group of groups) {
    for (const id of group.sliceIds) groupById.set(id, group.id);
  }
  for (const row of drifted) row.insertionGroup = groupById.get(row.id) ?? null;
  return groups;
}

function compareSlice(previous: EnvelopeWindowSlice | undefined, current: EnvelopeWindowSlice | undefined): EnvelopeDriftReason[] {
  if (!previous || !current) return [];
  const reasons: EnvelopeDriftReason[] = [];
  if (previous.windowSha !== current.windowSha) reasons.push("windowSha");
  if (previous.byteRange.startByte !== current.byteRange.startByte || previous.byteRange.endByte !== current.byteRange.endByte) {
    reasons.push("byteRange");
  }
  if (previous.count.start !== current.count.start || previous.count.end !== current.count.end) reasons.push("count");
  if (previous.find.inWindow !== current.find.inWindow || previous.find.global !== current.find.global) reasons.push("find");
  return reasons;
}

/** Golden diff. Does not write, adopt, or apply. */
export function diffEnvelopeWindows(previous: EnvelopeWindows, current: EnvelopeWindows): EnvelopeDrift {
  const prevById = new Map(previous.slices.map((row) => [row.id, row]));
  const curById = new Map(current.slices.map((row) => [row.id, row]));
  const missing: SliceId[] = [];
  const appeared: SliceId[] = [];
  const drifted: EnvelopeDriftedSlice[] = [];
  let unchangedCount = 0;
  const ids = new Set<SliceId>([...prevById.keys(), ...curById.keys()]);
  for (const id of ENVELOPE_SLICE_IDS) {
    if (!ids.has(id)) continue;
    const prev = prevById.get(id);
    const cur = curById.get(id);
    if (prev && !cur) {
      missing.push(id);
      continue;
    }
    if (!prev && cur) {
      appeared.push(id);
      continue;
    }
    const reasons = compareSlice(prev, cur);
    if (reasons.length === 0) {
      unchangedCount += 1;
      continue;
    }
    drifted.push({
      id,
      reasons,
      previousWindowSha: prev?.windowSha ?? null,
      currentWindowSha: cur?.windowSha ?? null,
      previousByteRange: prev?.byteRange ?? null,
      currentByteRange: cur?.byteRange ?? null,
      byteDelta: rangeSize(cur?.byteRange ?? null) !== null && rangeSize(prev?.byteRange ?? null) !== null
        ? rangeSize(cur!.byteRange)! - rangeSize(prev!.byteRange)!
        : null,
      insertionGroup: null,
    });
  }
  const insertionGroups = insertionGroupsOf(drifted);
  return {
    evidenceKind: "envelope-windows",
    previousSourceSha: previous.sourceSha,
    currentSourceSha: current.sourceSha,
    previousProfileId: previous.profileId,
    currentProfileId: current.profileId,
    compared: previous.slices.length,
    unchangedCount,
    drifted,
    missing,
    appeared,
    insertionGroups,
  };
}

export function emptyEnvelopeDriftObservation(state: EnvelopeDriftObservation["state"] = "missing"): EnvelopeDriftObservation {
  return {
    evidenceKind: "envelope-windows",
    state,
    previousSourceSha: null,
    currentSourceSha: null,
    profileId: null,
    compared: 0,
    unchangedCount: 0,
    drifted: [],
    missing: [],
    appeared: [],
    insertionGroups: [],
  };
}

export function observationFromDrift(drift: EnvelopeDrift, state: EnvelopeDriftObservation["state"] = "present"): EnvelopeDriftObservation {
  return {
    evidenceKind: "envelope-windows",
    state,
    previousSourceSha: drift.previousSourceSha,
    currentSourceSha: drift.currentSourceSha,
    profileId: drift.currentProfileId,
    compared: drift.compared,
    unchangedCount: drift.unchangedCount,
    drifted: drift.drifted,
    missing: drift.missing,
    appeared: drift.appeared,
    insertionGroups: drift.insertionGroups,
  };
}

export async function observeEnvelopeWindowsFile(path: string): Promise<
  { state: "present"; value: EnvelopeWindows } | { state: Exclude<ObservationState, "present"> }
> {
  return await observeJson(path, parseEnvelopeWindows);
}

export function generationEnvelopePath(root: string, sha: string): string {
  return join(retainedGenerationDir(root, sha), ENVELOPE_WINDOWS_FILE);
}

/**
 * Read-only golden compare for retained host-bundle generations.
 * Status must not re-measure 29MB source or write envelope-windows.json.
 */
export async function observeRetainedEnvelopeDrift(input: {
  root: string;
  sha?: string;
  bundles?: HostBundlesObservation;
  envelopeWindows?: { previous: EnvelopeWindows; current: EnvelopeWindows };
}): Promise<EnvelopeDriftObservation> {
  if (input.envelopeWindows) {
    return observationFromDrift(diffEnvelopeWindows(input.envelopeWindows.previous, input.envelopeWindows.current));
  }
  const bundles = input.bundles ?? await (await import("../../io/provenance.node.ts")).observeHostBundles(input.root);
  const currentSha = input.sha ?? bundles.head;
  if (!currentSha) return emptyEnvelopeDriftObservation("missing");
  const currentRow = bundles.generations.find((row) => row.sourceSha === currentSha);
  const previousSha = currentRow?.diff?.previousSha ?? null;
  const currentRead = await observeEnvelopeWindowsFile(generationEnvelopePath(input.root, currentSha));
  if (currentRead.state === "invalid" || currentRead.state === "unavailable") {
    return { ...emptyEnvelopeDriftObservation(currentRead.state), currentSourceSha: currentSha, previousSourceSha: previousSha };
  }
  if (!previousSha) {
    if (currentRead.state === "missing") return { ...emptyEnvelopeDriftObservation("missing"), currentSourceSha: currentSha };
    return {
      ...emptyEnvelopeDriftObservation("partial"),
      currentSourceSha: currentSha,
      profileId: currentRead.state === "present" ? currentRead.value.profileId : null,
    };
  }
  const previousRead = await observeEnvelopeWindowsFile(generationEnvelopePath(input.root, previousSha));
  if (previousRead.state === "invalid" || previousRead.state === "unavailable") {
    return { ...emptyEnvelopeDriftObservation(previousRead.state), currentSourceSha: currentSha, previousSourceSha: previousSha };
  }
  if (currentRead.state !== "present" && previousRead.state !== "present") {
    return { ...emptyEnvelopeDriftObservation("missing"), currentSourceSha: currentSha, previousSourceSha: previousSha };
  }
  if (currentRead.state !== "present" || previousRead.state !== "present") {
    return {
      ...emptyEnvelopeDriftObservation("partial"),
      currentSourceSha: currentSha,
      previousSourceSha: previousSha,
      profileId: currentRead.state === "present" ? currentRead.value.profileId
        : previousRead.state === "present" ? previousRead.value.profileId : null,
    };
  }
  if (currentRead.value.sourceSha !== currentSha || previousRead.value.sourceSha !== previousSha) {
    return { ...emptyEnvelopeDriftObservation("invalid"), currentSourceSha: currentSha, previousSourceSha: previousSha };
  }
  return observationFromDrift(diffEnvelopeWindows(previousRead.value, currentRead.value));
}

/** Write-gate reject reasons. byteRange / find.global stay informational and must not poison the review list. */
export type WriteRejectReason = "windowSha" | "count" | "find.inWindow";
export type WriteInfoReason = "byteRange" | "find.global";

export type WriteEnvelopeDriftedSlice = {
  id: SliceId;
  rejectReasons: WriteRejectReason[];
  infoReasons: WriteInfoReason[];
  previousWindowSha: string | null;
  currentWindowSha: string | null;
  previousByteRange: EnvelopeByteRange | null;
  currentByteRange: EnvelopeByteRange | null;
  insertionGroup: string | null;
};

export type WriteEnvelopeClassification = {
  rejecting: WriteEnvelopeDriftedSlice[];
  informational: WriteEnvelopeDriftedSlice[];
  missing: SliceId[];
  appeared: SliceId[];
  insertionGroups: EnvelopeInsertionGroup[];
  requiredIds: SliceId[];
};

export type WriteEnvelopeAdmission = WriteEnvelopeClassification & (
  | { ok: true; bootstrap: boolean; baselineSourceSha: string | null }
  | {
    ok: false;
    bootstrap: false;
    refusal: "missing_golden" | "envelope_unmeasurable" | "envelope_drift";
    baselineSourceSha: string | null;
  }
);

function writeSliceReasons(previous: EnvelopeWindowSlice, current: EnvelopeWindowSlice): {
  rejectReasons: WriteRejectReason[];
  infoReasons: WriteInfoReason[];
} {
  const rejectReasons: WriteRejectReason[] = [];
  const infoReasons: WriteInfoReason[] = [];
  if (previous.windowSha !== current.windowSha) rejectReasons.push("windowSha");
  if (previous.count.start !== current.count.start || previous.count.end !== current.count.end) {
    rejectReasons.push("count");
  }
  if (previous.find.inWindow !== current.find.inWindow) rejectReasons.push("find.inWindow");
  if (
    previous.byteRange.startByte !== current.byteRange.startByte
    || previous.byteRange.endByte !== current.byteRange.endByte
  ) {
    infoReasons.push("byteRange");
  }
  if (previous.find.global !== current.find.global) infoReasons.push("find.global");
  return { rejectReasons, infoReasons };
}

function emptyWriteClassification(): WriteEnvelopeClassification {
  return { rejecting: [], informational: [], missing: [], appeared: [], insertionGroups: [], requiredIds: [] };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return set.size === left.length && right.every((id) => set.has(id));
}

/** Write-gate compare. Does not change observe/status envelopeDrift reasons. */
export function classifyWriteEnvelopeDrift(
  previous: EnvelopeWindows,
  current: EnvelopeWindows,
): WriteEnvelopeClassification {
  const prevById = new Map(previous.slices.map((row) => [row.id, row]));
  const curById = new Map(current.slices.map((row) => [row.id, row]));
  const missing: SliceId[] = [];
  const appeared: SliceId[] = [];
  const rejecting: WriteEnvelopeDriftedSlice[] = [];
  const informational: WriteEnvelopeDriftedSlice[] = [];
  for (const id of ENVELOPE_SLICE_IDS) {
    const prev = prevById.get(id);
    const cur = curById.get(id);
    if (prev && !cur) {
      missing.push(id);
      continue;
    }
    if (!prev && cur) {
      appeared.push(id);
      continue;
    }
    if (!prev || !cur) continue;
    const { rejectReasons, infoReasons } = writeSliceReasons(prev, cur);
    if (rejectReasons.length === 0 && infoReasons.length === 0) continue;
    const row: WriteEnvelopeDriftedSlice = {
      id,
      rejectReasons,
      infoReasons,
      previousWindowSha: prev.windowSha,
      currentWindowSha: cur.windowSha,
      previousByteRange: prev.byteRange,
      currentByteRange: cur.byteRange,
      insertionGroup: null,
    };
    if (rejectReasons.length > 0) rejecting.push(row);
    else informational.push(row);
  }
  const insertionGroups = insertionGroupsOf(rejecting);
  const requiredIds = [...new Set([...rejecting.map((row) => row.id), ...missing, ...appeared])];
  requiredIds.sort();
  return { rejecting, informational, missing, appeared, insertionGroups, requiredIds };
}

/** Pin golden is the current reviewed.json sourceSha256 generation, never retain HEAD / diff.previousSha. */
export function admitWriteEnvelope(input: {
  pinSha: string | null;
  golden: EnvelopeWindows | null;
  goldenInvalid?: boolean;
  candidate: EnvelopeWindows | null;
  sliceReview: readonly string[];
}): WriteEnvelopeAdmission {
  const empty = emptyWriteClassification();
  if (!input.pinSha) {
    return { ok: true, bootstrap: true, baselineSourceSha: null, ...empty };
  }
  if (input.goldenInvalid || !input.golden || input.golden.sourceSha !== input.pinSha) {
    return {
      ok: false,
      bootstrap: false,
      refusal: "missing_golden",
      baselineSourceSha: input.pinSha,
      ...empty,
    };
  }
  if (!input.candidate) {
    return {
      ok: false,
      bootstrap: false,
      refusal: "envelope_unmeasurable",
      baselineSourceSha: input.pinSha,
      ...empty,
    };
  }
  const classified = classifyWriteEnvelopeDrift(input.golden, input.candidate);
  const review = [...new Set(input.sliceReview)];
  if (classified.requiredIds.length === 0 && review.length === 0) {
    return { ok: true, bootstrap: false, baselineSourceSha: input.pinSha, ...classified };
  }
  const groupsCovered = classified.insertionGroups.every((group) => group.sliceIds.every((id) => review.includes(id)));
  if (sameIdSet(review, classified.requiredIds) && groupsCovered) {
    return { ok: true, bootstrap: false, baselineSourceSha: input.pinSha, ...classified };
  }
  return {
    ok: false,
    bootstrap: false,
    refusal: "envelope_drift",
    baselineSourceSha: input.pinSha,
    ...classified,
  };
}
