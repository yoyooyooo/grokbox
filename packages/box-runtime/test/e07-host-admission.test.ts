import { describe, expect, test } from "bun:test";
import {
  attachHostAuxStreamContext,
  grokboxAuxFrom,
} from "../src/internal/host/aux-request.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { applyPatchProfile, approvedSliceSet, profileFromSource } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

const PARENT = {
  agentId: "agent-tom",
  turnId: "turn-1",
  stepId: "step-main",
  modelId: "openai/gpt-4o-mini",
  selectionRevision: "rev-1",
};

/** Current Host memory/episode shape: getExecutor + stream without STEP or grokboxAux. */
function unpatchedAuxiliaryHost(session: { getExecutor: (state?: unknown) => { stream: (ctx?: unknown, id?: unknown) => unknown } }) {
  return {
    extractMemory(state: unknown) {
      return session.getExecutor(state).stream({});
    },
    summarizeEpisode(state: unknown) {
      return session.getExecutor(state).stream({});
    },
  };
}

describe("E07 Host admission residual", () => {
  test("live slices still do not carry grokboxAux; aux-purpose slice is not approved", () => {
    expect(LIVE_SLICE_PATCHES.map((slice) => slice.id)).toEqual(["create-session", "agent-id", "compact-register", "activity-bridge"]);
    expect(LIVE_SLICE_PATCHES.some((slice) => slice.replacement.includes("grokboxAux"))).toBe(false);
    expect(approvedSliceSet(LIVE_SLICE_PATCHES)).toBe(true);
    expect(approvedSliceSet([...LIVE_SLICE_PATCHES, LIVE_SLICE_PATCHES[0]!])).toBe(false);
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "e07-admission");
    const applied = applyPatchProfile(LIVE_SHAPED_HOST, profile);
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.source).not.toContain("grokboxAux");
  });

  test("unpatched memory/episode call sites emit no grokboxAux even if the user text names a purpose", () => {
    const seen: unknown[] = [];
    const session = {
      getExecutor() {
        return {
          stream(ctx?: unknown) {
            seen.push(ctx);
            return { response: Promise.resolve({ finishReason: "stop", messages: [] }) };
          },
        };
      },
    };
    const host = unpatchedAuxiliaryHost(session);
    host.extractMemory([{ role: "user", content: "purpose: memory-extraction" }]);
    host.summarizeEpisode([{ role: "user", content: "purpose: episode" }]);
    expect(seen).toHaveLength(2);
    expect(grokboxAuxFrom(seen[0])).toBeUndefined();
    expect(grokboxAuxFrom(seen[1])).toBeUndefined();
  });

  test("attachHostAuxStreamContext is fail-closed and does not invent purpose from message body", () => {
    expect(attachHostAuxStreamContext({
      purpose: "memory-extraction",
      auxRequestId: "aux-mem-1",
      parent: PARENT,
      ctx: { signal: "keep" },
    })?.aux).toEqual({
      purpose: "memory-extraction",
      auxRequestId: "aux-mem-1",
      parent: PARENT,
    });
    expect(attachHostAuxStreamContext({
      purpose: "episode",
      auxRequestId: "aux-ep-1",
      parent: PARENT,
    })?.aux.purpose).toBe("episode");
    expect(attachHostAuxStreamContext({
      purpose: "purpose: episode",
      auxRequestId: "aux-fake",
      parent: PARENT,
    })).toBeUndefined();
    expect(attachHostAuxStreamContext({
      purpose: "memory-extraction",
      auxRequestId: PARENT.stepId,
      parent: PARENT,
    })).toBeUndefined();
    expect(attachHostAuxStreamContext({
      purpose: "memory-extraction",
      auxRequestId: "aux-mem-2",
      parent: { ...PARENT, stepId: "" },
    })).toBeUndefined();
  });

  test("synthetic Host call site using the helper admits grokboxAux; missing attach stays unqualified", () => {
    const seen: unknown[] = [];
    const session = {
      getExecutor() {
        return {
          stream(ctx?: unknown) {
            seen.push(grokboxAuxFrom(ctx));
            return ctx;
          },
        };
      },
    };
    const attached = attachHostAuxStreamContext({
      purpose: "memory-extraction",
      auxRequestId: "aux-mem-live",
      parent: PARENT,
      ctx: {},
    });
    session.getExecutor().stream(attached?.ctx ?? {});
    session.getExecutor().stream({});
    expect(seen[0]).toMatchObject({ purpose: "memory-extraction", auxRequestId: "aux-mem-live" });
    expect(seen[1]).toBeUndefined();
  });
});
