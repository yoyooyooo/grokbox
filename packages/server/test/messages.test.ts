import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
test("message submissions and reconciliation use the real Node HTTP/Effect host with owned native fixtures", async () => {
  const cache = join(root, "node_modules/.cache");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, "message-node-"));
  try {
    const output = join(directory, "messages.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/messages.node.ts"], outfile: output,
      bundle: true, platform: "node", target: "node20", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", output], {
      cwd: directory, encoding: "utf8", timeout: 40_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
        GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    const tests = Number(result.stdout.match(/# tests (\d+)/)?.[1]);
    expect(tests).toBeGreaterThanOrEqual(11);
    console.log(JSON.stringify({ suite: "messages-node-http", tests, failed: 0, skipped: 0, native: "owned-fixtures", live: false }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 50_000);
