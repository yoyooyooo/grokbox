import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function inventory(group: string) {
  const result = spawnSync("node", ["scripts/verify-host-health.mjs", group, "--list"], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, GROKBOX_TEST_NATIVE_CONTINUITY: "0" },
  });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { group: string; files: string[]; commands: string[][] };
}

test("bounded integration shards partition the original inventory exactly once without weakening scenario timeouts", () => {
  const all = inventory("integration"), shards = ["integration-host", "integration-domains", "integration-web"].map(inventory);
  const paths = shards.flatMap(shard => shard.files);
  expect(new Set(paths).size).toBe(paths.length);
  expect([...paths].sort()).toEqual([...all.files].sort());
  expect(shards.flatMap(shard => shard.commands)).toEqual(all.commands);
  for (const shard of shards) {
    expect(shard.files.length).toBeGreaterThan(0);
    expect(shard.commands).toEqual([["bun", "test", "--timeout", "220000", ...shard.files]]);
  }
  expect(shards[0]!.files).toContain("test/host-health-management.test.ts");
  expect(shards[1]!.files).toContain("test/notification-management.test.ts");
  expect(shards[2]!.files).toEqual(["test/web-browser.test.ts", "test/packaging.test.ts"]);
});

test("inspection does not turn native qualification into an implicitly authorized run", () => {
  const native = inventory("native-pair");
  expect(native.files.length).toBeGreaterThan(0);
  const refused = spawnSync("node", ["scripts/verify-host-health.mjs", "native-pair"], {
    cwd: root, encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, GROKBOX_TEST_NATIVE_CONTINUITY: "0" },
  });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("requires explicit native continuity opt-in");
  expect(refused.stdout).not.toContain("-before");
});
