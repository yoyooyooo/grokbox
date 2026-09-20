import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { captureCli } from "./helpers.ts";
import { tmpdir } from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
test("retired lifecycle commands and task flags fail locally without a native or management fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "retired-lifecycle-")); let calls = 0;
  try {
    for (const args of [
      ["agents", "clone", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], ["agents", "replace", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["agents", "spawn"], ["agents", "lifecycle", "status"], ["agents", "lifecycle", "advance"],
      ["bot", "spawn", "--system-prompt-file", "private.md"], ["bot", "clone", "display-name", "--input", "-", "--preview", "--confirm"],
    ]) {
      const result = await captureCli(args, { configDir: directory, boxRuntimeRoot: directory, env: {},
        fetch: (async () => { calls++; throw Error("unexpected-test-transport"); }) as unknown as typeof fetch });
      expect(result.code).not.toBe(0);
    }
    expect(calls).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("manual lifecycle management uses the original staged CONT program, real Node HTTP and packed CLI", async () => {
  const cli = ensurePackedCli(), cache = join(root, "node_modules/.cache"); await mkdir(cache, { recursive: true }); const dir = await mkdtemp(join(cache, "lifecycle-management-"));
  try {
    const entry = join(dir, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/lifecycle.node.ts"], outfile: entry, bundle: true, platform: "node", target: "node22", format: "esm",
      external: ["classic-level", "sqlite3"], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", entry], { cwd: dir, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir, GROKBOX_TEST_CLI_ENTRY: cli, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined(); expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "lifecycle-management-node", tests: Number(result.stdout.match(/# tests (\d+)/)?.[1]), failed: 0, skipped: 0, nativeFacts: "synthetic", persistence: "original-CONT" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 160000);
