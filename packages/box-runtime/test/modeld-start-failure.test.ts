import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { OWNED_SHUTDOWN_MS } from "@grokbox/runtime-kernel/contract";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { startModeldProcess, type StartedModeld } from "../src/internal/roots/modeld.runtime.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

// The timeout is only the independent test oracle for a stuck public startup
// Promise. Production startup/cleanup semantics are exercised, not replaced.
async function settleWithin<T>(promise: Promise<T>, timeoutMs = 750) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(value => ({ kind: "resolved" as const, value }), error => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "hung" }>(resolve => { timer = setTimeout(() => resolve({ kind: "hung" }), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
const noFetch = Object.assign(async () => { throw new Error("external_network_forbidden"); },
  { preconnect: async () => undefined }) as typeof fetch;

for (const stage of ["after-allocate-defect", "after-listen-defect", "after-listen-error", "self-interrupt"] as const) {
  test(`public modeld start settles ${stage} after owned resources are released`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "gbox-start-failure-"));
    const counts = emptyResourceCounts();
    const release = { ok: true };
    let started: StartedModeld | undefined;
    try {
      const hooks = stage === "after-allocate-defect" ? { afterAllocate: Effect.die(new Error("owned-start-defect")) }
        : stage === "after-listen-defect" ? { failAfterListen: Effect.die(new Error("owned-start-defect")) }
        : stage === "after-listen-error" ? { failAfterListen: Effect.fail(new Error("owned-start-error")) }
        : { afterAllocate: Effect.interrupt };
      const pending = startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch, counts, hooks: { ...hooks, release } });
      const result = await settleWithin(pending);
      if (result.kind === "resolved") started = result.value;
      expect(result.kind).toBe("rejected");
      expect(release.ok).toBe(true);
      expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
      expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
    } finally {
      await started?.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 3000);
}

test("an already-aborted start never allocates an owned listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-start-aborted-"));
  const controller = new AbortController();
  controller.abort();
  let allocations = 0;
  const counts = emptyResourceCounts();
  let started: StartedModeld | undefined;
  try {
    const options = { durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch, signal: controller.signal, counts,
      hooks: { afterAllocate: Effect.sync(() => { allocations++; }) } };
    const result = await settleWithin(startModeldProcess(options));
    if (result.kind === "resolved") started = result.value;
    expect(result.kind).toBe("rejected");
    expect(allocations).toBe(0);
    expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
  } finally { await started?.stop(); await rm(dir, { recursive: true, force: true }); }
}, 3000);

test("caller abort during startup closes the allocated listener before rejection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-start-cancel-"));
  const controller = new AbortController();
  const entered = await Effect.runPromise(Deferred.make<void>());
  const held = await Effect.runPromise(Deferred.make<void>());
  const counts = emptyResourceCounts();
  const pending = startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch,
    ...{ signal: controller.signal }, counts, hooks: { afterAllocate: Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(held);
    }) } });
  try {
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("1 second")));
    controller.abort();
    const result = await settleWithin(pending);
    expect(result.kind).toBe("rejected");
    expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
    expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
  } finally {
    // Also release an old implementation that ignores caller cancellation, so
    // the red test does not leave an orphan listener in the shared test process.
    await Effect.runPromise(Deferred.succeed(held, undefined));
    const ending = await settleWithin(pending);
    if (ending.kind === "resolved") await ending.value.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 4000);

test("stop timeout remains a cleanup gap even without optional resource counters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-stop-deadline-"));
  const held = await Effect.runPromise(Deferred.make<void>());
  const finalizing = await Effect.runPromise(Deferred.make<void>());
  const started = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch,
    hooks: { afterListen: Effect.addFinalizer(() => Effect.gen(function* () {
      yield* Deferred.succeed(finalizing, undefined);
      yield* Deferred.await(held);
    })) } });
  try {
    const stopping = settleWithin(started.stop(), OWNED_SHUTDOWN_MS + 1000);
    await Effect.runPromise(Deferred.await(finalizing).pipe(Effect.timeout("1 second")));
    const result = await stopping;
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.error).toMatchObject({ message: "cleanup_gap" });
  } finally {
    await Effect.runPromise(Deferred.succeed(held, undefined));
    await started.stop();
    expect(existsSync(join(dir, "modeld.sock"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  }
}, OWNED_SHUTDOWN_MS + 3000);

test("borrowed startup cancellation never interrupts the separately owned modeld", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gbox-start-borrowed-"));
  const owner = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch });
  const controller = new AbortController();
  try {
    const borrowed = await startModeldProcess({ durableRoot: dir, runRoot: dir, env: {}, fetch: noFetch,
      ...{ signal: controller.signal } });
    expect(borrowed.ensure.kind).toBe("borrowed");
    controller.abort();
    await borrowed.stop();
    expect(await probeModeldHealth(dir, 500)).toBe(true);
  } finally { await owner.stop(); await rm(dir, { recursive: true, force: true }); }
}, 3000);
