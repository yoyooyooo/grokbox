import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "../../..");
const node = process.env.GROKBOX_TEST_NODE ?? "node";

test("actual packaged Host on Node: ten compactions, complete persisted lineage, then a fresh process continues without re-compacting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-packed-"));
  const worker = join(dir, "worker.mjs"), preload = join(root, "dist/preload.cjs");
  try {
    await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
    await build({ absWorkingDir: root, entryPoints: [join(root, "packages/box-runtime/test/fixtures/context-packed-worker.ts")], bundle: true,
      platform: "node", target: "node20", format: "esm", outfile: worker, external: ["classic-level", "sqlite3"],
      banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" }, logLevel: "silent" });
    const run = (mode: string) => {
      const result = spawnSync(node, [worker, mode, dir, preload], { cwd: dir, encoding: "utf8", timeout: 25000,
        env: { PATH: process.env.PATH, HOME: dir, GROKBOX_PACKED_SESSION_FACTORY: "1", GROKBOX_ALLOW_LIVE_HOST: "", NODE_NO_WARNINGS: "1" } });
      expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout.trim());
    };
    const initial = run("exercise");
    expect(initial).toMatchObject({ compactions: 10, checkpoints: 10, activities: 10, mainRequests: 10, initialFact: true, lastFact: true, packedFactory: true });
    expect(initial.summaryRequests).toBeGreaterThanOrEqual(10);
    const again = run("reopen");
    expect(again).toMatchObject({ compactions: 0, checkpoints: 0, mainRequests: 1, summaryRequests: 0, initialFact: true, lastFact: true, packedFactory: true });
    expect(again.pid).not.toBe(initial.pid); expect(again.checkpointDigest).toBe(initial.checkpointDigest);
    const cli = spawnSync(node, [join(root, "dist/index.js"), "config", "get", "runtime.context.windowTokens", "--effective", "--json"], {
      cwd: dir, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH, HOME: dir, GROKBOX_CONFIG_DIR: join(dir, "clean-config"), NODE_NO_WARNINGS: "1" },
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).data).toMatchObject({ value: 128000, executionAuthorized: false });
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES"), "utf8")).toContain("Pi agent-core 0.85.1");
    if (process.env.GROKBOX_TEST_NODE) expect(initial.node).toBe("v20.17.0");
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);
