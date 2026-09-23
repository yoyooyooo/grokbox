import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensurePackedCli } from "../../../test/packed-cli-fixture.ts";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";
import { nativeWindowEnv } from "./native-host-source.ts";

const root = resolve(import.meta.dir, "../../..");
test.skipIf(!nativeContinuityEnabled())("current full native candidate and legal semantic negatives use the actual packaged Node/FD/Rust verifier", async () => {
  const node = process.env.GROKBOX_TEST_NATIVE_NODE;
  expect(node, "native candidate qualification requires an explicit Node executable").toBeTruthy();
  const cli = ensurePackedCli();
  await mkdir(join(root, "node_modules/.cache"), { recursive: true });
  const dir = await mkdtemp(join(root, "node_modules/.cache/native-candidate-"));
  try {
    const entry = join(dir, "driver.mjs");
    await build({ absWorkingDir: root, entryPoints: [join(import.meta.dir, "fixtures/native-current-candidate.node.ts")],
      outfile: entry, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent" });
    const result = spawnSync(node!, [entry], { cwd: dir, encoding: "utf8", timeout: 90000, maxBuffer: 1024 * 1024,
      env: { ...nativeWindowEnv(), PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GROKBOX_TEST_NATIVE_CONTINUITY: "1",
        GROKBOX_TEST_VERIFIER_DIRECTORY: join(dirname(cli), "native/x86_64-unknown-linux-gnu") } });
    expect(result.error, result.stderr).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({ slices: 61, fullHostExecuted: false, loadedProven: false, profilePublished: false, providerRequests: 0, qualified: false });
    expect(receipt.positive).toHaveLength(4); expect(receipt.negative).toHaveLength(4);
    for (const row of receipt.negative) expect(row).toMatchObject({ state: "violated", validJavaScript: true });
    console.log(JSON.stringify(receipt));
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 180000);
