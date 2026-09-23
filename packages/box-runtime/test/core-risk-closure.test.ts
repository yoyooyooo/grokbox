import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HOST_RECIPE } from "../src/internal/host/source-recipes.ts";
import { HOST_CHECK_REQUIREMENTS } from "@grokbox/runtime-kernel/host-health";
import { HOST_CORE_RISK_FAMILIES, HOST_CORE_RISK_TESTS } from "../../../scripts/host-core-risk-manifest.mjs";

const root = resolve(import.meta.dir, "../../..");
const recipeIds = [...HOST_RECIPE.core, ...HOST_RECIPE.checkpoint, ...HOST_RECIPE.currentState].map(slice => slice.id);

test("A2 risk map covers every maintained Host/worker slice exactly once", () => {
  expect(recipeIds).toHaveLength(61);
  expect(new Set(recipeIds).size).toBe(recipeIds.length);
  const mapped = HOST_CORE_RISK_FAMILIES.flatMap(family => family.slices);
  expect(mapped).toHaveLength(recipeIds.length);
  expect(new Set(mapped).size).toBe(mapped.length);
  expect([...mapped].sort()).toEqual([...recipeIds].sort());
  for (const family of HOST_CORE_RISK_FAMILIES) {
    expect(family.id).toMatch(/^[a-z][a-z0-9-]+$/);
    expect(family.slices.length).toBeGreaterThan(0);
    expect(family.concerns.length).toBeGreaterThan(0);
    expect(family.evidence.length).toBeGreaterThan(0);
  }
});
test("A2 evidence inventory is explicit, finite and executable rather than a qualified flag", () => {
  expect(HOST_CORE_RISK_TESTS.length).toBeGreaterThan(20);
  expect(HOST_CORE_RISK_TESTS.length).toBeLessThan(80);
  expect(new Set(HOST_CORE_RISK_TESTS).size).toBe(HOST_CORE_RISK_TESTS.length);
  for (const path of HOST_CORE_RISK_TESTS) {
    expect(path.endsWith(".test.ts")).toBe(true);
    expect(existsSync(resolve(root, path)), path).toBe(true);
  }
  expect(HOST_CHECK_REQUIREMENTS).toHaveLength(4);
  const staticallyNamed = new Set(HOST_CHECK_REQUIREMENTS.flatMap(row => [...row.slices]));
  expect(staticallyNamed.size).toBeLessThan(recipeIds.length);
});

test("A2 families explicitly include the shared-failure-domain risks required before first adoption", () => {
  const concerns = new Set(HOST_CORE_RISK_FAMILIES.flatMap(family => family.concerns));
  for (const required of [
    "official-passthrough", "non-target-bot", "tool-effect", "memory", "episode",
    "checkpoint", "lease", "cancel", "startup", "permission", "native-writer-preservation",
  ]) expect(concerns.has(required), required).toBe(true);
});