import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openContinuityCurrentState, openContinuityRecoveryStore } from "../src/runtime.ts";
import { ownedCurrentState, CURRENT_SCOPE } from "./fixtures/owned-current-state.ts";

const repository = resolve(import.meta.dir, "../../.."), worker = join(import.meta.dir, "fixtures/current-state-process-worker.ts");
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "current-state-process-")), root = join(base, "durable");
  await mkdir(root, { mode: 0o700 }); await writeFile(join(base, "owned-test-marker"), "current-state-owned-only", { mode: 0o600 });
  const native = await ownedCurrentState(join(base, "owned-native")); await native.seed();
  const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CURRENT_SCOPE }); await store.initialize();
  const controller = openContinuityCurrentState({ durableRoot: root, scopeId: CURRENT_SCOPE, native: native.native, authorizeInitialization: native.authorize });
  const capture = await controller.capture({ requestId: randomUUID(), expected: (await native.source()).head });
  if (capture.state !== "stored") throw Error("fixture capture failed");
  const request = await native.request(capture.publication);
  await writeFile(join(base, "request.json"), JSON.stringify(request), { mode: 0o600 });
  await symlink(join(repository, "node_modules"), join(base, "node_modules"), "dir");
  const path = join(base, "worker.mjs");
  await build({ absWorkingDir: repository, entryPoints: [worker], bundle: true, platform: "node", target: "node20", format: "esm", outfile: path,
    external: ["sqlite3", "classic-level"], banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" }, logLevel: "silent" });
  const command = process.env.GROKBOX_TEST_NODE ?? "node";
  const run = (mode: string) => spawnSync(command, [path, base, mode], { cwd: base, encoding: "utf8", timeout: 15000,
    env: { PATH: process.env.PATH, HOME: base, NODE_NO_WARNINGS: "1" } });
  const dispatches = () => readFile(join(base, "owned-dispatches.log"), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
  return { base, native, store, request, run, dispatches, close: () => rm(base, { recursive: true, force: true }) };
}
function value(result: ReturnType<typeof spawnSync>) {
  expect(result.error, String(result.stderr)).toBeUndefined(); expect(result.status, String(result.stderr)).toBe(0);
  return JSON.parse(String(result.stdout));
}

// Actual Node process death plus the production coordinator/SQLite/codec.
// The disk native port is an owned synthetic binding, not the official Host.
test("packed Node initializes once; a fresh process uses the installed current context", async () => {
  const f = await fixture(); try {
    expect(value(f.run("initialize"))).toMatchObject({ state: "prepared", effectDispatched: true, activated: false });
    const envelope = JSON.stringify(value(f.run("envelope")));
    expect(envelope).toContain("EARLY_FACT_SENTINEL"); expect(envelope).toContain("NEXT_PROCESS_INPUT");
    expect(envelope).not.toContain("OLD_SYSTEM_IDENTITY");
    expect(value(f.run("initialize"))).toMatchObject({ state: "already_applied", effectDispatched: false });
    expect(await f.dispatches()).toBe(`${f.request.effectId}\n`);
  } finally { await f.close(); }
}, 30000);

for (const mode of ["crash-after-claim", "crash-after-native", "crash-after-reopen"] as const) {
  test(`owned SIGKILL ${mode}: recovery reads receipts and never reissues the native write`, async () => {
    const f = await fixture(); try {
      const dead = f.run(mode); expect(dead.signal).toBe("SIGKILL"); expect(dead.status).toBeNull();
      expect(await f.store.operation(f.request.operationId)).toMatchObject({ state: "effect_unknown" });
      const before = await readFile(f.native.targetFile), recovered = value(f.run("reconcile"));
      expect(recovered).toMatchObject({ state: mode === "crash-after-claim" ? "unknown" : "reconciled", effectDispatched: false, activated: false });
      expect(await readFile(f.native.targetFile)).toEqual(before);
      expect(value(f.run("initialize"))).toMatchObject({ state: mode === "crash-after-claim" ? "unknown" : "already_applied", effectDispatched: false });
      expect(await f.dispatches()).toBe(mode === "crash-after-claim" ? "" : `${f.request.effectId}\n`);
    } finally { await f.close(); }
  }, 30000);
}

test("new process after B2 progress and source removal cannot replay the old initial snapshot", async () => {
  const f = await fixture(); try {
    value(f.run("initialize")); value(f.run("advance"));
    await rm(f.native.sourceFile); const before = await readFile(f.native.targetFile);
    expect(value(f.run("initialize"))).toMatchObject({ state: "already_applied", effectDispatched: false });
    const envelope = JSON.stringify(value(f.run("envelope")));
    expect(envelope).toContain("NEW_B2_WORK_SENTINEL"); expect(envelope).toContain("EARLY_FACT_SENTINEL");
    expect(await readFile(f.native.targetFile)).toEqual(before); expect(await f.dispatches()).toBe(`${f.request.effectId}\n`);
  } finally { await f.close(); }
}, 30000);
