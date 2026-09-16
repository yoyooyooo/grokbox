import { expect, test } from "bun:test";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { openMonitorStore } from "../src/internal/io/monitor-store.node.ts";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

for (const phase of ["before", "after", "held"] as const) test(`real Node ${phase}-commit hard crash recovers without deleting locks or replaying effects`, async () => {
  const root = await mkdtemp(join(tmpdir(), "monitor-crash-owned-"));
  const scratch = resolve(".scratch"); await mkdir(scratch, { recursive: true });
  const buildDir = await mkdtemp(join(scratch, "monitor-crash-owned-")), outfile = join(buildDir, "worker.mjs");
  await build({ entryPoints: ["packages/box-runtime/test/fixtures/monitor-crash-node.ts"], outfile, bundle: true,
    platform: "node", target: "node20", format: "esm", external: ["sqlite3"], logLevel: "silent",
    banner: { js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);" } });
  const child = spawn("node", [outfile, root, phase], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root } });
  let stderr = ""; child.stderr.on("data", b => { stderr += b.toString(); });
  try {
    const receipt = await new Promise<{ epoch: string; pid: number }>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(Error(`owned fixture timeout: ${stderr}`)), 10_000);
      child.stdout.on("data", b => { text += b.toString(); if (text.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(text.split("\n")[0])); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(Error(`early owned fixture exit: ${stderr}`)); });
    });
    if (child.pid === undefined) throw new Error("synthetic fixture has no process identity");
    expect(receipt.pid).toBe(child.pid);
    const store = openMonitorStore(root);
    if (phase === "held") await expect(store.begin(randomUUID(), Date.now(), [AGENT])).rejects.toThrow("monitor_already_running");
    // This PID is the synthetic process just spawned by this test, never Host/modeld.
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const next = randomUUID(); expect((await store.begin(next, Date.now(), [AGENT])).gap).toBe(true);
    expect((await store.snapshot()).collectorEpoch).toBe(next);
    if (phase === "after") {
      expect((await store.evidenceCursor("b".repeat(64)))?.cursor).toBe("after-crash-record");
      expect((await store.incidents()).filter(x => x.rule === "execution_failure")).toHaveLength(1);
      expect((await store.events()).entries.filter(e => e.kind === "notification_decided")).toHaveLength(1);
    } else {
      expect(await store.evidenceCursor("b".repeat(64))).toBeNull();
      expect(await store.incidents()).toEqual([]);
    }
    await store.finish(next, Date.now());
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    await rm(root, { recursive: true, force: true }); await rm(buildDir, { recursive: true, force: true });
  }
}, 20_000);
