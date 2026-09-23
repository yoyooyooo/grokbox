import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = new URL("../", import.meta.url).pathname;
const { expandTests, assertPartition, partitionTests } = await import(new URL("../scripts/verification-shards.mjs", import.meta.url).href);
const { resolveCoreCase, planCoreProof } = await import(new URL("../scripts/verify-modeld-core.mjs", import.meta.url).href);

test("declared directories expand into exact regular test files with no implicit selectors", () => {
  const cache = join(root, "node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const own = mkdtempSync(join(cache, "plan-"));
  try {
    mkdirSync(join(own, "nested")); writeFileSync(join(own, "nested/a.test.ts"), ""); writeFileSync(join(own, "nested/b.test.js"), "");
    writeFileSync(join(own, "nested/helper.ts"), "");
    expect(expandTests(own, ["nested"])).toEqual(["nested/a.test.ts", "nested/b.test.js"]);
    expect(() => expandTests(own, ["nested", "./nested/a.test.ts"])).toThrow("duplicate");
    expect(() => expandTests(own, ["../escape.test.ts"])).toThrow();
    expect(() => expandTests(own, ["absent.test.ts"])).toThrow();
    symlinkSync(join(own, "nested/a.test.ts"), join(own, "link.test.ts"));
    expect(() => expandTests(own, ["link.test.ts"])).toThrow("invalid-test-file");
    mkdirSync(join(own, "empty")); expect(() => expandTests(own, ["empty"])).toThrow("empty");
  } finally { rmSync(own, { recursive: true, force: true }); }
});

test("a shard plan cannot omit, duplicate, add, or silently empty a required file", () => {
  const files = ["a", "b", "c"];
  for (const shards of [[], [{ id: "one", files: [] }], [{ id: "one", files: ["a", "b"] }],
    [{ id: "one", files: files }, { id: "two", files: ["a"] }], [{ id: "one", files: [...files, "extra"] }],
    [{ id: "same", files: ["a"] }, { id: "same", files: ["b", "c"] }]]) expect(() => assertPartition(files, shards)).toThrow();
  const shards = partitionTests(files, () => "owner", 2);
  expect(shards).toEqual([{ id: "owner-1", files: ["a", "b"] }, { id: "owner-2", files: ["c"] }]);
});

test("core plan is a disjoint complete inventory with unchanged per-case deadline", () => {
  const r = spawnSync("node", ["scripts/verify-host-health.mjs", "core", "--list"], { cwd: root, encoding: "utf8", timeout: 10000 });
  expect(r.status, r.stderr).toBe(0);
  const plan = JSON.parse(r.stdout), calls = plan.commands.filter((c: string[]) => c[0] === "bun" && c[1] === "test");
  const actual = calls.flatMap((c: string[]) => {
    expect(c.slice(0,4)).toEqual(["bun", "test", "--timeout", "220000"]);
    expect(c.slice(4).every(p=>p.startsWith("./"))).toBe(true);
    expect(c.length - 4).toBeLessThanOrEqual(20); return c.slice(4).map(p=>p.slice(2));
  });
  expect(new Set(actual).size).toBe(actual.length); expect([...actual].sort()).toEqual([...plan.files].sort());
  expect(plan.files).toContain("test/cli.test.ts"); expect(plan.files).toContain("test/preload-artifact.test.ts");
  expect(plan.shards.find((s: {id: string})=>s.id==="cli-1").files).toEqual(["test/cli.test.ts"]);
});

test("release plan partitions every original required file and keeps long-lived and compiler owners separate", () => {
  const selection = resolveCoreCase(["release-offline"]), plan = planCoreProof(selection);
  const actual = plan.flatMap((s: {files: string[]})=>s.files);
  expect(new Set(actual).size).toBe(actual.length);
  expect([...actual].sort()).toEqual(expandTests(root, selection.files).sort());
  for (const [id, name] of [["endurance-1", "execution-lifetime.test.ts"], ["cancellation-observation-1", "authority-observation.test.ts"], ["artifact-refusal-1", "preload-artifact.test.ts"]])
    expect(plan.find((s: {id: string})=>s.id===id).files).toHaveLength(1);
  expect(plan.every((s: {files: string[]})=>s.files.length > 0 && s.files.length <=20)).toBe(true);
});
