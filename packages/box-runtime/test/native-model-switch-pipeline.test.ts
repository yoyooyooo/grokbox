import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exerciseModelSwitchPipeline } from "./model-switch-pipeline-fixture.ts";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";

const repository = resolve(import.meta.dir, "../../..");
test.skipIf(!nativeContinuityEnabled())("managed model selection and SDK tool history continue after original AgentStore/worker SQLite and independent Node readback", async () => {
  const node = process.env.GROKBOX_TEST_NATIVE_NODE;
  expect(node, "native model pipeline requires an explicit Node executable").toBeTruthy();
  let checkpoint: { root: string; driver: string; worker: string; written: Record<string, any> } | undefined;
  const run = (root: string, driver: string, worker: string, mode: "write" | "read", input?: string) => {
    const result = spawnSync(node!, [driver, root, worker, mode], { cwd: root, encoding: "utf8", timeout: 40000,
      input, maxBuffer: 2 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: root, GROKBOX_TEST_NATIVE_CONTINUITY: "1", NODE_NO_WARNINGS: "1" } });
    expect(result.error?.message).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, any>;
  };
  await exerciseModelSwitchPipeline({
    async save(directory, messages) {
      const root = join(directory, "native-checkpoint"); await mkdir(root, { mode: 0o700 });
      await writeFile(join(root, "owned-marker"), "grokbox-original-worker", { mode: 0o600 });
      await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
      const driver = join(root, "driver.mjs"), worker = join(root, "worker.cjs");
      await build({ absWorkingDir: repository, entryPoints: [join(import.meta.dir, "fixtures/native-worker-thread-entry.ts")],
        outfile: worker, bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "silent" });
      await build({ absWorkingDir: repository, entryPoints: [join(import.meta.dir, "fixtures/native-model-checkpoint.node.ts")],
        outfile: driver, bundle: true, platform: "node", target: "node22", format: "esm", external: ["typescript"],
        banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, logLevel: "silent" });
      const written = run(root, driver, worker, "write", JSON.stringify(messages));
      expect(written).toMatchObject({ originalWorker: true, nativeSqlite: true, nativeStateReadBack: true });
      expect(written.parts).toBeGreaterThan(1); checkpoint = { root, driver, worker, written };
    },
    async load() {
      if (!checkpoint) throw Error("native_pipeline_checkpoint_missing");
      const read = run(checkpoint.root, checkpoint.driver, checkpoint.worker, "read");
      expect(read.rootHash).toBe(checkpoint.written.rootHash); expect(read.parts).toBe(checkpoint.written.parts);
      expect(read.pid).not.toBe(checkpoint.written.pid); expect(read.nativeStateReadBack).toBe(true);
      expect(Array.isArray(read.messages)).toBe(true);
      console.log(JSON.stringify({ nativeModelPipeline: true, originalAgentStore: true, originalWorker: true,
        nativeSqlite: true, independentReader: true, verifiedParts: read.parts, fullHostExecuted: false,
        actualProviderRequests: 0, modelBoundary: "production-modeld-sdk-with-owned-upstream" }));
      return read.messages;
    },
  });
}, 120000);
