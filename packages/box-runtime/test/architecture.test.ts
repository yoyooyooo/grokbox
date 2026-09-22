import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const checker = join(repoRoot, "scripts", "check-runtime-boundaries.mjs");
// The checker owns a 5s import probe plus compilation. Its test owner must
// allow that bounded proof to finish rather than racing it at the same 5s.
const CHECKER_TEST_TIMEOUT_MS = 15_000;
const ownedFixtures: string[] = [];
afterEach(async () => { for (const root of ownedFixtures.splice(0)) await rm(root, { recursive: true, force: true }); });

async function runChecker(root: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  // Retain v2's settled Node child and OBS's structured-verdict requirement.
  // A timeout/crash is never proof that a negative architecture fixture passed.
  const child = spawnSync(process.env.GROKBOX_TEST_NODE ?? "node", [checker, "--root", root, "--json"], {
    cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
  });
  if (child.error) throw child.error;
  if (child.status === null || child.signal) throw new Error("checker_did_not_settle");
  const result = JSON.parse(child.stdout);
  if (typeof result?.ok !== "boolean" || !Array.isArray(result.failures) || result.ok !== (child.status === 0)) {
    throw new Error("checker_missing_structured_verdict");
  }
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fixture(changes: Record<string, string> = {}, omitSource = false): Promise<string> {
  // Esbuild traverses filesystem ancestors while resolving inputs. Keep its
  // tiny standalone fixtures away from an unrelated shared temporary tree.
  const cache = join(repoRoot, "node_modules", ".cache", "runtime-boundary-fixtures");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(cache, "fixture-")); ownedFixtures.push(root);
  // Stop compiler config discovery at the actual isolated project root.
  await put(root, "tsconfig.json", '{"compilerOptions":{}}\n');
  await put(root, "packages/box-runtime/package.json", `${JSON.stringify({
    name: "@grokbox/box-runtime",
    private: true,
    type: "module",
    exports: { "./runtime": "./src/runtime.ts" },
  })}\n`);
  await put(root, "packages/runtime-kernel/package.json", `${JSON.stringify({
    name: "@grokbox/runtime-kernel",
    private: true,
    type: "module",
    exports: {
      "./contract": "./src/contract.ts",
      "./hash": "./src/hash.ts",
      "./selection": "./src/selection.ts",
      "./ports": "./src/ports.ts",
      "./status": "./src/status.ts",
      "./monitor": "./src/monitor.ts",
      "./config": "./src/config.ts",
      "./alerts": "./src/alerts.ts",
      "./observation": "./src/observation.ts",
      "./routines": "./src/routines.ts",
      "./continuity": "./src/continuity.ts",
      "./model-management": "./src/model-management.ts",
      "./materials": "./src/materials.ts",
      "./files": "./src/files.ts",
      "./host-health": "./src/host-health.ts",
      "./compaction": "./src/compaction.ts",
      "./testing": "./src/testing.ts",
      "./inference": "./src/inference.ts",
      "./commands": "./src/commands.ts",
    },
  })}\n`);
  if (!omitSource) {
    for (const path of [
      "packages/box-runtime/src/preload.ts",
      "packages/box-runtime/src/runtime.ts",
      "packages/runtime-kernel/src/contract.ts",
      "packages/runtime-kernel/src/hash.ts",
      "packages/runtime-kernel/src/selection.ts",
      "packages/runtime-kernel/src/status.ts",
      "packages/runtime-kernel/src/monitor.ts",
      "packages/runtime-kernel/src/config.ts",
      "packages/runtime-kernel/src/alerts.ts",
      "packages/runtime-kernel/src/observation.ts",
      "packages/runtime-kernel/src/routines.ts",
      "packages/runtime-kernel/src/continuity.ts",
      "packages/runtime-kernel/src/model-management.ts",
      "packages/runtime-kernel/src/materials.ts",
      "packages/runtime-kernel/src/files.ts",
      "packages/runtime-kernel/src/host-health.ts",
      "packages/runtime-kernel/src/compaction.ts",
      "packages/runtime-kernel/src/testing.ts",
      "packages/runtime-kernel/src/inference.ts",
      "packages/runtime-kernel/src/commands.ts",
      "packages/cli/src/index.ts",
    ]) await put(root, path, "export {};\n");
    await put(root, "packages/runtime-kernel/src/ports.ts", "export const ConfigurationRead = 1;\n");
  }
  for (const [path, text] of Object.entries(changes)) await put(root, path, text);
  return root;
}

describe("runtime layout boundaries", () => {
  test("repository layout checker is green", async () => {
    const result = await runChecker(repoRoot);
    expect(result.code, result.stderr + result.stdout).toBe(0);
  }, CHECKER_TEST_TIMEOUT_MS);

  test("minimal valid fixture is green", async () => {
    const result = await runChecker(await fixture());
    expect(result.code, result.stdout).toBe(0);
  }, CHECKER_TEST_TIMEOUT_MS);

  test("default import proof excludes inherited profile activation while still checking unconditional side effects", async () => {
    const root = await fixture({ "packages/box-runtime/src/preload.ts": 'if (process.env.GROKBOX_ALLOW_LIVE_HOST === "1" || process.env.GROKBOX_PATCH_PROFILE || process.env.GROKBOX_OPERATION_ID) throw Error("unexpected inherited activation"); export {};\n' });
    const result = await runChecker(root, { GROKBOX_ALLOW_LIVE_HOST: "1", GROKBOX_PATCH_PROFILE: "/owned-fixture/not-a-real-profile", GROKBOX_OPERATION_ID: "synthetic" });
    expect(result.code, result.stdout + result.stderr).toBe(0);
  }, CHECKER_TEST_TIMEOUT_MS);

  const rejects: Array<[string, Record<string, string> | undefined, boolean?]> = [
    ["host-to-io", {
      "packages/box-runtime/src/internal/host/bad.ts": 'import { value } from "../io/configuration.node.ts"; export { value };',
      "packages/box-runtime/src/internal/io/configuration.node.ts": "export const value = 1;",
    }],
    ["io-to-root", {
      "packages/box-runtime/src/internal/io/bad.ts": 'import { value } from "../roots/controller.runtime.ts"; export { value };',
      "packages/box-runtime/src/internal/roots/controller.runtime.ts": "export const value = 1;",
    }],
    ["kernel-to-box", { "packages/runtime-kernel/src/contract.ts": 'export * from "@grokbox/box-runtime/runtime";' }],
    ["host-multiline-ports", {
      "packages/box-runtime/src/internal/host/bad.ts": 'import {\n  ConfigurationRead\n} from "@grokbox/runtime-kernel/ports";\nexport { ConfigurationRead };',
    }],
    ["host-cjs-effect", {
      "packages/box-runtime/src/internal/host/bad.cjs": 'const { Effect } = require("effect"); module.exports = Effect;',
    }],
    ["cli-deep-internal", {
      "packages/cli/src/bad.ts": 'export { value } from "../../box-runtime/src/internal/io/configuration.node.ts";',
      "packages/box-runtime/src/internal/io/configuration.node.ts": "export const value = 1;",
    }],
    ["preload-import-time-write", {
      "packages/box-runtime/src/preload.ts": 'import { writeFileSync } from "node:fs"; writeFileSync("/fixture/must-not-write", "unexpected");',
    }],
    ["bun-side-effect-import", { "packages/box-runtime/src/runtime.ts": 'import "bun:sqlite"; export {};' }],
    ["bun-sleep", { "packages/box-runtime/src/runtime.ts": "export const wait = () => Bun.sleep(10);" }],
    ["bun-bracket-file", { "packages/box-runtime/src/runtime.ts": 'export const load = () => Bun["file"]("/fixture/not-read");' }],
    ["later-console-root", { "packages/box-runtime/src/internal/roots/console.runtime.ts": "export const consoleRoot = () => ({ ok: true });" }],
    ["legacy-nested", { "packages/box-runtime/src/internal/legacy/old-kernel.ts": "export const oldKernel = () => ({ ok: true });" }],
    ["kernel-export-target", {
      "packages/runtime-kernel/package.json": JSON.stringify({
        name: "@grokbox/runtime-kernel",
        private: true,
        exports: { "./contract": "./src/ports.ts" },
      }),
    }],
    ["preload-namespaced-write", {
      "packages/box-runtime/src/preload.ts": 'import * as fs from "node:fs"; fs.writeFileSync("/fixture/must-not-write", "x");',
    }],
    ["preload-immediate-write", {
      "packages/box-runtime/src/preload.ts": 'import { writeFileSync } from "node:fs"; (() => writeFileSync("/fixture/must-not-write", "x"))();',
    }],
    ["kernel-effect-regression", {
      "packages/runtime-kernel/src/contract.ts": 'import { Effect } from "effect"; export const program = Effect.succeed(1);',
    }],
    ...["model-management", "materials", "files", "host-health", "compaction"].map(name => [
      `pure-domain-effect-${name}`, { [`packages/runtime-kernel/src/${name}.ts`]: 'import { Effect } from "effect"; export const program = Effect.succeed(1);' },
    ] as [string, Record<string, string>]),
    ["bun-global-version", {
      "packages/box-runtime/src/runtime.ts": "export const version = () => Bun.version;",
    }],
    ["compile-hook-shape-worker", {
      "packages/box-runtime/src/internal/host/compile-hook.ts": 'import { shapeFromSource } from "../ops/host-seam/shape-worker.ts"; export { shapeFromSource };',
    }],
    ["preload-acorn", {
      "packages/box-runtime/src/preload.ts": 'import * as acorn from "acorn"; export const parse = acorn.parse;',
    }],
    ["preload-throws", {
      "packages/box-runtime/src/preload.ts": 'throw new Error("synthetic-import-failure");',
    }],
    ["preload-exits", {
      "packages/box-runtime/src/preload.ts": "process.exit(7);",
    }],
    ["preload-fs-promises", {
      "packages/box-runtime/src/preload.ts": 'import { writeFile } from "node:fs/promises"; (async () => { await writeFile("/fixture/must-not-write", "synthetic"); })();',
    }],
  ];

  test.each(rejects)("%s is a non-zero checker", async (_name, changes) => {
    const result = await runChecker(await fixture(changes));
    expect(result.code).not.toBe(0);
    // An unavailable compiler/import trap is not evidence for the mutated
    // architecture. New pure-domain exports retain the existing Effect fence.
    const failures = JSON.parse(result.stdout).failures as Array<{ message: string }>;
    if (_name.startsWith("pure-domain-effect-")) expect(failures.some(f => f.message === "kernel non-ports file imports Effect")).toBe(true);
    expect(failures.some(f => !["preload esbuild failed", "preload import-time trap failed", "missing esbuild evidence"].includes(f.message)), result.stdout + result.stderr).toBe(true);
  }, CHECKER_TEST_TIMEOUT_MS);

  test("missing required source is a non-zero checker", async () => {
    const result = await runChecker(await fixture({}, true));
    expect(result.code).not.toBe(0);
  }, CHECKER_TEST_TIMEOUT_MS);
});
