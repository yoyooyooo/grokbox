import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { BROWSER_GROUPS, browserGroup } from "../apps/web/test/browser-groups.ts";

test("browser windows assign every production journey once without skipping or extending scenario budgets", async () => {
  const source = await readFile(new URL("../apps/web/test/browser.node.ts", import.meta.url), "utf8");
  const gates = [...new Set([...source.matchAll(/included\.has\("([A-Za-z]+)"\)/g)].map(match => match[1]!))];
  const assignments: readonly string[] = Object.values(BROWSER_GROUPS).flat();
  expect(new Set(assignments).size).toBe(assignments.length);
  expect([...assignments].sort()).toEqual(gates.sort());
  expect(source).toContain("timeout: 150_000");
  const runner = await readFile(new URL("./web-browser.test.ts", import.meta.url), "utf8");
  expect(runner).toContain("Object.keys(BROWSER_GROUPS)");
  expect(runner).toContain("GROKBOX_WEB_TEST_GROUP: group");
  expect(runner).toContain("timeout: 180_000");
  expect(runner).not.toContain("--test-force-exit");
  for (const group of Object.keys(BROWSER_GROUPS)) expect(group).toBe(browserGroup(group));
  for (const value of [undefined, "", "all", "__proto__", "toString", "future"]) expect(() => browserGroup(value)).toThrow();
});
