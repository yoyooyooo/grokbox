import { countOccurrences, sha256Text } from "@grokbox/runtime-kernel/hash";

export type SliceId = "create-session" | "agent-id" | "compact-register" | "activity-bridge" | "memory-purpose" | "episode-purpose";

export type SlicePatch = {
  id: SliceId;
  startAnchor: string;
  endAnchor: string;
  find: string;
  replacement: string;
};

export type PatchProfile = {
  profileId: string;
  sourceSha256: string;
  transformedSourceSha256: string;
  slices: readonly SlicePatch[];
};

export type TransformFailure = {
  ok: false;
  code:
    | "unknown-sha"
    | "anchor-missing"
    | "anchor-duplicate"
    | "find-missing"
    | "find-duplicate"
    | "transformed-mismatch"
    | "slice-not-unique";
  sliceId?: SliceId;
};

export type TransformSuccess = {
  ok: true;
  source: string;
  sourceSha256: string;
  transformedSha256: string;
};

export type TransformResult = TransformSuccess | TransformFailure;

export function applyPatchProfile(source: string, profile: PatchProfile): TransformResult {
  const sourceSha256 = sha256Text(source);
  if (sourceSha256 !== profile.sourceSha256) {
    return { ok: false, code: "unknown-sha" };
  }
  if (!approvedSliceSet(profile.slices)) {
    return { ok: false, code: "slice-not-unique" };
  }

  let next = source;
  for (const slice of profile.slices) {
    const startCount = countOccurrences(next, slice.startAnchor);
    const endCount = countOccurrences(next, slice.endAnchor);
    if (startCount === 0 || endCount === 0) {
      return { ok: false, code: "anchor-missing", sliceId: slice.id };
    }
    if (startCount !== 1 || endCount !== 1) {
      return { ok: false, code: "anchor-duplicate", sliceId: slice.id };
    }
    const start = next.indexOf(slice.startAnchor);
    const end = next.indexOf(slice.endAnchor, start);
    if (end < start) return { ok: false, code: "anchor-missing", sliceId: slice.id };
    const window = next.slice(start, end);
    const findCount = countOccurrences(window, slice.find);
    if (findCount === 0) return { ok: false, code: "find-missing", sliceId: slice.id };
    if (findCount !== 1) return { ok: false, code: "find-duplicate", sliceId: slice.id };
    next = next.slice(0, start) + window.replace(slice.find, slice.replacement) + next.slice(end);
  }

  const transformedSha256 = sha256Text(next);
  if (transformedSha256 !== profile.transformedSourceSha256) {
    return { ok: false, code: "transformed-mismatch" };
  }
  return { ok: true, source: next, sourceSha256, transformedSha256 };
}

export function profileFromSource(source: string, slices: readonly SlicePatch[], profileId = "synthetic"): PatchProfile {
  const applied = transformUnchecked(source, slices);
  if (!applied.ok) throw new Error(`synthetic profile failed: ${applied.code}`);
  return {
    profileId,
    sourceSha256: applied.sourceSha256,
    transformedSourceSha256: applied.transformedSha256,
    slices,
  };
}

export function transformUnchecked(source: string, slices: readonly SlicePatch[]): TransformResult {
  let next = source;
  for (const slice of slices) {
    const startCount = countOccurrences(next, slice.startAnchor);
    const endCount = countOccurrences(next, slice.endAnchor);
    if (startCount !== 1 || endCount !== 1) {
      return {
        ok: false,
        code: startCount === 0 || endCount === 0 ? "anchor-missing" : "anchor-duplicate",
        sliceId: slice.id,
      };
    }
    const start = next.indexOf(slice.startAnchor);
    const end = next.indexOf(slice.endAnchor, start);
    const window = next.slice(start, end);
    const findCount = countOccurrences(window, slice.find);
    if (findCount !== 1) {
      return { ok: false, code: findCount === 0 ? "find-missing" : "find-duplicate", sliceId: slice.id };
    }
    next = next.slice(0, start) + window.replace(slice.find, slice.replacement) + next.slice(end);
  }
  return {
    ok: true,
    source: next,
    sourceSha256: sha256Text(source),
    transformedSha256: sha256Text(next),
  };
}

export const ROUTE_SESSION_SYMBOL = "grokbox.box-runtime.route-session.v1";
export const HOST_COMPACT_SYMBOL = "grokbox.box-runtime.host-compact.v1";
export const HOST_ACTIVITY_SYMBOL = "grokbox.box-runtime.host-activity.v1";
export const HOST_AUX_SYMBOL = "grokbox.box-runtime.host-aux.v1";
export const PACKED_SESSION_SYMBOL = "grokbox.box-runtime.packed-session.v1";

const OPTIONAL_SLICES = new Set<string>(["compact-register", "activity-bridge", "memory-purpose", "episode-purpose"]);

export function approvedSliceSet(slices: readonly { id: string }[]): boolean {
  const ids = slices.map((slice) => slice.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) return false;
  if (!unique.has("create-session") || !unique.has("agent-id")) return false;
  for (const id of unique) {
    if (id !== "create-session" && id !== "agent-id" && !OPTIONAL_SLICES.has(id)) return false;
  }
  return unique.size >= 2 && unique.size <= 2 + OPTIONAL_SLICES.size;
}

export function extractContractSlices(source: string): Record<string, string> {
  const slices: Record<string, string> = {};
  const createStart = source.indexOf("function createSession(sessionOptions)");
  const createEnd = source.indexOf("function runTurn(host)", createStart);
  if (createStart >= 0 && createEnd > createStart) {
    slices["create-session"] = source.slice(createStart, createEnd);
  } else {
    const liveStart = source.indexOf("createSession(onRequestId, sessionOptions)");
    const liveEnd = source.indexOf("recordPostTurnLabeling", liveStart);
    if (liveStart >= 0 && liveEnd > liveStart) {
      slices["create-session"] = source.slice(liveStart, liveEnd);
    }
  }
  const optionsStart = source.indexOf("const mainSessionOptions = {");
  if (optionsStart >= 0) {
    const optionsEnd = source.indexOf("};", optionsStart);
    if (optionsEnd > optionsStart) slices["session-options"] = source.slice(optionsStart, optionsEnd + 2);
  }
  const agentNeedle = "agentId: host.getConversationId()";
  const invNeedle = "invocationId: inferenceRequestId";
  const agentIndex = source.indexOf(agentNeedle);
  const invIndex = source.indexOf(invNeedle);
  if (agentIndex >= 0 && invIndex >= 0) {
    const start = Math.min(agentIndex, invIndex);
    const end = Math.max(agentIndex + agentNeedle.length, invIndex + invNeedle.length);
    slices["agent-id"] = source.slice(start, end);
  } else if (agentIndex >= 0) {
    slices["agent-id"] = source.slice(agentIndex, agentIndex + agentNeedle.length);
  } else if (optionsStart >= 0) {
    slices["agent-id"] = slices["session-options"] ?? "";
  }
  const prompt = source.indexOf("function createCursorInferencePromptSession");
  if (prompt >= 0) {
    const promptEnd = source.indexOf("\nfunction ", prompt + 1);
    slices["prompt-session"] = source.slice(prompt, promptEnd === -1 ? prompt + 80 : promptEnd);
  }
  return slices;
}

export function sliceHashes(slices: Record<string, string>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, text] of Object.entries(slices)) hashes[name] = sha256Text(text);
  return hashes;
}
