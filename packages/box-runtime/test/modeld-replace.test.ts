import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replaceModeld } from "../src/internal/roots/modeld-replace.node.ts";
import { modeldRootId, probeModeldIdentity, probeModeldExecution, probeModeldReplacement } from "../src/internal/wire/modeld-probe.node.ts";

const node = "/usr/bin/node";
test("packed Node replaces only an exact old socket owner and exposes disk-backed admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "replace-modeld-"));
  const run = join(root, "run"), durable = join(root, "durable");
  await mkdir(run, { mode: 0o700 }); await mkdir(durable, { mode: 0o700 });
  const epoch = randomUUID();
  const old = spawn(node, [join(import.meta.dir, "fixtures/old-modeld-process.mjs"), join(run, "modeld.sock"), epoch,
    modeldRootId(durable, run), "runtime", "modeld", "run"], { stdio: ["ignore", "pipe", "pipe"] });
  let replacementPid: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => { old.stdout.once("data", () => resolve()); old.once("error", reject); old.once("exit", () => reject(new Error("old fixture stopped"))); });
    const input = { durableRoot: durable, runRoot: run, expectedEpoch: epoch, entry: resolve("dist/index.js"),
      noManagedBotsRunning: true, confirmed: true, env: { ...process.env, HOME: root, GROKBOX_ALLOW_LIVE_HOST: "", GROKBOX_PATCH_PROFILE: "", NODE_OPTIONS: "" } };
    await expect(replaceModeld({ ...input, expectedEpoch: randomUUID() })).rejects.toThrow("identity");
    expect(await probeModeldIdentity(run, 1000)).toBeNull(); // v4 cannot qualify v5 execution.
    expect(await probeModeldReplacement(run, 1000)).toMatchObject({ generation: epoch, wireVersion: 4 });
    await expect(replaceModeld({ ...input, confirmed: false })).rejects.toThrow("confirmation");
    const result = await replaceModeld(input);
    replacementPid = result.pid;
    expect(result.replaced).toBe(true);
    expect(result.previousWireVersion).toBe(4);
    expect(result.serviceEpoch).not.toBe(epoch);
    expect(result.execution).toMatchObject({ accepting: true, lifetimeStepLimit: null, history: { kind: "leveldb" } });
    expect(result.oldRequestsReplayed).toBe(false);
    expect((await probeModeldExecution(run, 1000))?.generation).toBe(result.serviceEpoch);
  } finally {
    if (old.exitCode === null && old.signalCode === null) old.kill("SIGTERM");
    if (replacementPid) {
      process.kill(replacementPid, "SIGTERM");
      for (let i = 0; i < 50; i++) { if (!(await probeModeldIdentity(run, 100))) break; await new Promise(r => setTimeout(r, 20)); }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
