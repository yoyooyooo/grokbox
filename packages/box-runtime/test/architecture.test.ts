import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const checker = join(repoRoot, "scripts", "check-runtime-boundaries.mjs");

async function runChecker(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", checker, "--root", root, "--json"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fixture(changes: Record<string, string> = {}, omitSource = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "t20-boundary-"));
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
  });

  test("minimal valid fixture is green", async () => {
    const result = await runChecker(await fixture());
    expect(result.code, result.stdout).toBe(0);
  });

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
  });

  test("missing required source is a non-zero checker", async () => {
    const result = await runChecker(await fixture({}, true));
    expect(result.code).not.toBe(0);
  });
});
