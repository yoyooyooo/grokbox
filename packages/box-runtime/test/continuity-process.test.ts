import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
import { CONT_AGENT, CONT_POLICY, CONT_SCOPE } from "./fixtures/continuity-material.ts";

const repository = resolve(import.meta.dir, "../../.."), worker = join(import.meta.dir, "fixtures/continuity-process-worker.ts");
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "continuity-process-")), root = join(base, "durable");
  await mkdir(root, { mode: 0o700 }); await writeFile(join(root, "owned-test-marker"), "continuity-process-fixture", { mode: 0o600 });
  const store = openContinuityRecoveryStore({ durableRoot: root, scopeId: CONT_SCOPE }); await store.initialize();
  await symlink(join(repository, "node_modules"), join(base, "node_modules"), "dir");
  const path = join(base, "worker.mjs");
    await build({ absWorkingDir: repository, entryPoints: [worker], bundle: true, platform: "node", target: "node20", format: "esm", outfile: path,
      external: ["sqlite3", "classic-level"], banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" }, logLevel: "silent" });
  const command = process.env.GROKBOX_TEST_NODE ?? "node";
  const args = (mode: string, requestId: string, effectId?: string) => [path, mode, root, requestId, ...(effectId ? [effectId] : [])];
  const run = (mode: string, requestId: string, effectId?: string) => spawnSync(command, args(mode, requestId, effectId), {
    encoding: "utf8", timeout: 15000, cwd: base, env: { PATH: process.env.PATH, HOME: base, NODE_NO_WARNINGS: "1" } });
  return { root, base, store, run, command, args, close: () => rm(base, { recursive: true, force: true }) };
}
function value(result: ReturnType<typeof spawnSync>) {
  expect(result.error, String(result.stdout) + String(result.stderr)).toBeUndefined(); expect(result.status, String(result.stderr)).toBe(0);
  return JSON.parse(String(result.stdout));
}

// Multi-process guarantees are qualified on the product's Node runtime;
// continuity-store.test.ts independently exercises the source under pinned Bun.
test("packed Node: a fresh process consumes the same immutable material", async () => {
    const f = await fixture(); try {
      const request = randomUUID(), published = value(f.run("publish", request));
      const read = value(f.run("read", request));
      expect(read).toMatchObject({ state: "published", revision: published.reference.revision, nativeImportProven: false });
      expect(read.values).toContain("USER_FACT:process-state");
      expect(value(f.run("publish", request))).toMatchObject({ duplicate: true, reference: published.reference });
    } finally { await f.close(); }
  }, 30000);

for (const mode of ["crash-reservation", "crash-after-objects", "crash-before-commit"] as const) {
  test(`owned SIGKILL at ${mode}: GET never manufactures success, explicit reconciliation uses persisted intent`, async () => {
    const f = await fixture(); try {
      const request = randomUUID(), result = f.run(mode, request);
      expect(result.signal).toBe("SIGKILL"); expect(result.status).toBeNull();
      const recovery = value(f.run("reconcile", request));
      expect(recovery.state).toBe(mode === "crash-reservation" ? "reserved" : "published");
      if (mode !== "crash-reservation") expect(value(f.run("read", request)).values).toContain("USER_FACT:process-state");
      else await expect(f.store.readSnapshot(request)).rejects.toThrow("continuity_not_found");
    } finally { await f.close(); }
  }, 30000);
}

for (const mode of ["crash-claim", "crash-after-effect"] as const) {
  test(`owned SIGKILL at ${mode}: a new process cannot repeat the effect`, async () => {
    const f = await fixture(); try {
      const operationId = randomUUID(), effectId = randomUUID();
      await f.store.prepareEffect({ operationId, agentId: CONT_AGENT, kind: "create", inputDigest: "d".repeat(64), policyRevision: CONT_POLICY, snapshotId: null });
      const result = f.run(mode, operationId, effectId); expect(result.signal).toBe("SIGKILL");
      expect(value(f.run("claim", operationId, effectId))).toMatchObject({ state: "effect_unknown", dispatch: false });
      const lines = await readFile(join(f.root, "owned-effects.log"), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
      expect(lines).toBe(mode === "crash-claim" ? "" : `${effectId}\n`);
    } finally { await f.close(); }
  }, 30000);
}

test("independent Node contenders obtain exactly one local dispatch claim", async () => {
  const f = await fixture(); const children: ReturnType<typeof spawn>[] = [];
  try {
    const operationId = randomUUID(), effectId = randomUUID();
    await f.store.prepareEffect({ operationId, agentId: CONT_AGENT, kind: "create", inputDigest: "e".repeat(64), policyRevision: CONT_POLICY, snapshotId: null });
    const replies = await Promise.all(Array.from({ length: 4 }, () => new Promise<{ dispatch: boolean }>((accept, reject) => {
      const child = spawn(f.command, f.args("claim", operationId, effectId), { cwd: f.base, env: { PATH: process.env.PATH, HOME: f.base, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child); let out = "", error = ""; const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.stdout!.on("data", chunk => { out += chunk; }); child.stderr!.on("data", chunk => { error += chunk; });
      child.on("error", e => { clearTimeout(timeout); reject(e); });
      child.on("close", code => { clearTimeout(timeout); if (code !== 0) reject(Error(`owned child failed: ${error}`)); else { try { accept(JSON.parse(out)); } catch (e) { reject(e); } } });
    })));
    expect(replies.filter(r => r.dispatch)).toHaveLength(1);
    expect(await readFile(join(f.root, "owned-effects.log"), "utf8")).toBe(`${effectId}\n`);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await f.close();
  }
}, 30000);
