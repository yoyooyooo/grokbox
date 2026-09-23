import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { nativeContinuityEnabled } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
const repository = resolve(import.meta.dir, "../../..");
async function fixture() {
  const node = process.env.GROKBOX_TEST_NATIVE_NODE;
  if (!node) throw Error("native_checkpoint_process_requires_explicit_node");
  const directory = await mkdtemp(join(tmpdir(), "native-continuity-process-"));
  await writeFile(join(directory, "owned-marker"), "native-checkpoint-node-test", { mode: 0o600 });
  await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
  const entry = join(directory, "worker.mjs"), requestId = randomUUID();
  await build({ absWorkingDir: repository, entryPoints: [join(import.meta.dir, "fixtures/native-checkpoint-process-worker.ts")],
    platform: "node", format: "esm", target: "node20", bundle: true, outfile: entry, external: ["sqlite3", "classic-level", "typescript"],
    banner: { js: "import {createRequire as __require} from 'node:module'; const require=__require(import.meta.url);" }, logLevel: "silent" });
  const run = (mode: "seed" | "install" | "readback") => spawnSync(node, [entry, directory, mode, requestId], {
    cwd: directory, encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, HOME: directory, GROKBOX_TEST_NATIVE_CONTINUITY: "1", NODE_NO_WARNINGS: "1" },
  });
  return { directory, run, close: () => rm(directory, { recursive: true, force: true }) };
}
function result(value: ReturnType<typeof spawnSync>) {
  expect(value.error, String(value.stderr)).toBeUndefined(); expect(value.status, String(value.stderr)).toBe(0);
  return JSON.parse(String(value.stdout));
}

// Executes selected original protobuf + AgentStore under Node, with real owned
// files/vault. No installed Host startup, native Bot, RPC or model side effects.
nativeTest("qualified original writer and a fresh Node reader retain the full native graph after source removal", async () => {
  const f = await fixture();
  try {
    const seeded = result(f.run("seed")); expect(seeded).toMatchObject({ state: "published", parts: 5, nativeImportProven: false });
    await rm(join(f.directory, "source"), { recursive: true });
    const installed = result(f.run("install"));
    const reopened = result(f.run("readback"));
    expect(installed.rootHash).toBe(seeded.sourceRootHash);
    expect(reopened).toMatchObject({ rootHash: installed.rootHash, nativeClosureReadBack: true, verifiedParts: 5,
      hasCurrent: true, hasSummary: true, hasArchivedInCurrentWindow: false,
      originalAgentLoopProven: false, activationAuthorized: false, providerDispatched: false, applicationMarkerProven: false });
  } finally { await f.close(); }
}, 120000);

nativeTest("fresh original reader cannot approve a target whose root remains valid but archive bytes changed", async () => {
  const f = await fixture();
  try {
    const seeded = result(f.run("seed")); result(f.run("install"));
    if (!/^[a-f0-9]{64}$/.test(seeded.archiveRef)) throw Error("owned_invalid_archive_id");
    // A valid empty proto does not match the saved archive, even though root
    // resetFromDb continues to succeed. No source/system data is touched.
    await writeFile(join(f.directory, "target", "blobs", seeded.archiveRef), new Uint8Array());
    const failed = f.run("readback"); expect(failed.error).toBeUndefined(); expect(failed.status).not.toBe(0);
    expect(String(failed.stderr)).toContain("material_invalid");
    expect(String(failed.stdout)).not.toContain('"nativeClosureReadBack":true');
  } finally { await f.close(); }
}, 120000);
