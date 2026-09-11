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
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)] = () => {
      throw new Error("host ui");
    };
    expect(() => emitHostActivity({ type: "thinking-delta", text: " " })).not.toThrow();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  });

  test("emits thinking-delta to the Host sink", () => {
    const seen: unknown[] = [];
    (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)] = (update: unknown) => {
      seen.push(update);
    };
    emitHostActivity({ type: "thinking-delta", text: " " });
    emitHostActivity({ type: "text-delta", text: "hi" });
    expect(seen).toEqual([
      { type: "thinking-delta", text: " " },
      { type: "text-delta", text: "hi" },
    ]);
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_ACTIVITY_SYMBOL)];
  });

  test("activity-bridge slice applies on the live-shaped fixture", () => {
    const applied = transformUnchecked(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.source).toContain(HOST_ACTIVITY_SYMBOL);
    expect(applied.source).toContain("streamWatchdog.noteUpdate(update)");
    expect(applied.source).toContain("host.emitUpdate(update, updateObservers)");
    const profile = profileFromSource(LIVE_SHAPED_HOST, LIVE_SLICE_PATCHES, "activity-shaped");
    expect(profile.slices.some((slice) => slice.id === "activity-bridge")).toBe(true);
  });
});
