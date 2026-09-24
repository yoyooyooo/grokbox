import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { replaceModeld, stopModeld } from "../src/internal/roots/modeld-replace.node.ts";
import { Effect } from "effect";
import { WIRE_VERSION } from "@grokbox/runtime-kernel/contract";
import { acquireModeldStopFence } from "../src/internal/wire/modeld-stop-fence.node.ts";
import { createConnection } from "node:net";
import { decodeModeldFrame, encodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";
import { modeldRootId, probeModeldIdentity, probeModeldExecution, probeModeldReplacement } from "../src/internal/wire/modeld-probe.node.ts";

const node = "/usr/bin/node";
test("packed Node replaces only a fenced exact socket owner and exposes disk-backed admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "replace-modeld-"));
  const run = join(root, "run"), durable = join(root, "durable");
  await mkdir(run, { mode: 0o700 }); await mkdir(durable, { mode: 0o700 });
  const env = { ...process.env, HOME: root, GROKBOX_RUN_ROOT: run, GROKBOX_BOX_RUNTIME_ROOT: durable,
    GROKBOX_ALLOW_LIVE_HOST: "", GROKBOX_PATCH_PROFILE: "", NODE_OPTIONS: "" };
  const old = spawn(node, [resolve("dist/index.js"), "runtime", "modeld", "run", "--json"],
    { stdio: ["ignore", "pipe", "pipe"], env });
  let replacementPid: number | undefined;
  try {
    await new Promise<void>((resolve, reject) => { old.stdout.once("data", () => resolve()); old.once("error", reject); old.once("exit", () => reject(new Error("old fixture stopped"))); });
    const epoch = (await probeModeldIdentity(run, 1000))!.generation;
    const input = { durableRoot: durable, runRoot: run, expectedEpoch: epoch, entry: resolve("dist/index.js"),
      noManagedBotsRunning: true, confirmed: true, env };
    await expect(replaceModeld({ ...input, expectedEpoch: randomUUID() })).rejects.toThrow("identity");
    expect(await probeModeldReplacement(run, 1000)).toMatchObject({ generation: epoch, wireVersion: WIRE_VERSION });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(stopModeld({ ...input, signal: cancelled.signal })).rejects.toThrow();
    await expect(replaceModeld({ ...input, signal: cancelled.signal })).rejects.toThrow();
    expect(await probeModeldIdentity(run, 1000)).toMatchObject({ generation: epoch });
    // A connection accepted before the fence must still check admission when its
    // frame arrives. Holding an idle socket is not permission to start work.
    const queued = createConnection({ path: join(run, "modeld.sock") });
    await new Promise<void>(resolve => queued.once("connect", resolve));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fence = yield* acquireModeldStopFence(run, epoch, modeldRootId(durable, run));
      expect(fence.active()).toBe(true);
      expect(yield* Effect.promise(() => probeModeldExecution(run, 1000))).toMatchObject({ execution: { accepting: false, admission: "operator-fenced" } });
      for (const method of ["run-step", "maintain-context"]) {
        const peer = method === "run-step" ? queued : createConnection({ path: join(run, "modeld.sock") });
        const reply = yield* Effect.promise(() => new Promise<unknown>((resolve, reject) => {
          let buffer: Buffer = Buffer.alloc(0);
          peer.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); const frame = decodeModeldFrame(buffer);
            if (frame && !("error" in frame)) resolve(frame.value); });
          peer.on("error", reject);
          peer.write(encodeModeldFrame({ version: WIRE_VERSION, method }));
        }));
        peer.destroy();
        expect(reply).toMatchObject({ ok: false, error: { code: "busy" } });
      }
    })));
    for (let i = 0; i < 50 && !(await probeModeldExecution(run, 1000))?.execution.accepting; i++) await new Promise(r => setTimeout(r, 10));
    expect((await probeModeldExecution(run, 1000))?.execution.accepting).toBe(true);
    await expect(replaceModeld({ ...input, confirmed: false })).rejects.toThrow("confirmation");
    const result = await replaceModeld(input);
    replacementPid = result.pid;
    expect(result.replaced).toBe(true);
    expect(result.previousWireVersion).toBe(WIRE_VERSION);
    expect(result.serviceEpoch).not.toBe(epoch);
    expect(result.execution).toMatchObject({ accepting: true, lifetimeStepLimit: null, history: { kind: "leveldb" } });
    expect(result.oldRequestsReplayed).toBe(false);
    expect((await probeModeldExecution(run, 1000))?.generation).toBe(result.serviceEpoch);
    const stopInput = { ...input, expectedEpoch: result.serviceEpoch };
    await expect(stopModeld({ ...stopInput, expectedEpoch: epoch })).rejects.toThrow("identity");
    await expect(stopModeld({ ...stopInput, durableRoot: join(root, "other") })).rejects.toThrow("root");
    await expect(stopModeld({ ...stopInput, confirmed: false })).rejects.toThrow("confirmation");
    await expect(stopModeld({ ...stopInput, noManagedBotsRunning: false })).rejects.toThrow("idle");
    expect((await probeModeldExecution(run, 1000))?.generation).toBe(result.serviceEpoch);
    expect(await stopModeld(stopInput)).toMatchObject({ stopped: true, previousEpoch: result.serviceEpoch,
      previousPid: result.pid, socketAbsent: true, oldRequestsReplayed: false, historyPreserved: true });
    replacementPid = undefined;
    expect(await probeModeldReplacement(run, 200)).toBeNull();
    await expect(stopModeld(stopInput)).rejects.toThrow("identity");
  } finally {
    if (old.exitCode === null && old.signalCode === null) old.kill("SIGTERM");
    if (replacementPid) {
      process.kill(replacementPid, "SIGTERM");
      for (let i = 0; i < 50; i++) { if (!(await probeModeldIdentity(run, 100))) break; await new Promise(r => setTimeout(r, 20)); }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("operator stop refuses an exact modeld with active work without signaling it", async () => {
  const root = await mkdtemp(join(tmpdir(), "stop-active-modeld-"));
  const run = join(root, "run"), durable = join(root, "durable");
  await mkdir(run, { mode: 0o700 }); await mkdir(durable, { mode: 0o700 });
  const epoch = randomUUID();
  const owner = spawn(node, [join(import.meta.dir, "fixtures/old-modeld-process.mjs"), join(run, "modeld.sock"), epoch,
    modeldRootId(durable, run), "runtime", "modeld", "run"],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_ACTIVE_STEPS: "1" } });
  try {
    await new Promise<void>((resolve, reject) => {
      owner.stdout.once("data", () => resolve());
      owner.once("error", reject);
      owner.once("exit", () => reject(new Error("active fixture stopped")));
    });
    await expect(stopModeld({ durableRoot: durable, runRoot: run, expectedEpoch: epoch,
      noManagedBotsRunning: true, confirmed: true })).rejects.toThrow("active work");
    expect(await probeModeldReplacement(run, 1000)).toMatchObject({ generation: epoch, execution: { activeSteps: 1 } });
    expect(owner.exitCode).toBeNull();
    expect(owner.signalCode).toBeNull();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = new Promise<void>(resolve => owner.once("exit", () => resolve()));
      owner.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

for (const action of ["stop", "replace"] as const) test(`${action} cancellation at the final idle probe releases its fence without signaling or spawning`, async () => {
  const root = await mkdtemp(join(tmpdir(), "cancel-modeld-control-")), run = join(root, "run"), durable = join(root, "durable");
  await mkdir(run, { mode: 0o700 }); await mkdir(durable, { mode: 0o700 });
  const epoch = randomUUID();
  const owner = spawn(node, [join(import.meta.dir, "fixtures/old-modeld-process.mjs"), join(run, "modeld.sock"), epoch,
    modeldRootId(durable, run), "runtime", "modeld", "run"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TEST_WIRE_VERSION: String(WIRE_VERSION), TEST_FENCE_SUPPORT: "1", TEST_STOP_BARRIER: "1" },
  });
  try {
    await new Promise<void>((resolve, reject) => { owner.stdout!.once("data", () => resolve()); owner.once("error", reject); });
    const blocked = new Promise<void>(resolve => owner.once("message", () => resolve())), controller = new AbortController();
    const input = { durableRoot: durable, runRoot: run, expectedEpoch: epoch, confirmed: true, noManagedBotsRunning: true, signal: controller.signal };
    const pending = action === "stop" ? stopModeld(input) : replaceModeld({ ...input, entry: resolve("dist/index.js"), env: process.env });
    const failed = expect(pending).rejects.toThrow();
    await blocked; controller.abort(); owner.send("release"); await failed;
    for (let i = 0; i < 50 && !(await probeModeldExecution(run, 1000))?.execution.accepting; i++) await new Promise(r => setTimeout(r, 10));
    expect(await probeModeldExecution(run, 1000)).toMatchObject({ generation: epoch, execution: { accepting: true } });
    expect(owner.exitCode).toBeNull(); expect(owner.signalCode).toBeNull();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = new Promise<void>(resolve => owner.once("exit", () => resolve())); owner.kill("SIGTERM"); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("a legacy read-only idle observation never substitutes for the owner-side stop fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-modeld-stop-")), run = join(root, "run"), durable = join(root, "durable");
  await mkdir(run, { mode: 0o700 }); await mkdir(durable, { mode: 0o700 }); const epoch = randomUUID();
  const owner = spawn(node, [join(import.meta.dir, "fixtures/old-modeld-process.mjs"), join(run, "modeld.sock"), epoch,
    modeldRootId(durable, run), "runtime", "modeld", "run"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => { owner.stdout.once("data", () => resolve()); owner.once("error", reject); });
    expect(await probeModeldReplacement(run, 1000)).toMatchObject({ wireVersion: 4, generation: epoch });
    await expect(stopModeld({ durableRoot: durable, runRoot: run, expectedEpoch: epoch, confirmed: true, noManagedBotsRunning: true })).rejects.toThrow("fence");
    expect(owner.exitCode).toBeNull(); expect(owner.signalCode).toBeNull();
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = new Promise<void>(resolve => owner.once("exit", () => resolve())); owner.kill("SIGTERM"); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
