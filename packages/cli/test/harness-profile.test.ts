import { describe, expect, test } from "bun:test";
import { createProfile, mergedProfile, parseHarness } from "../src/commands/management.ts";

describe("L2 roster harness contract", () => {
  test("create always emits box unless temporal is set", () => {
    expect(createProfile({ name: "alpha" }).harness).toBe("box");
    expect(createProfile({ name: "alpha", harness: "temporal" }).harness).toBe("temporal");
  });

  test("mergedProfile preserves other fields and never omits harness", () => {
    const row = { name: "alpha", description: "d", title: "T", harness: "temporal" };
    const merged = mergedProfile(row, {});
    expect(merged).toMatchObject({ name: "alpha", description: "d", title: "T", harness: "temporal" });
    expect(mergedProfile({ name: "alpha", description: "" }, { harness: "box" }).harness).toBe("box");
    expect(mergedProfile({ name: "alpha", description: "" }, {}).harness).toBe("box");
  });

  test("parseHarness is fail-closed", () => {
    expect(parseHarness(undefined)).toBeUndefined();
    expect(parseHarness("box")).toBe("box");
    expect(() => parseHarness("server")).toThrow(/box or temporal/);
  });
});
