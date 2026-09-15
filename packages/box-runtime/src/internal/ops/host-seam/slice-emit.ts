import { countOccurrences, sha256Text } from "@grokbox/runtime-kernel/hash";
import { LIVE_SLICE_PATCHES } from "../../host/live-slices.ts";
import {
  applyPatchProfile,
  profileFromSource,
  ROUTE_SESSION_SYMBOL,
  type PatchProfile,
  type SlicePatch,
  type TransformSuccess,
} from "../../host/profile.ts";
import type { ShapeCandidate } from "./shape-worker.ts";

export const SLICE_EMIT_REVISION = "hso-4.slice-emit.v1";

export type SliceEmitOk = {
  status: "ok";
  slices: [SlicePatch, SlicePatch];
  profile: PatchProfile;
  replay: TransformSuccess;
  writes: 0;
  hostSignals: 0;
  limitations: string[];
};

export type SliceEmitFail = {
  status:
    | "unsupported-binding-shape"
    | "ambiguous-site"
    | "already-patched-or-contract-changed"
    | "conflict"
    | "replay-failed";
  code: SliceEmitFail["status"];
  limitations: string[];
  slices: SlicePatch[];
  writes: 0;
  hostSignals: 0;
};

export type SliceEmitResult = SliceEmitOk | SliceEmitFail;

const IDENT = /^[A-Za-z_$][\w$]*$/;

function fail(status: SliceEmitFail["status"], limitations: string[], slices: SlicePatch[] = []): SliceEmitFail {
  return { status, code: status, limitations, slices, writes: 0, hostSignals: 0 };
}

function utf8Window(source: string, startByte: number, endByte: number): string | undefined {
  const bytes = Buffer.from(source, "utf8");
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte < startByte || endByte > bytes.length) {
    return undefined;
  }
  const text = bytes.subarray(startByte, endByte).toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== endByte - startByte) return undefined;
  return text;
}

function uniqueSnippet(source: string, snippet: string): boolean {
  return snippet.length > 0 && countOccurrences(source, snippet) === 1;
}

function digestPatch(patch: SlicePatch): string {
  return sha256Text(JSON.stringify({
    id: patch.id,
    startAnchor: patch.startAnchor,
    endAnchor: patch.endAnchor,
    find: patch.find,
    replacement: patch.replacement,
  }));
}

/** Same span + find with different replacement must not first-wins merge. */
export function refuseConflictingVariants(patches: readonly SlicePatch[]): SlicePatch[] | { conflict: true; limitations: string[] } {
  const byKey = new Map<string, SlicePatch>();
  for (const patch of patches) {
    const key = `${patch.id}\0${patch.startAnchor}\0${patch.endAnchor}\0${patch.find}`;
    const prior = byKey.get(key);
    if (prior && digestPatch(prior) !== digestPatch(patch)) {
      return { conflict: true, limitations: ["conflicting-variant", "no_first_wins"] };
    }
    byKey.set(key, patch);
  }
  return [...byKey.values()];
}

function wrapFactoryReturn(find: string, p0: string, p1: string): string | undefined {
  const match = find.match(/^(\s*)return (createCursorInferencePromptSession\([^;]+?\));\r?\n$/);
  if (!match) return undefined;
  const indent = match[1]!;
  const call = match[2]!;
  const live = LIVE_SLICE_PATCHES.find((slice) => slice.id === "create-session");
  if (live && p0 === "onRequestId" && p1 === "sessionOptions" && find === live.find) {
    return live.replacement;
  }
  const nl = find.endsWith("\r\n") ? "\r\n" : "\n";
  return `${indent}const __grokbox_original = ${call};${nl}${indent}const __grokbox_hook = globalThis[Symbol.for("${ROUTE_SESSION_SYMBOL}")];${nl}${indent}if (typeof __grokbox_hook === "function") {${nl}${indent}  const __grokbox_session = __grokbox_hook({ originalSession: __grokbox_original, sessionOptions: ${p1}, agentId: ${p1}?.agentId, onRequestId: ${p0} });${nl}${indent}  if (__grokbox_session !== undefined) return __grokbox_session;${nl}${indent}}${nl}${indent}return __grokbox_original;${nl}`;
}

function emitCreate(source: string, create: ShapeCandidate): SlicePatch | SliceEmitFail {
  if (create.sliceId !== "create-session") {
    return fail("unsupported-binding-shape", ["wrong_role"]);
  }
  if (create.limitations.includes("ambiguous-site")) {
    return fail("ambiguous-site", ["ambiguous-site"]);
  }
  const params = create.params;
  if (!params || params.length !== 2 || !IDENT.test(params[0]!) || !IDENT.test(params[1]!)) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "params"]);
  }
  const window = utf8Window(source, create.startByte, create.endByte);
  if (!window) return fail("unsupported-binding-shape", ["utf8_window"]);
  if (window.includes("__grokbox_original") || window.includes("Symbol.for(\"" + ROUTE_SESSION_SYMBOL)) {
    return fail("already-patched-or-contract-changed", ["already-patched-or-contract-changed"]);
  }
  if (/^\s*async\b/.test(window) || window.includes("*createSession") || window.includes("...")) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "async_or_rest"]);
  }
  const head = `createSession(${params[0]}, ${params[1]}) {`;
  if (!window.startsWith("createSession") && !window.includes(head)) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "signature"]);
  }
  const startAnchor = window.includes(head) ? head : window.slice(0, window.indexOf("{") + 1);
  if (!uniqueSnippet(source, startAnchor)) {
    return fail("unsupported-binding-shape", ["start_anchor_not_unique"]);
  }
  const label = "recordPostTurnLabeling";
  if (countOccurrences(source, label) !== 1) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "labeling_sibling"]);
  }
  const startAt = source.indexOf(startAnchor);
  const labelAt = source.indexOf(label, startAt);
  if (labelAt < startAt) return fail("unsupported-binding-shape", ["labeling_order"]);
  const endAnchor = source.slice(source.lastIndexOf("\n", labelAt) + 1, source.indexOf("{", labelAt) + 1);
  if (!uniqueSnippet(source, endAnchor) || !endAnchor.includes(label)) {
    const liveEnd = LIVE_SLICE_PATCHES.find((slice) => slice.id === "create-session")?.endAnchor;
    if (!liveEnd || !uniqueSnippet(source, liveEnd)) {
      return fail("unsupported-binding-shape", ["end_anchor_not_unique"]);
    }
  }
  const resolvedEnd = uniqueSnippet(source, endAnchor) && endAnchor.includes(label)
    ? endAnchor
    : LIVE_SLICE_PATCHES.find((slice) => slice.id === "create-session")!.endAnchor;
  const factory = window.match(/return createCursorInferencePromptSession\([^;]+?\);\r?\n/);
  if (!factory) return fail("unsupported-binding-shape", ["unsupported-binding-shape", "factory_return"]);
  const find = factory[0]!;
  if (countOccurrences(window, find) !== 1) {
    return fail("unsupported-binding-shape", ["find-duplicate"]);
  }
  const replacement = wrapFactoryReturn(find, params[0]!, params[1]!);
  if (!replacement) return fail("unsupported-binding-shape", ["unsupported-binding-shape", "wrap"]);
  return {
    id: "create-session",
    startAnchor,
    endAnchor: resolvedEnd,
    find,
    replacement,
  };
}

function emitAgent(source: string, agent: ShapeCandidate, turnName: string): SlicePatch | SliceEmitFail {
  if (agent.sliceId !== "agent-id") return fail("unsupported-binding-shape", ["wrong_role"]);
  if (agent.limitations.includes("ambiguous-site")) return fail("ambiguous-site", ["ambiguous-site"]);
  const binding = agent.binding;
  if (!binding || !IDENT.test(binding.optionsName) || !IDENT.test(binding.hostName) || !IDENT.test(binding.modelField)) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "binding"]);
  }
  if (!IDENT.test(turnName) || !source.includes(turnName)) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "turn_binding"]);
  }
  const window = utf8Window(source, agent.startByte, agent.endByte);
  if (!window) return fail("unsupported-binding-shape", ["utf8_window"]);
  if (window.includes("agentId:") || window.includes("invocationId:")) {
    return fail("already-patched-or-contract-changed", ["already-patched-or-contract-changed"]);
  }
  if (window.includes("...")) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "spread"]);
  }
  const startAnchor = `const ${binding.optionsName} = {`;
  if (!uniqueSnippet(source, startAnchor)) {
    return fail("unsupported-binding-shape", ["start_anchor_not_unique"]);
  }
  const callNeedle = `.createSession(`;
  const callHits: number[] = [];
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(callNeedle, from);
    if (at < 0) break;
    const after = source.slice(at, at + 180);
    if (after.includes(binding.optionsName)) callHits.push(at);
    from = at + callNeedle.length;
  }
  if (callHits.length !== 1) {
    return fail("unsupported-binding-shape", ["unsupported-binding-shape", "createSession_call"]);
  }
  const callAt = callHits[0]!;
  const lineStart = source.lastIndexOf("\n", callAt) + 1;
  let lineEnd = source.indexOf("\n", callAt);
  if (lineEnd < 0) lineEnd = source.length;
  let endAnchor = source.slice(lineStart, lineEnd).replace(/\r$/, "");
  if (!uniqueSnippet(source, endAnchor)) {
    const liveEnd = LIVE_SLICE_PATCHES.find((slice) => slice.id === "agent-id")?.endAnchor;
    if (!liveEnd || !uniqueSnippet(source, liveEnd)) {
      return fail("unsupported-binding-shape", ["end_anchor_not_unique"]);
    }
    endAnchor = liveEnd;
  }
  const modelNeedle = `modelId: ${binding.hostName}.${binding.modelField}`;
  const modelAt = window.indexOf(modelNeedle);
  if (modelAt < 0) return fail("unsupported-binding-shape", ["unsupported-binding-shape", "modelId"]);
  const modelLineStart = window.lastIndexOf("\n", modelAt) + 1;
  const modelLineNl = window.indexOf("\n", modelAt);
  if (modelLineNl < 0) return fail("unsupported-binding-shape", ["modelId_newline"]);
  const find = window.slice(modelLineStart, modelLineNl + 1);
  if (countOccurrences(source, find) !== 1) {
    return fail("unsupported-binding-shape", ["find_not_unique"]);
  }
  const indent = find.match(/^[ \t]*/)?.[0] ?? "";
  const nl = find.endsWith("\r\n") ? "\r\n" : "\n";
  const live = LIVE_SLICE_PATCHES.find((slice) => slice.id === "agent-id");
  const sameFamily = binding.hostName === "host" && binding.modelField === "subagentModelId" && turnName === "inferenceRequestId";
  const replacement = live && find === live.find && sameFamily
    ? live.replacement
    : `${indent}agentId: ${binding.hostName}.getConversationId(),${nl}${indent}invocationId: ${turnName},${nl}${sameFamily ? `${indent}clientNonce: options2.clientNonce,${nl}` : ""}${find}`;

  return {
    id: "agent-id",
    startAnchor,
    endAnchor,
    find,
    replacement,
  };
}

/**
 * Literal SlicePatch pair from unique bound candidates. Original bytes only.
 * Does not pick Acorn vs lexical, rewrite Host, or merge conflicting variants.
 */
export function emitLiteralSlicePair(input: {
  source: string;
  create: ShapeCandidate;
  agent: ShapeCandidate;
  turnName: string;
}): SliceEmitResult {
  const created = emitCreate(input.source, input.create);
  if ("status" in created) return created;
  const agent = emitAgent(input.source, input.agent, input.turnName);
  if ("status" in agent) return agent;
  const merged = refuseConflictingVariants([created, agent]);
  if ("conflict" in merged) {
    return fail("conflict", merged.limitations, [created, agent]);
  }
  const slices: [SlicePatch, SlicePatch] = [created, agent];
  let profile: PatchProfile;
  try {
    profile = profileFromSource(input.source, slices, "hso-4-emit");
  } catch {
    return fail("replay-failed", ["transformUnchecked"], slices);
  }
  const replay = applyPatchProfile(input.source, profile);
  if (!replay.ok) {
    return fail("replay-failed", [replay.code], slices);
  }
  return {
    status: "ok",
    slices,
    profile,
    replay,
    writes: 0,
    hostSignals: 0,
    limitations: [],
  };
}
