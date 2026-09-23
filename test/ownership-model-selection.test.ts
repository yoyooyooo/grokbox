import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Creation is a management operation now, not a retired direct Gateway command.
 * Preserve the five original ownership fault modes on the actual current chain. */
test("created Bot ownership uses current packed CLI, Node HTTP and original receipts without native/account effects", async () => {
  const cache = join(root, "node_modules", ".cache"); await mkdir(cache, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(cache, "created-ownership-"));
  try {
    ensurePackedCli(); const output = join(directory, "suite.mjs");
    await build({ absWorkingDir: root, entryPoints: ["packages/server/test/created-bot-ownership.node.ts"], outfile: output,
      bundle: true, platform: "node", target: "node20", format: "esm", external: ["classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--test", "--test-reporter=tap", output], { cwd: root, encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: directory, TMPDIR: directory, GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0", GROKBOX_TEST_CLI_ENTRY: join(root, "dist", "index.js") } });
    expect(result.error, result.error?.message).toBeUndefined(); expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# tests 6\b/); expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "created-bot-ownership-node", tests: 6, failed: 0, skipped: 0, native: "synthetic", modelCalls: 0 }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60000);
