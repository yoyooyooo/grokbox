import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { runControllerOperation } from "@grokbox/runtime-kernel/commands";
import { emptyFakeControlCounts, fakeControlResourcesLayer } from "@grokbox/runtime-kernel/testing";
import type { ControllerRequest } from "@grokbox/runtime-kernel/ports";

function run(request: ControllerRequest, layer: ReturnType<typeof fakeControlResourcesLayer>) {
  return Effect.runPromise(runControllerOperation(request).pipe(Effect.provide(layer), Effect.scoped));
}

const apply: ControllerRequest = {
  intent: "apply",
  confirmed: true,
  operationId: "op-1",
  boxRoot: "/tmp/box",
  strategy: "direct",
};

describe("controller operation program", () => {
  test("unconfirmed apply and inspect intents never signal", async () => {
    const counts = emptyFakeControlCounts();
    const layer = fakeControlResourcesLayer({
      counts,
      preflight: { ok: true, reason: null, strategy: "direct" },
    });
    const refused = await run({ ...apply, confirmed: false }, layer);
    expect(refused).toMatchObject({ outcome: "refused", reason: "no-confirm", signaled: false, spawned: false, guardian: false });
    const preview = await run({ ...apply, intent: "preview", confirmed: false }, layer);
    expect(preview.outcome).toBe("preview");
    const reconcile = await run({ ...apply, intent: "reconcile", confirmed: false }, layer);
    expect(reconcile).toMatchObject({ outcome: "preview", signaled: false, spawned: false });
    expect(counts.signal).toBe(0);
    expect(counts.spawn).toBe(0);
    expect(counts.guardian).toBe(0);
  });

  test("missing preflight and failed recheck refuse with zero mutation", async () => {
    const counts = emptyFakeControlCounts();
    const missing = await run(apply, fakeControlResourcesLayer({
      counts,
      preflight: { ok: false, reason: "missing-source" },
    }));
    expect(missing).toMatchObject({ outcome: "refused", reason: "missing-source", signaled: false });
    const recheck = await run(apply, fakeControlResourcesLayer({
      counts,
      preflight: { ok: true, reason: null, strategy: "direct" },
      recheck: { ok: false, reason: "pid-reuse" },
    }));
    expect(recheck).toMatchObject({ outcome: "refused", reason: "pid-reuse", signaled: false });
    expect(counts.signal).toBe(0);
    expect(counts.spawn).toBe(0);
  });

  test("direct signals without spawn; transient spawns and arms guardian", async () => {
    const directCounts = emptyFakeControlCounts();
    const direct = await run(apply, fakeControlResourcesLayer({
      counts: directCounts,
      preflight: { ok: true, reason: null, strategy: "direct" },
    }));
    expect(direct).toMatchObject({ outcome: "signaled", signaled: true, spawned: false, guardian: false });
    expect(directCounts.signal).toBe(1);
    expect(directCounts.spawn).toBe(0);

    const transientCounts = emptyFakeControlCounts();
    const transient = await run({ ...apply, operationId: "op-t", strategy: "transient" }, fakeControlResourcesLayer({
      counts: transientCounts,
      preflight: { ok: true, reason: null, strategy: "transient" },
    }));
    expect(transient).toMatchObject({ outcome: "signaled", signaled: false, spawned: true, guardian: true });
    expect(transientCounts.signal).toBe(0);
    expect(transientCounts.spawn).toBe(1);
    expect(transientCounts.guardian).toBe(1);
  });

  test("duplicate operation identity does not signal twice; different request conflicts", async () => {
    const counts = emptyFakeControlCounts();
    const store = new Map();
    const layer = fakeControlResourcesLayer({
      counts,
      store,
      preflight: { ok: true, reason: null, strategy: "direct" },
    });
    const first = await run(apply, layer);
    const second = await run(apply, layer);
    expect(first.outcome).toBe("signaled");
    expect(second).toMatchObject({ outcome: "converged", reason: "duplicate-operation", signaled: false });
    expect(counts.signal).toBe(1);
    const otherRoot = await run({ ...apply, boxRoot: "/tmp/other" }, layer);
    expect(otherRoot.outcome).toBe("refused");
    expect(otherRoot.reason).toBe("operation-conflict");
    expect(counts.signal).toBe(1);
  });

  test("wait failure is unknown; retry does not signal again; reconcile does not invent converged", async () => {
    const counts = emptyFakeControlCounts();
    const store = new Map();
    const layer = fakeControlResourcesLayer({
      counts,
      store,
      preflight: { ok: true, reason: null, strategy: "direct" },
      wait: Effect.fail(new Error("wait-failed")),
    });
    const receipt = await run(apply, layer);
    expect(receipt).toMatchObject({ outcome: "unknown", reason: "wait-failed", signaled: true });
    expect(counts.commit).toBe(0);
    const retry = await run(apply, layer);
    expect(retry).toMatchObject({ outcome: "unknown", reason: "uncertain-operation", signaled: false });
    expect(counts.signal).toBe(1);
    const reconcile = await run({ ...apply, intent: "reconcile", confirmed: false }, layer);
    expect(reconcile.outcome).toBe("recovery-required");
    expect(reconcile.reason).toBe("uncertain-operation");
  });

  test("missing strategy does not default to direct", async () => {
    const counts = emptyFakeControlCounts();
    const receipt = await run({ ...apply, strategy: undefined }, fakeControlResourcesLayer({
      counts,
      preflight: { ok: true, reason: null },
    }));
    expect(receipt).toMatchObject({ outcome: "refused", reason: "missing-strategy", signaled: false });
    expect(counts.signal).toBe(0);
  });

  test("concurrent same-id is busy for the second waiter", async () => {
    const counts = emptyFakeControlCounts();
    const store = new Map();
    const gate = await Effect.runPromise(Deferred.make<void>());
    const layer = fakeControlResourcesLayer({
      counts,
      store,
      preflight: { ok: true, reason: null, strategy: "direct" },
      wait: Deferred.await(gate),
    });
    const first = Effect.runFork(runControllerOperation(apply).pipe(Effect.provide(layer), Effect.scoped));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await run(apply, layer);
    expect(second.reason).toBe("operation-busy");
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const done = await Effect.runPromise(Fiber.await(first));
    expect(done._tag).toBe("Success");
    expect(counts.signal).toBe(1);
  });
});
