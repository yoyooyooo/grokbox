import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
test("model authorization uses real Node HTTP, Effect and the original file publisher with synthetic native ownership", async () => {
  const cache = join(root, "node_modules", ".cache"); await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, "model-auth-"));
  try {
    const output = join(dir, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/model-authorization.node.ts"], outfile: output,
      bundle: true, platform: "node", target: "node20", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", output], { cwd: root, encoding: "utf8", timeout: 60000,
      maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir } });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "model-final-authorization-node", tests: Number(result.stdout.match(/# tests ([0-9]+)/)?.[1]), failed: 0, skipped: 0, live: false }));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 90000);
