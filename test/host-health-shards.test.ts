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


test("R1 native runtime inventory includes the original summary, independent reader and model pipeline", () => {
  const native = inventory("native-runtime");
  for (const path of ["context-native-qualification.test.ts", "native-checkpoint-process.test.ts", "native-model-switch-pipeline.test.ts", "native-worker-binding.test.ts"])
    expect(native.files).toContain(`packages/box-runtime/test/${path}`);
  expect(new Set(native.files).size).toBe(native.files.length);
  const all = native.commands.flatMap(command => {
    expect(command.slice(0, 4)).toEqual(["bun", "test", "--timeout", "220000"]);
    expect(command.length).toBeGreaterThan(4);
    expect(command.slice(4).every(path => path.startsWith("./"))).toBe(true);
    return command.slice(4).map(path => path.slice(2));
  });
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort()).toEqual([...native.files].sort());

});

test("native runtime never obtains a passing run from missing opt-ins or an implicit Node", () => {
  for (const settings of [
    { GROKBOX_TEST_NATIVE_CONTINUITY: "0", GROKBOX_TEST_NATIVE_HOST: "1", GROKBOX_TEST_NATIVE_NODE: "/not-executed/node" },
    { GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_NATIVE_NODE: "/not-executed/node" },
    { GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_HOST: "1" },
    { GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_HOST: "1", GROKBOX_TEST_NATIVE_NODE: "/not-executed/node", GROKBOX_TEST_NATIVE_CONTINUITY_PAIR: "latest" },
  ]) {
    const refused = spawnSync("node", ["scripts/verify-host-health.mjs", "native-runtime"], {
      cwd: root, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, ...settings },
    });
    expect(refused.error).toBeUndefined(); expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("requires explicit native"); expect(refused.stdout).not.toContain("-before");
  }
});


test("A2 core-risk inventory is a disjoint complete execution of the maintained risk evidence set", () => {
  const risk = inventory("core-risk");
  expect(risk.files).toContain("packages/box-runtime/test/core-risk-closure.test.ts");
  expect(risk.files).toContain("packages/box-runtime/test/native-current-candidate.test.ts");
  expect(risk.files).toContain("packages/box-runtime/test/host-resume-admission.test.ts");
  const files = risk.commands.flatMap(command => {
    expect(command.slice(0, 4)).toEqual(["bun", "test", "--timeout", "220000"]);
    expect(command.slice(4).every(path => path.startsWith("./"))).toBe(true);
    return command.slice(4).map(path => path.slice(2));
  });
  expect(new Set(files).size).toBe(files.length);
  expect([...files].sort()).toEqual([...risk.files].sort());
});

test("A2 core-risk cannot run without explicit current native qualification inputs", () => {
  for (const settings of [
    { GROKBOX_TEST_NATIVE_CONTINUITY: "0", GROKBOX_TEST_NATIVE_HOST: "1", GROKBOX_TEST_NATIVE_NODE: "/not-executed/node" },
    { GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_NATIVE_NODE: "/not-executed/node" },
    { GROKBOX_TEST_NATIVE_CONTINUITY: "1", GROKBOX_TEST_NATIVE_HOST: "1" },
  ]) {
    const refused = spawnSync("node", ["scripts/verify-host-health.mjs", "core-risk"], {
      cwd: root, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, ...settings },
    });
    expect(refused.error).toBeUndefined();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).not.toContain("-before");
  }
});