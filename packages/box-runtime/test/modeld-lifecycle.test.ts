import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Deferred, Effect, Fiber, Layer, Latch } from "effect";
import { ConfigurationWrite, ControlResources } from "@grokbox/runtime-kernel/ports";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { modeldRootLayer, startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { probeModeldHealth, modeldSocketPath } from "../src/internal/wire/modeld-probe.node.ts";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";
import { liveAdmissionAuthorityLayer } from "../src/internal/roots/modeld.runtime.ts";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { parseModelsFile, STUB_ECHO_MODEL_ID } from "@grokbox/runtime-kernel/selection";

function run<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>);
}

const emptyModels = parseModelsFile({
  version: 1,
  models: {},
  assignments: { main: null, agents: {} },
});

function testLayer(generation = "svc-test") {
  return fakeConfigurationReadLayer({ models: () => emptyModels }).pipe(
    Layer.merge(liveAdmissionAuthorityLayer()),
    Layer.merge(echoModelBackendLayer),
    Layer.merge(liveBackendAuthLayer({})),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
}

describe("modeld lifecycle", () => {
  test("interrupt after allocate before listen releases listener", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-alloc-"));
    const path = join(dir, "modeld.sock");
    const counts = emptyResourceCounts();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Latch.make(false));
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation: "g",
        counts,
        hooks: {
          afterAllocate: Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* gate.await;
          }),
        },
      }).pipe(Effect.provide(testLayer())),
    ));
    await Effect.runPromise(Deferred.await(entered));
    await Effect.runPromise(Fiber.interrupt(fiber));
    await Effect.runPromise(gate.open);
    expect(counts.listeners).toBe(0);
    expect(counts.sockets).toBe(0);
    expect(existsSync(path)).toBe(false);
  }, 8_000);

  test("listen then later failure still releases; competing path is not unlinked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-fail-"));
    const path = join(dir, "modeld.sock");
    const counts = emptyResourceCounts();
    await expect(run(Effect.scoped(
      serveModeld({
        path,
        generation: "g",
        counts,
        hooks: { failAfterListen: Effect.fail(new Error("after-listen")) },
      }).pipe(Effect.provide(testLayer())),
    ))).rejects.toBeTruthy();
    expect(counts.listeners).toBe(0);
    expect(existsSync(path)).toBe(false);

    const competitor = join(dir, "modeld.sock");
    await writeFile(competitor, "not-a-socket");
    await expect(startModeldProcess({
      durableRoot: dir,
      runRoot: dir,
      env: {},
    })).rejects.toBeTruthy();
    expect(existsSync(competitor)).toBe(true);
  }, 8_000);

  test("real unix process start/health/stop removes owned socket; borrowed does not stop", async () => {
    const durable = await mkdtemp(join(tmpdir(), "grokbox-t25-dur-"));
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-t25-run-"));
    await writeFile(join(durable, "models.json"), `${JSON.stringify({
      version: 1,
      models: {},
      assignments: { main: null, agents: { a: STUB_ECHO_MODEL_ID } },
    })}\n`);
    const counts = emptyResourceCounts();
    const started = await startModeldProcess({ durableRoot: durable, runRoot, env: {}, counts });
    expect(started.ensure.kind).toBe("owned");
    expect(await probeModeldHealth(runRoot, 500)).toBe(true);
    const health = await requestModeld(runRoot, { version: 3, method: "health" });
    expect(health[0]).toMatchObject({ ok: true, method: "health", version: 3 });
    const v2 = await requestModeld(runRoot, { version: 2, method: "health" });
    expect(v2[0]).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    const borrowed = await startModeldProcess({ durableRoot: durable, runRoot, env: {} });
    expect(borrowed.ensure.kind).toBe("borrowed");
    await borrowed.stop();
    expect(await probeModeldHealth(runRoot, 500)).toBe(true);
    await started.stop();
    expect(await probeModeldHealth(runRoot, 200)).toBe(false);
    expect(existsSync(modeldSocketPath(runRoot))).toBe(false);
    expect(counts.listeners).toBe(0);
    expect(counts.sockets).toBe(0);
  }, 8_000);

  test("modeld graph does not provide write or control capabilities", async () => {
    const ctx = await run(Effect.scoped(Layer.build(testLayer())));
    expect(Context.getOption(ctx, ConfigurationWrite)._tag).toBe("None");
    expect(Context.getOption(ctx, ControlResources)._tag).toBe("None");
  });
});
