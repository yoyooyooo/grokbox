import { describe, expect, test } from "bun:test";
import { emitHostActivity, HOST_ACTIVITY_SYMBOL } from "../src/internal/host/activity.ts";
import { LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { profileFromSource, transformUnchecked } from "../src/internal/host/profile.ts";
import { LIVE_SHAPED_HOST } from "./live-shaped-host.ts";

describe("Host activity bridge", () => {
  test("missing sink is a no-op", () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
    expect(() => emitHostActivity({ type: "thinking-delta", text: " " })).not.toThrow();
  });

  test("sink throw does not escape", () => {
    const owned = () => { throw new Error("host ui"); };
    expect(() => emitHostActivity({ type: "thinking-delta", text: " " }, owned)).not.toThrow();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  });

  test("emits thinking-delta to the Host sink", () => {
    const seen: unknown[] = [];
    const owned = (update: unknown) => { seen.push(update); };
    emitHostActivity({ type: "thinking-delta", text: " " }, owned);
    emitHostActivity({ type: "text-delta", text: "hi" }, owned);
    expect(seen).toEqual([
      { type: "thinking-delta", text: " " },
      { type: "text-delta", text: "hi" },
    ]);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  });

  test("A cannot send synthetic activity to B through the last global callback", () => {
    const a: unknown[] = [], b: unknown[] = [];
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)] = (update: unknown) => b.push(update);
    emitHostActivity({ type: "thinking-delta", text: " " });
    emitHostActivity({ type: "text-delta", text: "owned A" }, update => { a.push(update); });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  });

  test("activity-bridge slice preserves the native run-owned listener", () => {
    const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).not.toContain(`Symbol.for("${HOST_ACTIVITY_SYMBOL}")`);
    expect(applied.source).toContain("streamWatchdog.noteUpdate(update)");
    expect(applied.source).toContain("host.emitUpdate(update, updateObservers)");
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "activity-shaped");
    expect(profile.slices.some((slice) => slice.id === "activity-bridge")).toBe(true);
  });
});
