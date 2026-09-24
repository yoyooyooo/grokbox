import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("read lock waiting leaves real Node workers available for the original SQLite owner", async () => {
  const cache = join(root, "node_modules/.cache"); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "sqlite-read-scheduling-"));
  try {
    const entry = join(directory, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/box-runtime/test/sqlite-read-scheduling.node.ts"], outfile: entry,
      bundle: true, platform: "node", target: "node22", format: "esm", external: ["sqlite3"], logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", entry], { cwd: directory, encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, UV_THREADPOOL_SIZE: "1" } });
    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "sqlite-read-scheduling-node", tests: Number(result.stdout.match(/# tests (\d+)/)?.[1]), failed: 0, threadpool: 1 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30000);
