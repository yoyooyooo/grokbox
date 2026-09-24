import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
const root = fileURLToPath(new URL("../", import.meta.url));
test("system management uses the installed Node server, private owner stores and packed CLI", async () => {
  const cli = ensurePackedCli();
  await mkdir(join(root, "node_modules/.cache"), { recursive: true });
  const directory = await mkdtemp(join(root, "node_modules/.cache/system-management-"));
  try {
    const entry = join(directory, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/system-management.node.ts"], outfile: entry, bundle: true,
      platform: "node", target: "node22", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", entry], { cwd: directory, encoding: "utf8", timeout: 90000, maxBuffer: 3*1024*1024,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, GROKBOX_TEST_CLI_ENTRY: cli, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
    expect(result.error, result.stdout + result.stderr).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/);
    console.log(result.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120000);
