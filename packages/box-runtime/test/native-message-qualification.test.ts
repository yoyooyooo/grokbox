import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";
import { nativeWindowEnv } from "./native-host-source.ts";

const root = resolve(import.meta.dir, "../../..");
test.skipIf(!nativeContinuityEnabled())("current native message RPC, association, writer and tail use Node and owned SQLite", async () => {
  const node = process.env.GROKBOX_TEST_NATIVE_NODE;
  expect(node, "native message qualification requires an explicit Node executable").toBeTruthy();
  await mkdir(join(root, "node_modules/.cache"), { recursive: true });
  const directory = await mkdtemp(join(root, "node_modules/.cache/native-message-"));
  try {
    const driver = join(directory, "driver.mjs");
    await build({ absWorkingDir: root, entryPoints: [join(import.meta.dir, "fixtures/native-message.node.ts")],
      outfile: driver, bundle: true, platform: "node", target: "node22", format: "esm", external: ["typescript"],
      banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, logLevel: "silent" });
    const result = spawnSync(node!, ["--test", "--test-reporter=tap", driver], { cwd: directory, encoding: "utf8", timeout: 60000,
      maxBuffer: 1024 * 1024, env: { ...nativeWindowEnv(), PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
        GROKBOX_TEST_NATIVE_CONTINUITY: "1", NODE_NO_WARNINGS: "1" } });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/# fail 0/); expect(result.stdout).toMatch(/# skipped 0/);
    console.log(JSON.stringify({ suite: "native-message-node", tests: Number(result.stdout.match(/# tests (\d+)/)?.[1]),
      failed: 0, skipped: 0, originalDeclarations: true, nativeSqlite: true, fullHostExecuted: false, providerRequests: 0, appObserved: false }));
    for (const line of result.stdout.split("\n")) if (line.startsWith('# {"nativeMessageSource"')) console.log(line.slice(2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 90000);
