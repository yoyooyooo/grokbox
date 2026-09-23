import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url));
test("native products use actual Node HTTP, original CONT SQLite and the shared client without native/account side effects", async () => {
  const cache = join(root, "node_modules", ".cache"); await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, "grokbox-product-tests-"));
  try {
    ensurePackedCli();
    const output = join(directory, "products.test.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/products.node.ts"], outfile: output,
      bundle: true, platform: "node", target: "node20", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", output], { cwd: root, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0", GROKBOX_TEST_CLI_ENTRY: join(root, "dist", "index.js") } });
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# tests [1-9][0-9]*/); expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "AH-138-native-products-node", tests: Number(result.stdout.match(/# tests ([0-9]+)/)?.[1]), failed: 0, skipped: 0 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
