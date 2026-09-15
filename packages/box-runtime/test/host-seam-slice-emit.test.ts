import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatchProfile } from "../src/internal/host/profile.ts";
import { emitLiteralSlicePair, refuseConflictingVariants } from "../src/internal/ops/host-seam/slice-emit.ts";
import { structuralShapeSync } from "../src/internal/ops/host-seam/shape.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";
import type { ShapeCandidate } from "../src/internal/ops/host-seam/shape-worker.ts";
import type { SlicePatch } from "../src/internal/host/profile.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function unique(source: string, sliceId: ShapeCandidate["sliceId"]): ShapeCandidate {
  const rows = structuralShapeSync(source).candidates.filter((row) => row.sliceId === sliceId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("HSO-4 literal SlicePatch emit", () => {
  test("unique LIVE_SHAPED_HOST pair emits two-slice literals that exact-replay", () => {
    const emitted = emitLiteralSlicePair({
      source: LIVE_SHAPED_HOST,
      create: unique(LIVE_SHAPED_HOST, "create-session"),
      agent: unique(LIVE_SHAPED_HOST, "agent-id"),
      turnName: "inferenceRequestId",
    });
    expect(emitted.status).toBe("ok");
    if (emitted.status !== "ok") return;
    expect(emitted.slices.map((slice) => slice.id)).toEqual(["create-session", "agent-id"]);
    expect(emitted.writes).toBe(0);
    expect(emitted.hostSignals).toBe(0);
    const replay = applyPatchProfile(LIVE_SHAPED_HOST, emitted.profile);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.source).toContain("__grokbox_original");
    expect(replay.source).toContain("agentId: host.getConversationId()");
    expect(replay.source).toContain("invocationId: inferenceRequestId");
    expect(replay.source).toContain("clientNonce: options2.clientNonce");
    expect(replay.source).toContain("modelId: host.subagentModelId");
  });

  test("renamed params still emit and replay using bound identifiers", () => {
    const source = LIVE_SHAPED_HOST
      .replaceAll("onRequestId", "cb")
      .replaceAll("sessionOptions", "opts");
    const emitted = emitLiteralSlicePair({
      source,
      create: unique(source, "create-session"),
      agent: unique(source, "agent-id"),
      turnName: "inferenceRequestId",
    });
    expect(emitted.status).toBe("ok");
    if (emitted.status !== "ok") return;
    expect(emitted.slices[0]!.startAnchor).toContain("cb, opts");
    expect(emitted.slices[0]!.replacement).toContain("onRequestId: cb");
    expect(emitted.slices[0]!.replacement).toContain("sessionOptions: opts");
    expect(applyPatchProfile(source, emitted.profile).ok).toBe(true);
  });

  test("ambiguous create-session is not first-wins", () => {
    const decoy = LIVE_SHAPED_HOST.replace(
      "const api = {",
      `const decoy = {
  createSession(onRequestId, sessionOptions) {
    return createCursorInferencePromptSession(sessionOptions);
  },
  recordPostTurnLabeling(args) { return args; },
};
const api = {`,
    );
    const creates = structuralShapeSync(decoy).candidates.filter((row) => row.sliceId === "create-session");
    expect(creates.length).toBeGreaterThan(1);
    const emitted = emitLiteralSlicePair({
      source: decoy,
      create: creates[0]!,
      agent: unique(decoy, "agent-id"),
      turnName: "inferenceRequestId",
    });
    expect(emitted.status).toBe("ambiguous-site");
  });

  test("unsupported rest/spread binding stays explicit fail", () => {
    const create = unique(LIVE_SHAPED_HOST, "create-session");
    const emitted = emitLiteralSlicePair({
      source: LIVE_SHAPED_HOST,
      create: { ...create, params: undefined },
      agent: unique(LIVE_SHAPED_HOST, "agent-id"),
      turnName: "inferenceRequestId",
    });
    expect(emitted.status).toBe("unsupported-binding-shape");
    expect(emitted.limitations).toContain("unsupported-binding-shape");
  });

  test("already-patched source is not auto-rewritten", () => {
    const patched = LIVE_SHAPED_HOST.replace(
      "return createCursorInferencePromptSession(inferenceOptions);",
      "const __grokbox_original = createCursorInferencePromptSession(inferenceOptions);\n      return __grokbox_original;",
    );
    const emitted = emitLiteralSlicePair({
      source: patched,
      create: unique(patched, "create-session"),
      agent: unique(patched, "agent-id"),
      turnName: "inferenceRequestId",
    });
    expect(emitted.status).toBe("already-patched-or-contract-changed");
  });

  test("conflicting variants are not merged first-wins", () => {
    const base: SlicePatch = {
      id: "create-session",
      startAnchor: "createSession(onRequestId, sessionOptions) {",
      endAnchor: "recordPostTurnLabeling(args) {",
      find: "return createCursorInferencePromptSession(inferenceOptions);\n",
      replacement: "a",
    };
    const conflict = refuseConflictingVariants([base, { ...base, replacement: "b" }]);
    expect("conflict" in conflict).toBe(true);
  });

  test("preload does not import slice emit", () => {
    const preload = readFileSync(join(repoRoot, "packages/box-runtime/src/preload.ts"), "utf8");
    const compile = readFileSync(join(repoRoot, "packages/box-runtime/src/internal/host/compile-hook.ts"), "utf8");
    for (const src of [preload, compile]) {
      expect(src).not.toContain("slice-emit");
      expect(src).not.toContain("SLICE_EMIT");
    }
  });
});
