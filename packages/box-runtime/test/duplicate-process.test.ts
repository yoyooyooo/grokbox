import { expect, test } from "bun:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openContinuityRecoveryStore } from "../src/runtime.ts";
const linuxTest = test.skipIf(process.platform !== "linux");
const repository = resolve(import.meta.dir, "../../..");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "duplicate-node-")), entry = join(root, "worker.mjs"), operationId = randomUUID();
  await writeFile(join(root, "owned-marker"), "grokbox-duplicate-process", { mode: 0o600 });
  await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  await build({ absWorkingDir: repository, entryPoints: [join(import.meta.dir, "fixtures/duplicate-process-worker.ts")], outfile: entry,
    platform: "node", target: "node20", format: "esm", bundle: true, external: ["sqlite3", "classic-level"],
    banner: { js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" }, logLevel: "silent" });
  await openContinuityRecoveryStore({ durableRoot: root, scopeId: "c".repeat(64) }).initialize();
  const command = (mode: string, id = operationId) => [entry, root, mode, id];
  const options = { cwd: root, env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: "1" } };
  const run = (mode: string, id = operationId) => spawnSync(process.env.GROKBOX_TEST_NODE ?? "node", command(mode, id), { ...options, encoding: "utf8", timeout: 20000 });
  return { root, run, command, options, close: () => rm(root, { recursive: true, force: true }),
    count: async () => (await readFile(join(root, "effects.log"), "utf8")).trim().split("\n").length };
}
function result(value: ReturnType<typeof spawnSync>) {
  expect(value.error, String(value.stderr)).toBeUndefined(); expect(value.status, String(value.stderr)).toBe(0);
  return JSON.parse(String(value.stdout));
}

linuxTest("Node process killed after the external create keeps unknown and never redispatches, including a new operation ID", async () => {
  const f = await fixture();
  try {
    const killed = f.run("kill-after-create"); expect(killed.signal).toBe("SIGKILL");
    expect(result(f.run("read"))).toMatchObject({ operation: { state: "effect_unknown" }, result: null });
    expect(result(f.run("run"))).toMatchObject({ nativeDispatched: false, operation: { state: "effect_unknown" } });
    const other = f.run("run", randomUUID()); expect(other.status).not.toBe(0); expect(String(other.stderr)).toContain("busy");
    expect(await f.count()).toBe(1);
  } finally { await f.close(); }
}, 90000);

linuxTest("Node process killed after the result commit retains exact target ID and does not recopy on restart", async () => {
  const f = await fixture();
  try {
    expect(f.run("kill-after-commit").signal).toBe("SIGKILL");
    expect(result(f.run("read"))).toMatchObject({ operation: { state: "succeeded" }, result: { targetAgentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    expect(result(f.run("run"))).toMatchObject({ nativeDispatched: false, targetCheckedNow: false });
    expect(await f.count()).toBe(1);
  } finally { await f.close(); }
}, 90000);

linuxTest("independent Node callers share one durable duplication claim", async () => {
  const f = await fixture();
  try {
    const replies = await Promise.all(Array.from({ length: 3 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.GROKBOX_TEST_NODE ?? "node", f.command("run"), { ...f.options, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 20000);
      child.stdout.on("data", data => { out += data; }); child.stderr.on("data", data => { err = (err + data).slice(-8192); });
      child.on("error", error => { clearTimeout(timeout); reject(error); });
      child.on("exit", code => { clearTimeout(timeout); if (code === 0) resolve(out); else reject(Error(err || "owned-process-failed")); });
    })));
    expect(replies.map(value => JSON.parse(value)).filter(value => value.nativeDispatched)).toHaveLength(1);
    expect(await f.count()).toBe(1);
  } finally { await f.close(); }
}, 90000);
