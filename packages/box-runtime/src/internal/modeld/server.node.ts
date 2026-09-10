import type { Socket } from "node:net";
import { Cause, Deferred, Effect, Queue, Stream } from "effect";
import type { Layer } from "effect";
import {
  ADMISSION_WAIT_MS,
  BackendFailure,
  BindingFailure,
  CANONICAL_OUTPUT_MAX_BYTES,
  PARTIAL_SOCKET_MS,
  REQUEST_WALL_DEADLINE_MS,
  SERVER_ACTIVE_CLIENTS_MAX,
  WireError,
  type InferenceEvent,
  type RunStepRequest,
} from "@grokbox/runtime-kernel/contract";
import { cancelStep, runStep } from "@grokbox/runtime-kernel/inference";
import { decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME, parseV3Request } from "../wire/modeld-wire.ts";
import { acquireUnixListener, trackSocket, type ListenHooks, type ResourceCounts } from "./unix-listen.node.ts";
import { modeldFailureOutcome, type ModeldStepOutcome } from "./step-outcome.ts";

function errorFrame(code: string): unknown {
  return { ok: false, version: 3, error: { code } };
}

function mapFail(error: unknown): string {
  if (error instanceof BindingFailure) return error.code;
  if (error instanceof BackendFailure) return error.code;
  if (error instanceof WireError) return error.code;
  if (error && typeof error === "object" && "_tag" in error && String((error as { _tag: unknown })._tag).includes("Timeout")) {
    return "timeout";
  }
  return "provider_error";
}

function writable(socket: Socket): boolean {
  return !socket.destroyed && socket.writable;
}

export function writeFrame(socket: Socket, value: unknown): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume, signal) => {
    if (!writable(socket)) {
      resume(Effect.fail(new Error("disconnected")));
      return;
    }
    let buf: Buffer;
    try { buf = encodeModeldFrame(value); }
    catch (error) {
      resume(Effect.fail(error instanceof Error ? error : new Error("encode")));
      return;
    }
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.off("drain", onDrain);
      socket.off("error", onFail);
      socket.off("close", onFail);
      if (error) resume(Effect.fail(error));
      else resume(Effect.void);
    };
    const onDrain = () => finish();
    const onFail = () => finish(new Error("disconnected"));
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => finish(new Error("aborted")), { once: true });
    try {
      const ok = socket.write(buf);
      if (ok) finish();
      else {
        socket.once("drain", onDrain);
        socket.once("error", onFail);
        socket.once("close", onFail);
      }
    } catch {
      finish(new Error("disconnected"));
    }
  });
}

export type Incoming = {
  socket: Socket;
  buf: Buffer;
  consumed: boolean;
  extra: boolean;
  overflow: boolean;
  awaitingResume: boolean;
  onLate?: () => void;
};

function tryDecode(buf: Buffer): { value: unknown; rest: Buffer } | Error | null {
  const decoded = decodeModeldFrame(buf);
  if (decoded == null) return null;
  if ("error" in decoded) return new WireError("malformed_frame");
  return { value: decoded.value, rest: decoded.rest };
}

export function readOneFrame(incoming: Incoming, timeoutMs = PARTIAL_SOCKET_MS): Effect.Effect<{ value: unknown; rest: Buffer }, Error> {
  return Effect.callback<{ value: unknown; rest: Buffer }, Error>((resume, signal) => {
    const socket = incoming.socket;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("partial_socket")), timeoutMs);
    const finish = (error?: Error, value?: { value: unknown; rest: Buffer }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", check);
      if (error) resume(Effect.fail(error));
      else resume(Effect.succeed(value!));
    };
    const check = () => {
      if (incoming.overflow) {
        finish(new WireError("capacity"));
        return;
      }
      const decoded = tryDecode(incoming.buf);
      if (decoded == null) return;
      if (decoded instanceof Error) finish(decoded);
      else finish(undefined, decoded);
    };
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => finish(new Error("aborted")), { once: true });
    socket.on("data", check);
    check();
  });
}

function watchDisconnect(socket: Socket, onClose: () => void): void {
  const fire = () => onClose();
  socket.on("end", fire);
  socket.on("close", fire);
  socket.on("error", fire);
}

function emit(socket: Socket, value: unknown) {
  if (!writable(socket)) return Effect.void;
  return writeFrame(socket, value).pipe(Effect.ignore);
}

function handleRequest(incoming: Incoming, generation: string, value: unknown, extra: Buffer, options: ServeOptions) {
  const socket = incoming.socket;
  return Effect.gen(function* () {
    incoming.consumed = true;
    incoming.buf = Buffer.alloc(0);
    if (extra.length > 0) {
      yield* emit(socket, errorFrame("extra_keys"));
      return;
    }
    let parsed;
    try {
      parsed = parseV3Request(value);
    } catch (error) {
      yield* emit(socket, errorFrame(mapFail(error)));
      return;
    }
    if (parsed.method === "health") {
      yield* emit(socket, { ok: true, method: "health", version: 3, serverGeneration: generation });
      return;
    }
    if (parsed.method === "cancel-step") {
      const result = yield* Effect.result(cancelStep(parsed.request));
      if (result._tag === "Failure") {
        yield* emit(socket, errorFrame(mapFail(result.failure)));
        return;
      }
      yield* emit(socket, { ok: true, method: "cancel-step", version: 3 });
      return;
    }

    const request = parsed.request;
    const observeStep = options.observeStep;
    let observation: ModeldStepOutcome = { outcome: "unknown", phase: "admission", eventCount: 0 };
    yield* Effect.addFinalizer((exit) => {
      if (!observeStep) return Effect.void;
      if (exit._tag === "Failure") {
        const defect = Cause.hasDies(exit.cause);
        const interrupted = Cause.hasInterruptsOnly(exit.cause);
        observation = { ...observation, outcome: interrupted ? "cancelled" : "error", phase: "internal",
          failureCode: defect ? "defect" : interrupted ? "interrupted" : "unknown" };
      }
      return Effect.suspend(() => observeStep(request, observation)).pipe(
        Effect.interruptible, Effect.timeout("100 millis"), Effect.catchCause(() => Effect.void),
      );
    });
    const disconnected = yield* Deferred.make<void>();
    const late = yield* Deferred.make<void>();
    incoming.onLate = () => {
      void Effect.runPromise(Deferred.succeed(late, undefined).pipe(Effect.ignore));
    };
    if (incoming.extra || incoming.overflow) incoming.onLate();
    watchDisconnect(socket, () => {
      void Effect.runPromise(Deferred.succeed(disconnected, undefined).pipe(Effect.ignore));
    });

    const admitted = yield* Effect.result(
      runStep(parsed.request).pipe(Effect.timeout(`${ADMISSION_WAIT_MS} millis`)),
    );
    if (admitted._tag === "Failure") {
      observation = modeldFailureOutcome(admitted.failure, "admission", 0);
      yield* emit(socket, errorFrame(mapFail(admitted.failure)));
      return;
    }
    if (yield* Deferred.isDone(disconnected)) {
      observation = { ...observation, outcome: "cancelled", phase: "transport", failureCode: "disconnected" };
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
      return;
    }
    if (yield* Deferred.isDone(late)) {
      observation = { ...observation, outcome: "error", phase: "transport", failureCode: incoming.overflow ? "capacity" : "extra_keys" };
      yield* emit(socket, errorFrame(incoming.overflow ? "capacity" : "extra_keys"));
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
      return;
    }
    const step = admitted.success;
    observation = { ...observation, phase: "provider", bindingId: step.bindingId };
    yield* emit(socket, { ok: true, method: "run-step", kind: "accepted", version: 3, bindingId: step.bindingId });
    if (!("stream" in step)) {
      observation = { ...observation, outcome: "duplicate", phase: "complete" };
      yield* emit(socket, {
        kind: "terminal",
        outcome: "duplicate",
        snapshotDigest: "snapshotDigest" in step ? step.snapshotDigest : "",
        bindingId: step.bindingId,
      });
      return;
    }

    let sequence = 0;
    let outputBytes = 0;
    const halt = Effect.raceFirst(
      Deferred.await(disconnected).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled")))),
      Deferred.await(late).pipe(Effect.andThen(Effect.fail(new WireError(incoming.overflow ? "capacity" : "extra_keys")))),
    );
    const collected = yield* Effect.result(
      Stream.runForEach(
        Stream.interruptWhen(step.stream, halt),
        (event: InferenceEvent) => Effect.gen(function* () {
          const encoded = Buffer.byteLength(JSON.stringify(event), "utf8");
          outputBytes += encoded;
          if (outputBytes > CANONICAL_OUTPUT_MAX_BYTES) {
            return yield* Effect.fail(new BindingFailure("capacity"));
          }
          if (event.type === "backend_finish") {
            observation = { ...observation, outcome: event.finishReason === "stop" ? "ok" : event.finishReason === "abort" ? "cancelled" : "error", phase: "complete" };
            yield* emit(socket, {
              kind: "terminal",
              outcome: "ok",
              bindingId: step.bindingId,
              finishReason: event.finishReason,
              usage: event.usage,
            });
            return;
          }
          yield* emit(socket, { kind: "event", sequence, event });
          sequence += 1;
          observation.eventCount = sequence;
        }),
      ).pipe(Effect.timeout(`${REQUEST_WALL_DEADLINE_MS} millis`)),
    );
    if (yield* Deferred.isDone(disconnected)) {
      if (observation.phase !== "complete") observation = { ...observation, outcome: "cancelled", phase: "transport", failureCode: "disconnected" };
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
      return;
    }
    if (collected._tag === "Failure") {
      observation = { ...modeldFailureOutcome(collected.failure, "provider", sequence), bindingId: step.bindingId };
      yield* emit(socket, { kind: "terminal", outcome: "error", code: mapFail(collected.failure) });
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
    }
  });
}

export type ServeOptions = {
  observeStep?: (request: RunStepRequest, outcome: ModeldStepOutcome) => Effect.Effect<void, unknown>;
  compactForIncoming?: (incoming: Incoming) => Layer.Layer<import("@grokbox/runtime-kernel/ports").HostCompact>;
  path: string;
  generation: string;
  counts?: ResourceCounts;
  hooks?: ListenHooks;
  maxClients?: number;
};

export function serveModeld(options: ServeOptions) {
  return Effect.gen(function* () {
    const maxClients = options.maxClients ?? SERVER_ACTIVE_CLIENTS_MAX;
    const capacity = { clients: 0 };
    const live = new Set<Socket>();
    const incoming = yield* Queue.bounded<Incoming>(maxClients);
    const hooks = options.hooks ?? {};
    const listener = yield* acquireUnixListener(options.path, options.counts, {
      ...hooks,
      afterListen: undefined,
      failAfterListen: undefined,
      onConnection: (socket) => {
        live.add(socket);
        socket.once("close", () => live.delete(socket));
        if (capacity.clients >= maxClients) {
          socket.destroy();
          return;
        }
        capacity.clients += 1;
        if (options.counts) options.counts.sockets += 1;
        const held: Incoming = { socket, buf: Buffer.alloc(0), consumed: false, extra: false, overflow: false, awaitingResume: false };
        socket.on("data", (chunk: Buffer) => {
          if (held.awaitingResume) {
            if (held.buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
              held.overflow = true;
              held.buf = Buffer.alloc(0);
              return;
            }
            held.buf = Buffer.concat([held.buf, chunk]);
            return;
          }
          if (held.consumed) {
            held.extra = true;
            held.onLate?.();
            return;
          }
          if (held.buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
            held.overflow = true;
            held.buf = Buffer.alloc(0);
            held.onLate?.();
            return;
          }
          held.buf = Buffer.concat([held.buf, chunk]);
        });
        if (!Queue.offerUnsafe(incoming, held)) {
          capacity.clients -= 1;
          if (options.counts) options.counts.sockets = Math.max(0, options.counts.sockets - 1);
          socket.destroy();
        }
      },
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      for (const socket of live) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      live.clear();
    }));
    yield* Effect.forkChild(Effect.forever(Effect.gen(function* () {
      const raw = yield* Queue.take(incoming);
      if (options.counts) options.counts.fibers += 1;
      yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        const socket = yield* trackSocket(raw.socket, options.counts, capacity);
        const frame = yield* readOneFrame(raw);
        const handled = handleRequest(raw, options.generation, frame.value, frame.rest, options);
        yield* options.compactForIncoming
          ? handled.pipe(Effect.provide(options.compactForIncoming(raw)))
          : handled;
        void socket;
      })).pipe(Effect.ignore, Effect.onExit(() => Effect.sync(() => {
        if (options.counts) options.counts.fibers = Math.max(0, options.counts.fibers - 1);
      }))));
    })));
    if (hooks.afterListen) yield* hooks.afterListen;
    if (hooks.failAfterListen) yield* hooks.failAfterListen;
    return { path: listener.path, generation: options.generation, server: listener.server };
  });
}
