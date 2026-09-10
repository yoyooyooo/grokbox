import { countOccurrences, sha256Text } from "@grokbox/runtime-kernel/hash";
import {
  applyPatchProfile,
  type PatchProfile,
  type SlicePatch,
  type TransformFailure,
  type TransformResult,
} from "../../host/profile.ts";

export const KNIFE_SLICE_IDS = ["create-session", "agent-id"] as const;
export type KnifeSliceId = (typeof KNIFE_SLICE_IDS)[number];

export type ByteRange = { startByte: number; endByte: number };

export type KnifePointRow = {
  sourceSha: string;
  profileSha: string;
  recipeDigest: string;
  sliceId: KnifeSliceId;
  evidenceKind: "slice-patch";
  sourceIntegrity: "ok" | "unknown-sha";
  startCount: number;
  endCount: number;
  findInWindowCount: number;
  findGlobalCount: number;
  endAfterStart: boolean;
  locationRange: ByteRange | null;
  sourceRange: ByteRange | null;
  passRange: { pass: number; startByte: number; endByte: number } | null;
  code: TransformFailure["code"] | "ok";
  runtimeChecked: boolean;
  semanticLabelState: "unknown" | "unique" | "missing" | "ambiguous";
};

export type KnifePointObservation = {
  sourceSha: string;
  profileSha: string;
  recipeDigest: string;
  apply: TransformResult;
  applyCode: TransformResult extends { ok: true } ? "ok" : TransformFailure["code"] | "ok";
  rows: [KnifePointRow, KnifePointRow];
  traceMismatch: boolean;
};

function utf8Offset(text: string, charIndex: number): number {
  return Buffer.byteLength(text.slice(0, charIndex), "utf8");
}

function uniqueRange(text: string, startAnchor: string, endAnchor: string): ByteRange | null {
  if (countOccurrences(text, startAnchor) !== 1 || countOccurrences(text, endAnchor) !== 1) return null;
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor, start);
  if (end < start) return null;
  return { startByte: utf8Offset(text, start), endByte: utf8Offset(text, end) };
}

function semanticState(startCount: number, endCount: number, findInWindowCount: number, endAfterStart: boolean): KnifePointRow["semanticLabelState"] {
  if (startCount === 0 || endCount === 0 || (startCount === 1 && endCount === 1 && !endAfterStart)) return "missing";
  if (startCount !== 1 || endCount !== 1 || findInWindowCount !== 1) return "ambiguous";
  return "unique";
}

function sliceCode(input: {
  sourceIntegrity: "ok" | "unknown-sha";
  startCount: number;
  endCount: number;
  endAfterStart: boolean;
  findInWindowCount: number;
}): TransformFailure["code"] | "ok" {
  if (input.sourceIntegrity === "unknown-sha") return "unknown-sha";
  if (input.startCount === 0 || input.endCount === 0 || (input.startCount === 1 && input.endCount === 1 && !input.endAfterStart)) {
    return "anchor-missing";
  }
  if (input.startCount !== 1 || input.endCount !== 1) return "anchor-duplicate";
  if (input.findInWindowCount === 0) return "find-missing";
  if (input.findInWindowCount !== 1) return "find-duplicate";
  return "ok";
}

function measureSlice(pass: string, slice: SlicePatch): {
  startCount: number;
  endCount: number;
  findGlobalCount: number;
  findInWindowCount: number;
  endAfterStart: boolean;
  range: ByteRange | null;
} {
  const startCount = countOccurrences(pass, slice.startAnchor);
  const endCount = countOccurrences(pass, slice.endAnchor);
  const findGlobalCount = countOccurrences(pass, slice.find);
  if (startCount !== 1 || endCount !== 1) {
    return { startCount, endCount, findGlobalCount, findInWindowCount: 0, endAfterStart: false, range: null };
  }
  const start = pass.indexOf(slice.startAnchor);
  const end = pass.indexOf(slice.endAnchor, start);
  const endAfterStart = end >= start;
  if (!endAfterStart) {
    return { startCount, endCount, findGlobalCount, findInWindowCount: 0, endAfterStart: false, range: null };
  }
  const window = pass.slice(start, end);
  return {
    startCount,
    endCount,
    findGlobalCount,
    findInWindowCount: countOccurrences(window, slice.find),
    endAfterStart: true,
    range: { startByte: utf8Offset(pass, start), endByte: utf8Offset(pass, end) },
  };
}

function applyOne(pass: string, slice: SlicePatch): string | null {
  const measured = measureSlice(pass, slice);
  if (sliceCode({ sourceIntegrity: "ok", ...measured }) !== "ok" || measured.range == null) return null;
  const start = pass.indexOf(slice.startAnchor);
  const end = pass.indexOf(slice.endAnchor, start);
  const window = pass.slice(start, end);
  return pass.slice(0, start) + window.replace(slice.find, slice.replacement) + pass.slice(end);
}

export function profileDigest(profile: PatchProfile): { profileSha: string; recipeDigest: string } {
  return {
    profileSha: sha256Text(JSON.stringify(profile)),
    recipeDigest: sha256Text(JSON.stringify(profile.slices)),
  };
}

/** Count-loud knife-point trace. Never first-hit; always two slice rows. Must match applyPatchProfile. */
export function observeKnifePoints(source: string, profile: PatchProfile): KnifePointObservation {
  const sourceSha = sha256Text(source);
  const { profileSha, recipeDigest } = profileDigest(profile);
  const apply = applyPatchProfile(source, profile);
  const sourceIntegrity: "ok" | "unknown-sha" = sourceSha === profile.sourceSha256 ? "ok" : "unknown-sha";
  const measured = new Map<KnifeSliceId, ReturnType<typeof measureSlice> & { pass: number }>();
  let pass = source;
  let passIndex = 0;
  if (sourceIntegrity === "ok") {
    let halted = false;
    for (const slice of profile.slices) {
      const stats = measureSlice(pass, slice);
      if (slice.id === "create-session" || slice.id === "agent-id") {
        measured.set(slice.id, { ...stats, pass: passIndex });
      }
      if (halted) continue;
      const next = applyOne(pass, slice);
      if (next == null) {
        halted = true;
        continue;
      }
      pass = next;
      passIndex += 1;
    }
  } else {
    for (const slice of profile.slices) {
      if (slice.id === "create-session" || slice.id === "agent-id") {
        measured.set(slice.id, { ...measureSlice(source, slice), pass: 0 });
      }
    }
  }

  const rows = KNIFE_SLICE_IDS.map((sliceId) => {
    const slice = profile.slices.find((item) => item.id === sliceId);
    const stats = measured.get(sliceId) ?? {
      startCount: 0,
      endCount: 0,
      findGlobalCount: 0,
      findInWindowCount: 0,
      endAfterStart: false,
      range: null,
      pass: 0,
    };
    const code = slice
      ? sliceCode({ sourceIntegrity, ...stats })
      : sourceIntegrity === "unknown-sha" ? "unknown-sha" : "slice-not-unique";
    const row: KnifePointRow = {
      sourceSha,
      profileSha,
      recipeDigest,
      sliceId,
      evidenceKind: "slice-patch",
      sourceIntegrity,
      startCount: stats.startCount,
      endCount: stats.endCount,
      findInWindowCount: stats.findInWindowCount,
      findGlobalCount: stats.findGlobalCount,
      endAfterStart: stats.endAfterStart,
      locationRange: stats.startCount === 1 && stats.endCount === 1 && stats.endAfterStart ? stats.range : null,
      sourceRange: slice ? uniqueRange(source, slice.startAnchor, slice.endAnchor) : null,
      passRange: stats.range && stats.startCount === 1 && stats.endCount === 1 && stats.endAfterStart
        ? { pass: stats.pass, startByte: stats.range.startByte, endByte: stats.range.endByte }
        : null,
      code,
      runtimeChecked: true,
      semanticLabelState: semanticState(stats.startCount, stats.endCount, stats.findInWindowCount, stats.endAfterStart),
    };
    return row;
  }) as [KnifePointRow, KnifePointRow];

  const applyCode = apply.ok ? "ok" : apply.code;
  const tracedFail = rows.find((row) => row.code !== "ok");
  let predicted: TransformFailure["code"] | "ok" = "ok";
  if (sourceIntegrity === "unknown-sha") predicted = "unknown-sha";
  else if (tracedFail) predicted = tracedFail.code;
  else if (!apply.ok && apply.code === "transformed-mismatch") predicted = "transformed-mismatch";
  else if (apply.ok) predicted = "ok";
  else predicted = apply.code;

  if (predicted === "ok" && !apply.ok && apply.code === "transformed-mismatch") predicted = "transformed-mismatch";
  if (predicted === "ok") {
    const transformed = sha256Text(pass);
    if (sourceIntegrity === "ok" && transformed !== profile.transformedSourceSha256) predicted = "transformed-mismatch";
  }

  const traceMismatch = predicted !== applyCode
    || (apply.ok === false && apply.sliceId !== undefined && rows.find((row) => row.sliceId === apply.sliceId)?.code !== apply.code)
    || (apply.ok && rows.some((row) => row.code !== "ok"));

  return { sourceSha, profileSha, recipeDigest, apply, applyCode, rows, traceMismatch };
}

export function firstHitIndex(source: string, needle: string): number {
  return source.indexOf(needle);
}
