import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
test("manual compaction crosses management HTTP, original Host facade/modeld and CONT persistence", async () => {
  const cli = ensurePackedCli(), cache = join(root, "node_modules/.cache"); await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, "compaction-management-")), home = await mkdtemp("/tmp/gcc-");
  try {
    const entry = join(dir, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/compaction.node.ts"], outfile: entry, bundle: true, platform: "node", target: "node22", format: "esm",
      external: ["classic-level", "sqlite3"], banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", entry], { cwd: dir, encoding: "utf8", timeout: 90000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home, GROKBOX_TEST_CLI_ENTRY: cli, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined(); expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "compaction-management-node", tests: Number(result.stdout.match(/# tests (\d+)/)?.[1]), failed: 0, skipped: 0,
      nativeFacts: "synthetic-shell-original-facade-and-modeld", provider: "isolated-loopback", persistence: "original-CONT" }));
  } finally { await rm(dir, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
}, 120000);
