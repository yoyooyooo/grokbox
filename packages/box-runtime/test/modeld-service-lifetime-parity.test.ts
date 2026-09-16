import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { ensureModeld, startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { probeModeldHealth } from "../src/internal/wire/modeld-probe.node.ts";

const noFetch = Object.assign(async () => { throw new Error("external_network_forbidden"); },
  { preconnect: async () => undefined }) as typeof fetch;

for (const entry of ["effect", "promise"] as const) {
  test(`${entry} entry owns one listener while both entrypoints borrow and leave its lifetime intact`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gbox-root-parity-"));
    const counts = emptyResourceCounts();
    let allocations = 0;
    const listening = await Effect.runPromise(Deferred.make<void>());
    const options = { durableRoot: root, runRoot: root, env: {}, fetch: noFetch, counts,
      hooks: { afterAllocate: Effect.sync(() => { allocations++; }),
        afterListen: Deferred.succeed(listening, undefined).pipe(Effect.asVoid) } };
    let stop: (() => Promise<void>) | undefined;
    try {
      if (entry === "effect") {
        const fiber = Effect.runFork(Effect.scoped(ensureModeld(options)));
        stop = async () => { await Effect.runPromise(Fiber.interrupt(fiber)); };
      } else {
        const owner = await startModeldProcess(options);
        expect(owner.ensure.kind).toBe("owned");
        stop = () => owner.stop();
      }
      await Effect.runPromise(Deferred.await(listening).pipe(Effect.timeout("1 second")));
      const effectBorrow = await Effect.runPromise(Effect.scoped(ensureModeld(options)));
      const promiseBorrow = await startModeldProcess(options);
      expect(effectBorrow.kind).toBe("borrowed");
      expect(promiseBorrow.ensure.kind).toBe("borrowed");
      expect(typeof effectBorrow.generation).toBe("string");
      expect(effectBorrow.generation === promiseBorrow.ensure.generation).toBe(true);
      await promiseBorrow.stop();
      await promiseBorrow.finished;
      expect(allocations).toBe(1);
      expect(await probeModeldHealth(root, 500)).toBe(true);
      await stop();
      await stop();
      expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
      expect(existsSync(join(root, "modeld.sock"))).toBe(false);
    } finally { await stop?.(); await rm(root, { recursive: true, force: true }); }
  }, 5000);

  test(`${entry} entry rejects after-listen failure only after the same acquired resources are released`, async () => {
    const root = await mkdtemp(join(tmpdir(), "gbox-root-parity-failure-"));
    const counts = emptyResourceCounts();
    const options = { durableRoot: root, runRoot: root, env: {}, fetch: noFetch, counts,
      hooks: { failAfterListen: Effect.fail(new Error("fixture-after-listen")) } };
    try {
      if (entry === "effect") {
        const exit = await Effect.runPromise(Effect.exit(Effect.scoped(ensureModeld(options))));
        expect(exit._tag).toBe("Failure");
      } else {
        await expect(startModeldProcess(options)).rejects.toThrow("fixture-after-listen");
      }
      expect(counts).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
      expect(existsSync(join(root, "modeld.sock"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 5000);
}
