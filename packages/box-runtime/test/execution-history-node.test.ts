import { expect, test } from "bun:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("Node loads the installed native execution store, persists 4096 claims and retires the epoch", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "execution-history-node-review-"));
  const levelEntry = createRequire(join(root, "package.json")).resolve("classic-level");
  try {
    const outfile = join(dir, "probe.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/box-runtime/test/fixtures/execution-history-node.ts"], outfile,
      bundle: true, platform: "node", target: "node20", format: "esm", logLevel: "silent",
      plugins: [{ name: "installed-native-store", setup(build) { build.onResolve({ filter: /^classic-level$/ }, () => ({ path: levelEntry, external: true })); } }],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
    const result = spawnSync("node", [outfile, join(dir, "run")], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir }, encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ runtime: expect.stringMatching(/^v\d+\./), writes: 4096, available: true, oldEpochRetired: true, networkCalls: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20_000);
