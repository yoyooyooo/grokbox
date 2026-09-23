import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Fiber } from "effect";
import { admitControllerRequest } from "@grokbox/runtime-kernel/commands";
import { ControlResources } from "@grokbox/runtime-kernel/ports";
import * as leases from "../src/internal/io/operation-lease.node.ts";
import { acquireAdvisoryGate } from "../src/internal/io/advisory-gate.node.ts";
import { liveControlResourcesLayer, recoverControllerOperationState } from "../src/internal/roots/controller-program.node.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixtureRoot() { const root = await fs.mkdtemp(join(tmpdir(), "grokbox-hcr-lifetime-")); roots.push(root); return root; }
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const paths = (root: string) => [join(root, "state", "controller-operations.lock"), join(root, "run", "ops", "identity.lock")];
const storePath = (root: string) => join(root, "state", "controller-operations.json");
function command(root: string) {
  const value = admitControllerRequest({ intent: "apply", confirmed: true, strategy: "direct", operationId: "lifetime-fixture", boxRoot: root });
  if (!value) throw new Error("invalid test command");
  return value;
}
async function interruptedRoot() {
  const root = await fixtureRoot();
  const exited = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/hcr-operation-owner.ts", import.meta.url)), root, "exit-after-publication"], {
    env: { PATH: process.env.PATH ?? "", HOME: root }, stdio: "ignore", timeout: 5000,
  });
  expect(exited.status).toBe(0);
  for (const path of paths(root)) expect((await leases.inspectOperationLease(path)).observation).toMatchObject({ state: "stale", format: "identity-v1", recoverable: true });
  const body = await fs.readFile(storePath(root), "utf8");
  return { root, body, input: { boxRoot: root, ephemeralRoot: join(root, "run"), confirm: true } };
}

linuxTest("interrupting a held production controller lease preserves unknown and releases both lock layers", async () => {
  const root = await fixtureRoot(), reached = barrier();
  const program = Effect.gen(function* () {
    const control = yield* ControlResources;
    expect(yield* control.lease(command(root))).toEqual({ status: "acquired" });
    yield* control.settle({ operationId: "lifetime-fixture", boxRoot: root, state: "running",
      prefix: { signaled: true, spawned: false, guardian: false } });
    yield* Effect.sync(reached.resolve);
    yield* Effect.never;
  }).pipe(Effect.provide(liveControlResourcesLayer()), Effect.scoped);
  const fiber = Effect.runFork(program);
  try {
    await reached.promise;
    const competitor = await leases.acquireOperationLease(paths(root)[0]!, "competitor");
    if (competitor.ok) await competitor.lock.release();
    expect(competitor.ok).toBe(false);
  } finally { await Effect.runPromise(Fiber.interrupt(fiber)); }
  const stored = JSON.parse(await fs.readFile(storePath(root), "utf8"));
  expect(stored["lifetime-fixture"]).toMatchObject({ state: "unknown", prefix: { signaled: true, spawned: false, guardian: false } });
  expect((await leases.inspectOperationLease(paths(root)[0]!)).observation.state).toBe("missing");
  const next = await leases.acquireOperationLease(paths(root)[0]!, "next-owner");
  expect(next.ok).toBe(true);
  if (next.ok) await next.lock.release();
});

linuxTest("cancellation during acquisition waits for the actual acquired descriptor before releasing it", async () => {
  const root = await fixtureRoot(), acquired = barrier(), release = barrier();
  const original = leases.acquireOperationLease;
  const spy = spyOn(leases, "acquireOperationLease").mockImplementation(async (...args) => {
    const result = await original(...args);
    acquired.resolve();
    await release.promise;
    return result;
  });
  const program = Effect.gen(function* () {
    const control = yield* ControlResources;
    yield* control.lease(command(root));
    yield* Effect.never;
  }).pipe(Effect.provide(liveControlResourcesLayer()), Effect.scoped);
  const fiber = Effect.runFork(program);
  let stopped = false;
  try {
    await acquired.promise;
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { stopped = true; });
    const competitor = await original(paths(root)[0]!, "competitor");
    if (competitor.ok) await competitor.lock.release();
    expect(competitor.ok).toBe(false);
    expect(stopped).toBe(false);
    release.resolve();
    await interrupt;
    expect((await leases.inspectOperationLease(paths(root)[0]!)).observation.state).toBe("missing");
    const body = await fs.readFile(storePath(root), "utf8").catch(error => { if (error.code === "ENOENT") return "{}"; throw error; });
    expect(JSON.parse(body)["lifetime-fixture"]?.state).not.toBe("running");
    const next = await original(paths(root)[0]!, "next-owner");
    expect(next.ok).toBe(true);
    if (next.ok) await next.lock.release();
  } finally { release.resolve(); await Effect.runPromise(Fiber.interrupt(fiber)); spy.mockRestore(); }
});

linuxTest("pre-cancelled recovery creates no gate and changes no owner or operation record", async () => {
  const f = await interruptedRoot();
  const before = await Promise.all(paths(f.root).map(path => fs.readFile(path, "utf8")));
  const gates = await Promise.all(paths(f.root).map(path => fs.stat(`${path}.gate`)));
  await expect(recoverControllerOperationState({ ...f.input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "invalid_usage" });
  expect(await fs.readFile(storePath(f.root), "utf8")).toBe(f.body);
  expect(await Promise.all(paths(f.root).map(path => fs.readFile(path, "utf8")))).toEqual(before);
  expect(await Promise.all(paths(f.root).map(path => fs.stat(`${path}.gate`)))).toEqual(gates);
});

linuxTest("cancellation while gathering recovery facts releases gates; a late read cannot mutate", async () => {
  const f = await interruptedRoot(), reached = barrier(), release = barrier(), abort = new AbortController();
  const original = leases.inspectOperationLease;
  const spy = spyOn(leases, "inspectOperationLease").mockImplementation(async path => {
    const result = await original(path);
    reached.resolve();
    await release.promise;
    return result;
  });
  const result = recoverControllerOperationState({ ...f.input, signal: abort.signal }).then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    await reached.promise;
    abort.abort();
    expect((await result).ok).toBe(false);
    expect(await fs.readFile(storePath(f.root), "utf8")).toBe(f.body);
    for (const path of paths(f.root)) {
      const gate = await acquireAdvisoryGate(`${path}.gate`);
      expect(gate).not.toBeNull();
      await gate?.release();
    }
    release.resolve();
  } finally { release.resolve(); spy.mockRestore(); await result; }
  for (const path of paths(f.root)) expect((await leases.inspectOperationLease(path)).observation.state).toBe("stale");
  expect(await recoverControllerOperationState(f.input)).toMatchObject({ outcome: "recovered", markedUnknown: 1, clearedLocks: 2 });
});

linuxTest("cancellation during metadata commit keeps both gates until pending unlinks settle", async () => {
  const f = await interruptedRoot(), reached = barrier(), release = barrier(), abort = new AbortController();
  const original = fs.unlink;
  const first = paths(f.root)[0]!;
  const spy = spyOn(fs, "unlink").mockImplementation(async path => {
    if (String(path) === first) { reached.resolve(); await release.promise; }
    await original(path);
  });
  let settled = false;
  const result = recoverControllerOperationState({ ...f.input, signal: abort.signal }).then(
    value => { settled = true; return { ok: true as const, value }; },
    error => { settled = true; return { ok: false as const, error }; });
  try {
    await reached.promise;
    expect(JSON.parse(await fs.readFile(storePath(f.root), "utf8"))["lifetime-fixture"].state).toBe("unknown");
    abort.abort();
    for (const path of paths(f.root)) {
      const competitor = await acquireAdvisoryGate(`${path}.gate`);
      await competitor?.release();
      expect(competitor).toBeNull();
    }
    expect(settled).toBe(false);
    release.resolve();
    await result;
  } finally { release.resolve(); await result; spy.mockRestore(); }
  expect(await recoverControllerOperationState(f.input)).toMatchObject({ outcome: "clear", operations: { running: 0, unknown: 1 } });
  const successor = await leases.acquireOperationLease(first, "successor");
  expect(successor.ok).toBe(true);
  if (successor.ok) {
    try { expect((await leases.inspectOperationLease(first)).owner).toEqual(successor.lock.owner); }
    finally { await successor.lock.release(); }
  }
});
