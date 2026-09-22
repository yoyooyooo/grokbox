import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePackedCli } from "./packed-cli-fixture.ts";
import { BROWSER_GROUPS } from "../apps/web/test/browser-groups.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const group of Object.keys(BROWSER_GROUPS)) test(`production console browser qualification (${group}) uses relocated artifacts and synthetic native facts`, async () => {
  const cli = ensurePackedCli();
  const cache = join(root, "apps", "web", "node_modules", ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "browser-test-"));
  // Chrome uses AF_UNIX sockets with a short pathname limit. Its private HOME
  // and TMPDIR are outside the long worktree, not a production browser profile.
  const home = await mkdtemp("/tmp/gwb-");
  try {
    const entry = join(directory, "browser.test.mjs");
    await build({ absWorkingDir: root, entryPoints: ["apps/web/test/browser.node.ts"], outfile: entry,
      bundle: true, platform: "node", target: "node22", format: "esm", external: ["playwright", "classic-level", "sqlite3"],
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync("node", ["--experimental-test-isolation=none", "--test", "--test-reporter=tap", entry], { cwd: directory, encoding: "utf8", timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: home,
        GROKBOX_WEB_TEST_GROUP: group,
        GROKBOX_WEB_ARTIFACT: join(root, "dist", "web"), GROKBOX_TEST_CLI_ENTRY: cli, GROKBOX_TEST_FIXTURES: join(root,"test/fixtures"),
        GROKBOX_WEB_EVIDENCE: join(root, ".scratch", "web-validation"),
        GROKBOX_TEST_CHROME: process.env.GROKBOX_TEST_CHROME ?? "/usr/bin/google-chrome",
        GROKBOX_TEST_NATIVE_HOST: "0", GROKBOX_TEST_ALLOW_NATIVE: "0" } });
    // Preserve the last completed scene on timeout/crash as well as on a test
    // failure; the process error alone hides the first failing browser state.
    expect(result.error, `${result.error?.message ?? ""}\n${String(result.stdout ?? "").slice(-64000)}\n${String(result.stderr ?? "").slice(-8000)}`).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "web-production-chrome", group, tests: Number(result.stdout.match(/# tests (\d+)/)?.[1]),
      failed: 0, skipped: 0, nativeFacts: "synthetic", artifact: "relocated", screenshotDirectory: ".scratch/web-validation" }));
  } finally { await rm(directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
}, 200_000);
