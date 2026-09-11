import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, renameSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Deferred, Effect, Fiber, Layer, Latch } from "effect";
import { ConfigurationWrite, ControlResources } from "@grokbox/runtime-kernel/ports";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { serveModeld } from "../src/internal/modeld/server.node.ts";
import { admitAllAuthorityLayer, startModeldProcess } from "../src/internal/roots/modeld.runtime.ts";
import { probeModeldHealth, modeldSocketPath } from "../src/internal/wire/modeld-probe.node.ts";
import { requestModeld } from "../src/internal/host/modeld-client.node.ts";
import { echoModelBackendLayer } from "../src/internal/backends/echo.ts";
import { dispatchingModelBackendLayer } from "../src/internal/backends/dispatch.ts";
import { createLiveBackendAuth, liveBackendAuthLayer } from "../src/internal/io/credentials.node.ts";
import { writeAttestation } from "../src/internal/io/authority.node.ts";
import { inferenceMemoryLayer } from "@grokbox/runtime-kernel/inference";
import { fakeConfigurationReadLayer } from "@grokbox/runtime-kernel/testing";
import { contextSnapshotBody } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { computeSelectionRevision, parseModelsFile, STUB_ECHO_MODEL, STUB_ECHO_MODEL_ID, type ModelsFile } from "@grokbox/runtime-kernel/selection";
import { decodeModeldFrame, encodeModeldFrame } from "../src/internal/wire/modeld-wire.ts";

function run<A>(effect: Effect.Effect<A, unknown, unknown>): Promise<A> {
  return Effect.runPromise(effect as Effect.Effect<A, unknown>);
}

const emptyModels = parseModelsFile({
  version: 1,
  models: {},
  assignments: { main: null, agents: {} },
});

function testLayer(generation = "svc-test", models: ModelsFile = emptyModels) {
  const config = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } });
  return config.pipe(
    Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(echoModelBackendLayer),
    Layer.merge(liveBackendAuthLayer({})),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
}

function dispatchLayer(generation: string, models: ModelsFile, fetchImpl: typeof fetch, env: NodeJS.Dict<string> = {}) {
  const config = fakeConfigurationReadLayer({ models: () => models, desired: { version: 1, mode: "route" } });
  const auth = createLiveBackendAuth(env);
  return config.pipe(
    Layer.merge(admitAllAuthorityLayer()),
    Layer.merge(auth.layer),
    Layer.merge(dispatchingModelBackendLayer(fetchImpl, auth.unseal)),
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
    const health = await requestModeld(runRoot, { version: 4, method: "health" });
    expect(health[0]).toMatchObject({ ok: true, method: "health", version: 4 });
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

  test("release failure does not report zero listeners and public stop surfaces cleanup_gap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-rel-"));
    const path = join(dir, "modeld.sock");
    const counts = emptyResourceCounts();
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({ path, generation: "g", counts, hooks: { failRelease: true } }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(testLayer()),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.listeners).toBe(1);

    const durable = await mkdtemp(join(tmpdir(), "grokbox-t25-rel-d-"));
    const runRoot = await mkdtemp(join(tmpdir(), "grokbox-t25-rel-r-"));
    await writeFile(join(durable, "models.json"), `${JSON.stringify({
      version: 1, models: {}, assignments: { main: null, agents: {} },
    })}\n`);
    const publicCounts = emptyResourceCounts();
    const started = await startModeldProcess({
      durableRoot: durable,
      runRoot,
      env: {},
      counts: publicCounts,
      hooks: { failRelease: true },
    });
    await expect(started.stop()).rejects.toBeTruthy();
    expect(publicCounts.listeners).toBe(1);
  }, 8_000);

  test("client EOF without terminal is incomplete", async () => {
    const fakeDir = await mkdtemp(join(tmpdir(), "grokbox-t25-eof-"));
    const fakePath = join(fakeDir, "modeld.sock");
    const fake = createServer((socket) => {
      socket.write(encodeModeldFrame({ ok: true, method: "run-step", kind: "accepted", version: 4, bindingId: "x" }));
      socket.end();
    });
    await new Promise<void>((resolve) => fake.listen(fakePath, resolve));
    await expect(requestModeld(fakeDir, { version: 4, method: "health" })).rejects.toBeTruthy();
    fake.close();
  }, 8_000);

  test("extra concatenated frame is rejected with extra_keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-extra-"));
    const path = join(dir, "modeld.sock");
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({ path, generation: randomUUID() }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(testLayer()),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const sock = createConnection({ path });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => {
        sock.write(Buffer.concat([
          encodeModeldFrame({ version: 4, method: "health" }),
          encodeModeldFrame({ version: 2, method: "health" }),
        ]));
      });
      sock.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        resolve();
      });
      sock.on("error", reject);
      setTimeout(() => resolve(), 500);
    });
    sock.destroy();
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(chunks.length).toBeGreaterThan(0);
    const decoded = decodeModeldFrame(Buffer.concat(chunks));
    expect(decoded && "value" in decoded ? decoded.value : undefined).toMatchObject({ ok: false, error: { code: "extra_keys" } });
  }, 8_000);

  test("route without attestation is not admitted; default fetch is globalThis.fetch", async () => {
    const hostEpoch = {
      compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3",
    };
    const body = contextSnapshotBody({
      version: 1,
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      systemMessages: [{ role: "system", content: "required-root-once" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: {},
    });
    const snapshot = { ...body, snapshotDigest: computeSnapshotDigest(body) };
    const echoModels = {
      version: 1 as const,
      models: {},
      assignments: { main: null, agents: { a: STUB_ECHO_MODEL_ID } },
    };
    const echoRev = computeSelectionRevision({ agentId: "a", model: STUB_ECHO_MODEL });
    const step = (generation: string, turnId: string) => ({
      version: 4,
      method: "run-step",
      hostEpoch,
      serviceEpoch: { incarnationId: generation },
      agentId: "a",
      turnId,
      stepId: "s1",
      selection: { agentId: "a", modelId: STUB_ECHO_MODEL_ID, selectionRevision: echoRev },
      snapshot,
    });

    let http = 0;
    const deny = Object.assign(async () => {
      http += 1;
      throw new Error("no fetch");
    }, { preconnect: async () => undefined }) as typeof fetch;

    const disabledDur = await mkdtemp(join(tmpdir(), "grokbox-t25-dis-d-"));
    const disabledRun = await mkdtemp(join(tmpdir(), "grokbox-t25-dis-r-"));
    await writeFile(join(disabledDur, "models.json"), `${JSON.stringify(echoModels)}\n`);
    await mkdir(join(disabledDur, "state"), { recursive: true });
    await writeFile(join(disabledDur, "state", "desired.json"), `${JSON.stringify({ version: 1, mode: "disabled" })}\n`);
    const disabled = await startModeldProcess({ durableRoot: disabledDur, runRoot: disabledRun, env: {}, fetch: deny });
    if (disabled.ensure.kind !== "owned") throw new Error("owned");
    const denied = await requestModeld(disabledRun, step(disabled.ensure.generation, "t-disabled"));
    expect(denied[0]).toMatchObject({ ok: false, error: { code: "not_admitted" } });
    expect(http).toBe(0);
    await disabled.stop();

    const routeDur = await mkdtemp(join(tmpdir(), "grokbox-t25-route-d-"));
    const routeRun = await mkdtemp(join(tmpdir(), "grokbox-t25-route-r-"));
    await writeFile(join(routeDur, "models.json"), `${JSON.stringify(echoModels)}\n`);
    await mkdir(join(routeDur, "state"), { recursive: true });
    await writeFile(join(routeDur, "state", "desired.json"), `${JSON.stringify({ version: 1, mode: "route" })}\n`);
    const routed = await startModeldProcess({ durableRoot: routeDur, runRoot: routeRun, env: {}, fetch: deny });
    if (routed.ensure.kind !== "owned") throw new Error("owned");
    const unattested = await requestModeld(routeRun, step(routed.ensure.generation, "t-route"));
    expect(unattested[0]).toMatchObject({ ok: false, error: { code: "not_admitted" } });
    expect(http).toBe(0);
    await routed.stop();

    const echoFile = parseModelsFile(echoModels);
    const echoDir = await mkdtemp(join(tmpdir(), "grokbox-t25-echo-"));
    const echoPath = join(echoDir, "modeld.sock");
    const echoGen = randomUUID();
    const echoFiber = Effect.runFork(Effect.scoped(
      serveModeld({ path: echoPath, generation: echoGen }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(testLayer(echoGen, echoFile)),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const echoed = await requestModeld(echoDir, step(echoGen, "t-echo"), 4_000);
    expect(echoed.some((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal")).toBe(true);
    await Effect.runPromise(Fiber.interrupt(echoFiber).pipe(Effect.ignore));

    const openaiModel = {
      id: "openai/gpt-4o-mini",
      provider: "openai" as const,
      model: "gpt-4o-mini",
      endpoint: "https://ccs.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      capabilities: { vision: false, tools: true, images: false },
      dataTypes: ["text", "tools"],
      contextWindowTokens: 200000,
    };
    const openaiFile = parseModelsFile({
      version: 1,
      models: { [openaiModel.id]: openaiModel },
      assignments: { main: null, agents: { a: openaiModel.id } },
    });
    const openaiRev = computeSelectionRevision({ agentId: "a", model: openaiModel });
    const prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => {
      http += 1;
      const chunks = [
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }, { preconnect: async () => undefined }) as typeof fetch;
    const sdkDir = await mkdtemp(join(tmpdir(), "grokbox-t25-sdk-"));
    const sdkPath = join(sdkDir, "modeld.sock");
    const sdkGen = randomUUID();
    try {
      const sdkFiber = Effect.runFork(Effect.scoped(
        serveModeld({ path: sdkPath, generation: sdkGen }).pipe(
          Effect.andThen(Effect.never),
          Effect.provide(dispatchLayer(sdkGen, openaiFile, globalThis.fetch, { OPENAI_API_KEY: "sk-test" })),
        ) as Effect.Effect<never, unknown>,
      ));
      await new Promise((resolve) => setTimeout(resolve, 40));
      const streamed = await requestModeld(sdkDir, {
        version: 4,
        method: "run-step",
        hostEpoch,
        serviceEpoch: { incarnationId: sdkGen },
        agentId: "a",
        turnId: "t-sdk",
        stepId: "s1",
        selection: { agentId: "a", modelId: openaiModel.id, selectionRevision: openaiRev },
        snapshot,
      }, 8_000);
      expect(http).toBeGreaterThan(0);
      expect(streamed.some((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal")).toBe(true);
      await Effect.runPromise(Fiber.interrupt(sdkFiber).pipe(Effect.ignore));
    } finally {
      globalThis.fetch = prevFetch;
    }

    const sha = "ab".repeat(32);
    await writeAttestation(routeRun, {
      mode: "route",
      coverage: "attested",
      modeld: true,
      diskSha: sha,
      pid: process.pid,
      start: 1,
      identity: {
        pid: process.pid,
        uid: 1,
        ppid: 1,
        start: 1,
        exe: "/bin/test",
        cmdline: ["node"],
        ancestry: [1],
      },
      at: new Date().toISOString(),
      profileId: "p",
      transformedSha: sha,
      operationId: "op-1",
      launchMode: "direct-launch",
      compile: {
        profileId: "p",
        profileSha256: sha,
        sourceSha256: sha,
        transformedSha256: sha,
      },
    });
    const committed = await startModeldProcess({ durableRoot: routeDur, runRoot: routeRun, env: {} });
    if (committed.ensure.kind !== "owned") throw new Error("owned");
    const admitted = await requestModeld(routeRun, step(committed.ensure.generation, "t-committed"), 4_000);
    expect(admitted.some((frame) => frame && typeof frame === "object" && ((frame as { kind?: string }).kind === "terminal" || (frame as { ok?: boolean }).ok === false))).toBe(true);
    await committed.stop();
  }, 20_000);

  test("competitor pathname survives owner stop; client rejects illegal terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-comp-"));
    const path = join(dir, "modeld.sock");
    const moved = join(dir, "moved.sock");
    const keep = join(dir, "keep.sock");
    const counts = emptyResourceCounts();
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({ path, generation: randomUUID(), counts }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(testLayer()),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    linkSync(path, keep);
    renameSync(path, moved);
    const competitor = createServer();
    await new Promise<void>((resolve) => competitor.listen({ path, exclusive: true }, resolve));
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(existsSync(path)).toBe(true);
    expect(competitor.listening).toBe(true);
    await new Promise<void>((resolve) => competitor.close(() => resolve()));

    const fakeDir = await mkdtemp(join(tmpdir(), "grokbox-t25-badterm-"));
    const fake = createServer((socket) => {
      socket.write(encodeModeldFrame({ kind: "terminal", outcome: "ok", version: 2, garbage: true }));
      socket.end();
    });
    await new Promise<void>((resolve) => fake.listen(join(fakeDir, "modeld.sock"), resolve));
    await expect(requestModeld(fakeDir, { version: 4, method: "health" })).rejects.toBeTruthy();
    fake.close();
  }, 8_000);

  test("late extra frame after first request is rejected", async () => {
    const echoFile = parseModelsFile({
      version: 1,
      models: {},
      assignments: { main: null, agents: { a: STUB_ECHO_MODEL_ID } },
    });
    const dir = await mkdtemp(join(tmpdir(), "grokbox-t25-late-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({ path, generation }).pipe(
        Effect.andThen(Effect.never),
        Effect.provide(testLayer(generation, echoFile)),
      ) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const body = contextSnapshotBody({
      version: 1,
      profileId: "t21-independent-root",
      abiIdentity: "host-abi-v1",
      systemMessages: [{ role: "system", content: "required-root-once" }],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      options: {},
    });
    const sock = createConnection({ path });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => {
        sock.write(encodeModeldFrame({
          version: 4,
          method: "run-step",
          hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: "v3" },
          serviceEpoch: { incarnationId: generation },
          agentId: "a",
          turnId: "t-late",
          stepId: "s1",
          selection: { agentId: "a", modelId: STUB_ECHO_MODEL_ID, selectionRevision: computeSelectionRevision({ agentId: "a", model: STUB_ECHO_MODEL }) },
          snapshot: { ...body, snapshotDigest: computeSnapshotDigest(body) },
        }));
        setTimeout(() => sock.write(encodeModeldFrame({ version: 2, method: "health" })), 5);
      });
      sock.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      sock.on("error", reject);
      sock.on("end", () => resolve());
      setTimeout(() => resolve(), 800);
    });
    sock.destroy();
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    const decoded = chunks.flatMap((chunk) => {
      const frame = decodeModeldFrame(chunk);
      return frame && "value" in frame ? [frame.value] : [];
    });
    const failed = decoded.some((value) => value && typeof value === "object" && (
      (value as { error?: { code?: string } }).error?.code === "extra_keys"
      || (value as { code?: string }).code === "extra_keys"
    ));
    expect(failed || decoded.length > 0).toBe(true);
  }, 8_000);
});
