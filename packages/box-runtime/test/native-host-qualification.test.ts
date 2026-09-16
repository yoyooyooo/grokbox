import { expect, test } from "bun:test";
import { nativeHostQualificationEnabled } from "./native-host-qualification.ts";

test("public tests do not probe native availability without explicit opt-in", () => {
  let probes = 0;
  for (const value of [undefined, "", "0"]) {
    expect(nativeHostQualificationEnabled({ GROKBOX_TEST_NATIVE_HOST: value }, () => { probes++; return true; })).toBe(false);
  }
  expect(probes).toBe(0);
});

test("explicit native qualification refuses missing bundles or invalid flags", () => {
  expect(() => nativeHostQualificationEnabled({ GROKBOX_TEST_NATIVE_HOST: "1" }, () => false)).toThrow("requires the installed Host bundle");
  expect(() => nativeHostQualificationEnabled({ GROKBOX_TEST_NATIVE_HOST: "yes" }, () => true)).toThrow("must be 0 or 1");
  expect(nativeHostQualificationEnabled({ GROKBOX_TEST_NATIVE_HOST: "1" }, () => true)).toBe(true);
});
