import { describe, expect, test } from "bun:test";
import { createProfile, mergedProfile, parseHarness } from "../src/commands/management.ts";

describe("L2 roster harness contract", () => {
  test("create always emits box unless temporal is set", () => {
    expect(createProfile({ name: "alpha" }).harness).toBe("box");
    expect(createProfile({ name: "alpha", harness: "temporal" }).harness).toBe("temporal");
  });

  test("mergedProfile preserves profile fields but never reasserts ownership", () => {
    const row = { name: "alpha", description: "d", title: "T", harness: "temporal" };
    const merged = mergedProfile(row, {});
    expect(merged).toEqual({ name: "alpha", description: "d", title: "T" });
    expect(() => mergedProfile({ name: "alpha", description: "" }, { harness: "box" })).toThrow(/harness/);
    expect(mergedProfile({ name: "alpha", description: "" }, {})).not.toHaveProperty("harness");
  });

  test("parseHarness is fail-closed", () => {
    expect(parseHarness(undefined)).toBeUndefined();
    expect(parseHarness("box")).toBe("box");
    expect(() => parseHarness("server")).toThrow(/box or temporal/);
  });
});
