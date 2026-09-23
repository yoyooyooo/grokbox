import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIRE_VERSION, REQUEST_WALL_DEADLINE_MS } from "@grokbox/runtime-kernel/contract";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { BackendFailure, contextSnapshotBody, type InferenceEvent } from "@grokbox/runtime-kernel/contract";
import { computeSnapshotDigest } from "@grokbox/runtime-kernel/hash";
import { inferenceMemoryLayer, memoryExecutionHistory, type ExecutionHistory } from "@grokbox/runtime-kernel/inference";
import { captureManagedSelection, parseModelsFile } from "@grokbox/runtime-kernel/selection";
import {
  createCountedSeams,
  fakeAdmissionAuthorityLayer,
  fakeBackendAuthLayer,
  fakeConfigurationReadLayer,
  fakeModelBackendLayer,
} from "@grokbox/runtime-kernel/testing";
import { serveModeld, readOneFrame, type Incoming } from "../src/internal/modeld/server.node.ts";
import { COMPACT_RESUME_RESERVE_MS, compactWaitBudget, sameConnectionHostCompactLayer } from "../src/internal/modeld/same-connection-compact.ts";
import { emptyResourceCounts } from "../src/internal/modeld/unix-listen.node.ts";
import { acceptModeldFrame, clientSessionFor, decodeModeldFrame, encodeModeldFrame, parseV4ControlFrame, MODELD_MAX_FRAME } from "../src/internal/wire/modeld-wire.ts";

const EVENTS: InferenceEvent[] = [
  { type: "text_delta", text: "ok" },
  { type: "backend_finish", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } },
];

const overflow = new BackendFailure("overflow_candidate", {
  overflowCandidate: true,
  overflowEvidence: { providerCode: "context_length_exceeded", httpStatus: 400 },
});

function file() {
  return parseModelsFile({
    version: 3,
    models: {
      "openai/gpt": {
        provider: "openai",
        model: "gpt",
        endpoint: "https://api.example.test/v1",
        apiKeyRef: "env:KEY",
        capabilities: { vision: false, tools: true, images: false },
        dataTypes: ["text", "tools"],
        contextWindowTokens: 200000,
      },
    },
    assignments: { main: null, agents: { a: { modelId: "openai/gpt" } } },
  });
}

function snapshot(text: string) {
  const body = contextSnapshotBody({
    version: 1,
    profileId: "p",
    abiIdentity: "abi",
    systemMessages: [{ role: "system", content: "r" }],
    messages: [{ role: "user", content: text }],
    tools: [],
    options: {},
  });
  return { ...body, snapshotDigest: computeSnapshotDigest(body) };
}

function stepBody(generation: string) {
  const models = file();
  const captured = captureManagedSelection(models, "a");
  if (captured.kind !== "managed") throw new Error("managed");
  return {
    version: WIRE_VERSION,
    method: "run-step",
    hostEpoch: { compile: "c", source: "s", profile: "p", hostIdentity: "h", bridgeDigest: "b", wireVersion: `v${WIRE_VERSION}` },
    serviceEpoch: { incarnationId: generation },
    agentId: "a",
    turnId: "t-v4",
    stepId: "step-1",
    selection: { agentId: "a", modelId: captured.modelId, selectionRevision: captured.selectionRevision },
    snapshot: snapshot("hi"),
  };
}

async function drive(path: string, body: unknown, resume: (control: ReturnType<typeof parseV4ControlFrame>) => unknown, resumeDelayMs = 0) {
  return await new Promise<unknown[]>((resolve, reject) => {
    const socket = createConnection({ path });
    let session = clientSessionFor(body);
    const frames: unknown[] = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timeout")), 8_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(frames);
    };
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame(body)); }
      catch (error) { finish(error instanceof Error ? error : new Error("write")); }
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (!settled) {
        const decoded = decodeModeldFrame(buf);
        if (decoded == null) break;
        if ("error" in decoded) {
          finish(new Error(decoded.error));
          return;
        }
        buf = Buffer.from(decoded.rest);
        try {
          const next = acceptModeldFrame(session, decoded.value);
          session = next.session;
          if (next.control) {
            const frame = encodeModeldFrame(resume(next.control));
            if (resumeDelayMs > 0) setTimeout(() => { if (!settled) socket.write(frame); }, resumeDelayMs);
            else socket.write(frame);
            continue;
          }
          frames.push(decoded.value);
          if (next.done) {
            finish();
            return;
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error("malformed"));
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => { if (!settled) finish(new Error("incomplete")); });
  });
}

describe("same-connection v4 HostCompact adapter", () => {
  test("compact-request then matching resume-step yields one attempt1 terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-compact-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: sameConnectionHostCompactLayer,
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const compacted = snapshot("compacted");
    const frames = await drive(path, stepBody(generation), (control) => {
      expect(control.method).toBe("compact-request");
      if (control.method !== "compact-request") throw new Error("compact");
      return {
        version: WIRE_VERSION,
        method: "resume-step",
        agentId: control.agentId,
        turnId: control.turnId,
        stepId: control.stepId,
        bindingId: control.bindingId,
        selectionRevision: control.selectionRevision,
        recoveryNonce: control.recoveryNonce,
        snapshot: compacted,
      };
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(2);
    expect(frames.some((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal")).toBe(true);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string };
    expect(terminal.outcome).toBe("ok");
    expect(frames.filter((frame) => frame && typeof frame === "object" && (frame as { method?: string }).method === "compact-request")).toHaveLength(0);
  });

  test("wrong nonce resume does not start attempt1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-nonce-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: sameConnectionHostCompactLayer,
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = await drive(path, stepBody(generation), (control) => {
      if (control.method !== "compact-request") throw new Error("compact");
      return {
        version: WIRE_VERSION,
        method: "resume-step",
        agentId: control.agentId,
        turnId: control.turnId,
        stepId: control.stepId,
        bindingId: control.bindingId,
        selectionRevision: control.selectionRevision,
        recoveryNonce: "wrong-nonce",
        snapshot: snapshot("compacted"),
      };
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(1);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string; code?: string };
    expect(terminal.outcome).toBe("error");
  });

  test("no resume within the remaining parent budget is overflow, not attempt1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-compact-wait-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(
      serveModeld({
        path,
        generation,
        compactForIncoming: (incoming) => sameConnectionHostCompactLayer(incoming, {
          remainingMs: () => COMPACT_RESUME_RESERVE_MS + 80,
        }),
      }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>,
    ));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frames = await new Promise<unknown[]>((resolve, reject) => {
      const socket = createConnection({ path });
      const body = stepBody(generation);
      let session = clientSessionFor(body);
      const collected: unknown[] = [];
      let buf = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error("timeout")), 3_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(collected);
      };
      socket.on("connect", () => {
        try { socket.write(encodeModeldFrame(body)); }
        catch (error) { finish(error instanceof Error ? error : new Error("write")); }
      });
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (!settled) {
          const decoded = decodeModeldFrame(buf);
          if (decoded == null) break;
          if ("error" in decoded) {
            finish(new Error(decoded.error));
            return;
          }
          buf = Buffer.from(decoded.rest);
          try {
            const next = acceptModeldFrame(session, decoded.value);
            session = next.session;
            if (next.control) continue;
            collected.push(decoded.value);
            if (next.done) {
              finish();
              return;
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error("malformed"));
            return;
          }
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => { if (!settled) finish(new Error("incomplete")); });
    });
    await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(counts.network).toBe(1);
    const terminal = frames.find((frame) => frame && typeof frame === "object" && (frame as { kind?: string }).kind === "terminal") as { outcome?: string };
    expect(terminal.outcome).toBe("error");
  }, 4_000);

  test("budget reserves attempt1 and never grants a fresh or infinite parent lifetime", () => {
    expect(compactWaitBudget(30_000)).toBe(25_000);
    expect(compactWaitBudget(10_000)).toBe(5_000);
    expect(compactWaitBudget(5_000)).toBe(0);
    expect(compactWaitBudget(-1)).toBe(0);
    expect(compactWaitBudget(Infinity)).toBe(0);
    expect(compactWaitBudget(90_000)).toBe(85_000);
    expect(compactWaitBudget(REQUEST_WALL_DEADLINE_MS + 90_000)).toBe(REQUEST_WALL_DEADLINE_MS - COMPACT_RESUME_RESERVE_MS);
  });

  test("summary slower than the old 5s wait can resume within its parent budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbox-v4-slow-compact-"));
    const path = join(dir, "modeld.sock");
    const generation = randomUUID();
    const counts = createCountedSeams();
    const layer = fakeBackendAuthLayer("secret", counts).pipe(
      Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
      Layer.merge(fakeConfigurationReadLayer({ models: file })),
      Layer.merge(fakeAdmissionAuthorityLayer()),
      Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
    );
    const fiber = Effect.runFork(Effect.scoped(serveModeld({
      path, generation, compactForIncoming: sameConnectionHostCompactLayer,
    }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>));
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const frames = await drive(path, stepBody(generation), (control) => {
        if (control.method !== "compact-request") throw new Error("compact");
        expect(control.deadlineMs).toBeGreaterThan(5_000);
        expect(control.deadlineMs).toBeLessThanOrEqual(REQUEST_WALL_DEADLINE_MS - COMPACT_RESUME_RESERVE_MS);
        return { ...control, version: WIRE_VERSION, method: "resume-step", deadlineMs: undefined, snapshot: snapshot("compacted") };
      }, 5_100);
      expect(counts.network).toBe(2);
      expect(frames.filter((f) => f && typeof f === "object" && (f as { kind?: string }).kind === "terminal")).toHaveLength(1);
      expect(frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "ok" });
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    }
  }, 9_000);
});


for (const delayMs of [170_000, 176_000]) test(`compact control consumes the original STEP clock after ${delayMs}ms of claim`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-compact-clock-")), path = join(dir, "modeld.sock");
  const generation = randomUUID(), counts = createCountedSeams(), resources = emptyResourceCounts();
  const entered = Deferred.makeUnsafe<void>();
  const history = memoryExecutionHistory();
  let firstClaim = true;
  const store: ExecutionHistory = { ...history, putIdentity: value => Effect.gen(function* () {
    if (firstClaim) {
      firstClaim = false;
      yield* Deferred.succeed(entered, undefined);
      yield* Effect.sleep(`${delayMs} millis`);
    }
    yield* history.putIdentity(value);
  }) };
  const layer = fakeBackendAuthLayer("secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
    Layer.merge(fakeConfigurationReadLayer({ models: file })),
    Layer.merge(fakeAdmissionAuthorityLayer()),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation, history: store })),
  );
  const controls: number[] = [];
  try {
    const frames = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      yield* serveModeld({ path, generation, counts: resources, compactForIncoming: sameConnectionHostCompactLayer });
      const reader = yield* Effect.forkChild(Effect.tryPromise(() => drive(path, stepBody(generation), control => {
        if (control.method !== "compact-request") throw Error("expected_compact");
        controls.push(control.deadlineMs);
        return { ...control, version: WIRE_VERSION, method: "resume-step", deadlineMs: undefined, snapshot: snapshot("short") };
      })));
      yield* Deferred.await(entered);
      yield* TestClock.adjust(`${delayMs} millis`);
      return yield* Fiber.join(reader);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))));
    expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
    expect(counts.leasesAlive).toBe(0);
    if (delayMs < REQUEST_WALL_DEADLINE_MS - COMPACT_RESUME_RESERVE_MS) {
      expect(controls).toHaveLength(1);
      expect(controls[0]).toBeGreaterThan(0);
      expect(controls[0]).toBeLessThanOrEqual(REQUEST_WALL_DEADLINE_MS - delayMs - COMPACT_RESUME_RESERVE_MS);
      expect(counts.network).toBe(2);
      expect(frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "ok" });
    } else {
      expect(controls).toEqual([]);
      expect(counts.network).toBe(1);
      expect(frames.at(-1)).toMatchObject({ kind: "terminal", outcome: "error" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10_000);

for (const event of ["end", "close", "error"] as const) test(`frame wait joins peer ${event} without using the timer`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-frame-eof-")), path = join(dir, "test.sock");
  let accepted!: (socket: Socket) => void;
  const connected = new Promise<Socket>(resolve => { accepted = resolve; });
  const server = createServer(accepted); let peer: Socket | undefined, client: Socket | undefined;
  const controller = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    client = createConnection(path); client.on("error", () => undefined); peer = await connected;
    // Synthetic peer events are delivered on a real fixture socket. This tests
    // the exported reader's listener lifetime without modeld's outer race.
    const incoming: Incoming = { socket: peer, buf: Buffer.alloc(0), consumed: true, extra: false, overflow: false, awaitingResume: true };
    const before = Object.fromEntries(["data", "end", "close", "error"].map(name => [name, peer!.listenerCount(name)]));
    const wait = Effect.runPromise(Effect.result(readOneFrame(incoming, 5000)), { signal: controller.signal })
      .catch(() => ({ _tag: "Failure" as const, failure: new Error("parent_interrupted") }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const emergency = setTimeout(() => controller.abort(), 100);
    // Node requires an error listener for emit(error); the fallback merely
    // avoids process-level failure when the original reader has no listener.
    const swallow = () => undefined; if (event === "error") peer.on("error", swallow);
    peer.emit(event, ...(event === "error" ? [new Error("fixture peer error")] : []));
    let result;
    try { result = await wait; } finally { clearTimeout(emergency); peer.off("error", swallow); }
    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure.message : "success").toBe("disconnected");
    expect(controller.signal.aborted).toBe(false);
    for (const name of ["data", "end", "close", "error"]) expect(peer.listenerCount(name)).toBe(before[name]);
  } finally {
    controller.abort(); client?.destroy(); peer?.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);


test("real peer EOF during compact settles the STEP and clears resume ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-compact-peer-eof-")), path = join(dir, "modeld.sock");
  const generation = randomUUID(), counts = createCountedSeams(), resources = emptyResourceCounts();
  let incoming: Incoming | undefined, controls = 0;
  const outcomes: Array<{ outcome: string; execution?: { activeSteps: number } }> = [];
  const layer = fakeBackendAuthLayer("secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
    Layer.merge(fakeConfigurationReadLayer({ models: file })), Layer.merge(fakeAdmissionAuthorityLayer()),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
  const fiber = Effect.runFork(Effect.scoped(serveModeld({ path, generation, counts: resources,
    compactForIncoming: (value, budget) => { incoming = value; return sameConnectionHostCompactLayer(value, budget); },
    observeStep: (_request, outcome) => Effect.sync(() => { outcomes.push(outcome); }),
  }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>));
  let client: Socket | undefined;
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise<void>((resolve, reject) => {
      const socket = client = createConnection(path); let buf = Buffer.alloc(0);
      const timer = setTimeout(() => { socket.destroy(); reject(Error("fixture_peer_timeout")); }, 2000);
      socket.once("connect", () => socket.write(encodeModeldFrame(stepBody(generation))));
      socket.on("error", reject);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const decoded = decodeModeldFrame(buf); if (!decoded) return;
          if ("error" in decoded) { reject(Error(decoded.error)); socket.destroy(); return; }
          buf = Buffer.from(decoded.rest);
          const frame = decoded.value as { method?: string };
          if (frame.method === "compact-request") { controls++; socket.end(); }
        }
      });
    });
    const until = performance.now() + 2000;
    while ((!outcomes.length || resources.fibers || resources.sockets) && performance.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(controls).toBe(1); expect(counts.network).toBe(1);
    expect(outcomes).toHaveLength(1); expect(outcomes[0]).toMatchObject({ outcome: "cancelled", execution: { activeSteps: 0 } });
    expect(incoming).toMatchObject({ consumed: true, awaitingResume: false });
    expect(resources).toMatchObject({ sockets: 0, fibers: 0 });
  } finally {
    client?.destroy(); await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 }); expect(counts.leasesAlive).toBe(0);
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);


for (const closed of [false, true]) test(`buffered complete frame survives peer EOF closed=${closed}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-buffered-eof-")), path = join(dir, "fixture.sock");
  let accept!: (socket: Socket) => void; const accepted = new Promise<Socket>(resolve => { accept = resolve; });
  const server = createServer({ allowHalfOpen: true }, accept);
  let client: Socket | undefined, peer: Socket | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    client = createConnection(path); client.on("error", () => undefined); peer = await accepted;
    const incoming: Incoming = { socket: peer, buf: Buffer.alloc(0), consumed: false, extra: false, overflow: false, awaitingResume: false };
    const buffer = (chunk: Buffer) => { incoming.buf = Buffer.concat([incoming.buf, chunk]); };
    peer.on("data", buffer);
    const ended = new Promise<void>(resolve => peer!.once("end", resolve));
    const value = { version: WIRE_VERSION, method: "health" };
    client.end(encodeModeldFrame(value)); await ended;
    expect(peer.readableEnded).toBe(true);
    if (closed) { peer.destroy(); expect(peer.destroyed).toBe(true); }
    const before = Object.fromEntries(["data", "end", "close", "error"].map(name => [name, peer!.listenerCount(name)]));
    const result = await Effect.runPromise(Effect.result(readOneFrame(incoming, 500)));
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") { expect(result.success.value).toEqual(value); expect(result.success.rest.length).toBe(0); }
    for (const name of ["data", "end", "close", "error"]) expect(peer.listenerCount(name)).toBe(before[name]);
    peer.off("data", buffer);
  } finally {
    client?.destroy(); peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 3000);

for (const delivery of ["socket-event", "wire"] as const) test(`oversized compact resume preserves capacity and settles once (${delivery})`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "modeld-resume-capacity-")), path = join(dir, "modeld.sock");
  const generation = randomUUID(), counts = createCountedSeams(), resources = emptyResourceCounts();
  let incoming: Incoming | undefined, controls = 0;
  const outcomes: Array<{ outcome: string; failureCode?: string; execution?: { activeSteps: number } }> = [];
  let listening!: () => void;
  const ready = new Promise<void>(resolve => { listening = resolve; });
  const layer = fakeBackendAuthLayer("secret", counts).pipe(
    Layer.merge(fakeModelBackendLayer(EVENTS, counts, { failFirst: overflow })),
    Layer.merge(fakeConfigurationReadLayer({ models: file })), Layer.merge(fakeAdmissionAuthorityLayer()),
    Layer.merge(inferenceMemoryLayer({ serviceEpoch: generation })),
  );
  const fiber = Effect.runFork(Effect.scoped(serveModeld({ path, generation, counts: resources,
    hooks: { afterListen: Effect.sync(listening) },
    compactForIncoming: (value, budget) => { incoming = value; return sameConnectionHostCompactLayer(value, budget); },
    observeStep: (_request, outcome) => Effect.sync(() => { outcomes.push(outcome); }),
  }).pipe(Effect.andThen(Effect.never), Effect.provide(layer)) as Effect.Effect<never, unknown>));
  let client: Socket | undefined;
  try {
    await ready;
    const frames = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const socket = client = createConnection(path);
      const frames: Array<Record<string, unknown>> = [];
      let buf = Buffer.alloc(0), settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(frames);
      };
      const timer = setTimeout(() => finish(Error("resume_capacity_timeout")), 3000);
      socket.once("connect", () => socket.write(encodeModeldFrame(stepBody(generation))));
      socket.on("error", error => finish(error));
      socket.once("close", () => finish());
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const decoded = decodeModeldFrame(buf); if (!decoded) return;
          if ("error" in decoded) { finish(Error(decoded.error)); return; }
          buf = Buffer.from(decoded.rest);
          const frame = decoded.value as Record<string, unknown>;
          frames.push(frame);
          if (frame.method === "compact-request") {
            controls++;
            // At most one bounded frame plus one byte. The event case fixes
            // chunk delivery deterministically on the real server socket; the
            // wire case additionally exercises actual Unix transport chunking.
            const raw = Buffer.alloc(MODELD_MAX_FRAME + 5, 0x20);
            raw.writeUInt32BE(MODELD_MAX_FRAME, 0);
            if (delivery === "socket-event") incoming!.socket.emit("data", raw);
            else socket.write(raw);
          }
        }
      });
    });
    expect(incoming?.overflow).toBe(true);
    expect(controls).toBe(1); expect(counts.network).toBe(1);
    expect(frames.filter(frame => frame.kind === "terminal")).toHaveLength(1);
    expect(frames.find(frame => frame.kind === "terminal")).toMatchObject({ outcome: "error", code: "capacity" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: "error", failureCode: "capacity", execution: { activeSteps: 0 } });
    expect(incoming).toMatchObject({ consumed: true, awaitingResume: false });
    expect(resources).toMatchObject({ sockets: 0, fibers: 0 });
    // Auth is pinned to the retained TURN, not the settled STEP. The service
    // owns that bounded cache and releases it on cooling or service shutdown.
    expect(counts.leasesAlive).toBe(1);
    // A new connection queries the same STEP identity, not a replacement task.
    const duplicate = await drive(path, stepBody(generation), () => { throw Error("unexpected_second_compact"); });
    expect(counts.network).toBe(1);
    expect(duplicate.at(-1)).toMatchObject({ kind: "terminal", outcome: "duplicate" });
  } finally {
    client?.destroy(); await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.ignore));
    expect(resources).toEqual({ listeners: 0, sockets: 0, fibers: 0 });
    expect(counts.leasesAlive).toBe(0);
    await rm(dir, { recursive: true, force: true });
  }
}, 8000);
