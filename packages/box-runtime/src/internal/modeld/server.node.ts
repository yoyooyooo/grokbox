import type { Socket } from "node:net";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
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
} from "@grokbox/runtime-kernel/contract";
import { cancelStep, runStep } from "@grokbox/runtime-kernel/inference";
import { decodeModeldFrame, encodeModeldFrame, parseV3Request } from "../wire/modeld-wire.ts";
import { acquireUnixListener, trackSocket, type ListenHooks, type ResourceCounts } from "./unix-listen.node.ts";

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

function writeFrame(socket: Socket, value: unknown, retained?: { bytes: number }): Effect.Effect<void, Error> {
  return Effect.callback<void, Error>((resume) => {
    let buf: Buffer;
    try { buf = encodeModeldFrame(value); }
    catch (error) {
      resume(Effect.fail(error instanceof Error ? error : new Error("encode")));
      return;
    }
    if (retained) retained.bytes += buf.length;
    const ok = socket.write(buf);
    if (ok) {
      resume(Effect.void);
      return;
    }
    socket.once("drain", () => resume(Effect.void));
  });
}

type Incoming = { socket: Socket; buf: Buffer };

function tryDecode(buf: Buffer): { value: unknown; rest: Buffer } | Error | null {
  const decoded = decodeModeldFrame(buf);
  if (decoded == null) return null;
  if ("error" in decoded) return new WireError("malformed_frame");
  return { value: decoded.value, rest: decoded.rest };
}

function readOneFrame(incoming: Incoming, timeoutMs = PARTIAL_SOCKET_MS): Effect.Effect<{ value: unknown; rest: Buffer }, Error> {
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

function handleRequest(socket: Socket, generation: string, value: unknown, extra: Buffer) {
  return Effect.gen(function* () {
    if (extra.length > 0) {
      yield* writeFrame(socket, errorFrame("extra_keys"));
      return;
    }
    let parsed;
    try {
      parsed = parseV3Request(value);
    } catch (error) {
      yield* writeFrame(socket, errorFrame(mapFail(error)));
      return;
    }
    if (parsed.method === "health") {
      yield* writeFrame(socket, { ok: true, method: "health", version: 3, serverGeneration: generation });
      return;
    }
    if (parsed.method === "cancel-step") {
      const result = yield* Effect.result(cancelStep(parsed.request));
      if (result._tag === "Failure") {
        yield* writeFrame(socket, errorFrame(mapFail(result.failure)));
        return;
      }
      yield* writeFrame(socket, { ok: true, method: "cancel-step", version: 3 });
      return;
    }

    const disconnected = yield* Deferred.make<void>();
    watchDisconnect(socket, () => {
      void Effect.runPromise(Deferred.succeed(disconnected, undefined).pipe(Effect.ignore));
    });

    const admitted = yield* Effect.result(
      runStep(parsed.request).pipe(Effect.timeout(`${ADMISSION_WAIT_MS} millis`)),
    );
    if (admitted._tag === "Failure") {
      yield* writeFrame(socket, errorFrame(mapFail(admitted.failure)));
      return;
    }
    if (yield* Deferred.isDone(disconnected)) {
      yield* writeFrame(socket, { kind: "terminal", outcome: "error", code: "cancelled" });
      return;
    }
    const step = admitted.success;
    yield* writeFrame(socket, { ok: true, method: "run-step", kind: "accepted", version: 3, bindingId: step.bindingId });
    if (!("stream" in step)) {
      yield* writeFrame(socket, {
        kind: "terminal",
        outcome: "duplicate",
        snapshotDigest: "snapshotDigest" in step ? step.snapshotDigest : "",
        bindingId: step.bindingId,
      });
      return;
    }

    let sequence = 0;
    let outputBytes = 0;
    const halt = Deferred.await(disconnected).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled"))));
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
            yield* writeFrame(socket, {
              kind: "terminal",
              outcome: "ok",
              bindingId: step.bindingId,
              finishReason: event.finishReason,
              usage: event.usage,
            });
            return;
          }
          yield* writeFrame(socket, { kind: "event", sequence, event });
          sequence += 1;
        }),
      ).pipe(Effect.timeout(`${REQUEST_WALL_DEADLINE_MS} millis`)),
    );
    if (collected._tag === "Failure") {
      yield* writeFrame(socket, { kind: "terminal", outcome: "error", code: mapFail(collected.failure) });
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
    }
  });
}

export type ServeOptions = {
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
    const incoming = yield* Queue.bounded<Incoming>(maxClients);
    const listener = yield* acquireUnixListener(options.path, options.counts, {
      ...options.hooks,
      onConnection: (socket) => {
        if (capacity.clients >= maxClients) {
          socket.destroy();
          return;
        }
        capacity.clients += 1;
        if (options.counts) options.counts.sockets += 1;
        const held: Incoming = { socket, buf: Buffer.alloc(0) };
        socket.on("data", (chunk: Buffer) => {
          held.buf = Buffer.concat([held.buf, chunk]);
        });
        if (!Queue.offerUnsafe(incoming, held)) {
          capacity.clients -= 1;
          if (options.counts) options.counts.sockets = Math.max(0, options.counts.sockets - 1);
          socket.destroy();
        }
      },
    });
    const accept = yield* Effect.forkDetach(Effect.forever(Effect.gen(function* () {
      const raw = yield* Queue.take(incoming);
      if (options.counts) options.counts.fibers += 1;
      yield* Effect.forkDetach(Effect.scoped(Effect.gen(function* () {
        const socket = yield* trackSocket(raw.socket, options.counts, capacity);
        const frame = yield* readOneFrame(raw);
        yield* handleRequest(socket, options.generation, frame.value, frame.rest);
      })).pipe(Effect.ignore, Effect.onExit(() => Effect.sync(() => {
        if (options.counts) options.counts.fibers = Math.max(0, options.counts.fibers - 1);
      }))));
    })));
    yield* Effect.addFinalizer(() => Fiber.interrupt(accept));
    return { path: listener.path, generation: options.generation, server: listener.server };
  });
}
