import type { Socket } from "node:net";
import { Effect, Queue, Stream } from "effect";
import {
  BindingFailure,
  PARTIAL_SOCKET_MS,
  REQUEST_WALL_DEADLINE_MS,
  SERVER_ACTIVE_CLIENTS_MAX,
  WireError,
  type InferenceEvent,
} from "@grokbox/runtime-kernel/contract";
import { cancelStep, runStep } from "@grokbox/runtime-kernel/inference";
import { decodeModeldFrame, encodeModeldFrame, parseV3Request } from "../wire/modeld-wire.ts";
import { acquireUnixListener, trackSocket, type ListenHooks, type ResourceCounts } from "./unix-listen.node.ts";

function writeFrame(socket: Socket, value: unknown): void {
  socket.write(encodeModeldFrame(value));
}

function errorFrame(code: string): unknown {
  return { ok: false, version: 3, error: { code } };
}

function readOneFrame(socket: Socket, timeoutMs = PARTIAL_SOCKET_MS): Effect.Effect<unknown, Error> {
  return Effect.callback<unknown, Error>((resume, signal) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("partial_socket")), timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) resume(Effect.fail(error));
      else resume(Effect.succeed(value));
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const decoded = decodeModeldFrame(buf);
      if (decoded == null) return;
      if ("error" in decoded) {
        finish(new WireError(decoded.error === "too-large" ? "malformed_frame" : "malformed_frame"));
        return;
      }
      finish(undefined, decoded.value);
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("eof"));
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => finish(new Error("aborted")), { once: true });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    return Effect.sync(() => {
      clearTimeout(timer);
      socket.off("data", onData);
    });
  });
}

function handleRequest(socket: Socket, generation: string, value: unknown) {
  return Effect.gen(function* () {
    let parsed;
    try {
      parsed = parseV3Request(value);
    } catch (error) {
      const code = error instanceof WireError ? error.code : "malformed_frame";
      writeFrame(socket, errorFrame(code));
      return;
    }
    if (parsed.method === "health") {
      writeFrame(socket, { ok: true, method: "health", version: 3, serverGeneration: generation });
      return;
    }
    if (parsed.method === "cancel-step") {
      const result = yield* Effect.result(cancelStep(parsed.request));
      if (result._tag === "Failure") {
        const code = result.failure instanceof BindingFailure ? result.failure.code : "malformed_frame";
        writeFrame(socket, errorFrame(code));
        return;
      }
      writeFrame(socket, { ok: true, method: "cancel-step", version: 3 });
      return;
    }
    const admitted = yield* Effect.result(runStep(parsed.request).pipe(Effect.timeout(`${REQUEST_WALL_DEADLINE_MS} millis`)));
    if (admitted._tag === "Failure") {
      const code = admitted.failure instanceof BindingFailure ? admitted.failure.code : "malformed_frame";
      writeFrame(socket, errorFrame(code));
      return;
    }
    const step = admitted.success;
    writeFrame(socket, { ok: true, method: "run-step", kind: "accepted", version: 3, bindingId: step.bindingId });
    if (!("stream" in step)) {
      writeFrame(socket, { kind: "terminal", outcome: "duplicate", snapshotDigest: "snapshotDigest" in step ? step.snapshotDigest : "", bindingId: step.bindingId });
      return;
    }
    let sequence = 0;
    const collected = yield* Effect.result(Stream.runForEach(step.stream, (event: InferenceEvent) => Effect.sync(() => {
      writeFrame(socket, { kind: "event", sequence, event });
      sequence += 1;
    })));
    if (collected._tag === "Failure") {
      const code = collected.failure instanceof BindingFailure ? collected.failure.code : "cancelled";
      writeFrame(socket, { kind: "terminal", outcome: "error", code });
      return;
    }
    writeFrame(socket, { kind: "terminal", outcome: "ok", bindingId: step.bindingId });
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
    const listener = yield* acquireUnixListener(options.path, options.counts, options.hooks);
    const maxClients = options.maxClients ?? SERVER_ACTIVE_CLIENTS_MAX;
    const incoming = yield* Queue.unbounded<Socket>();
    listener.server.on("connection", (socket) => {
      Queue.offerUnsafe(incoming, socket);
    });
    yield* Effect.forkChild(Effect.forever(Effect.gen(function* () {
      const raw = yield* Queue.take(incoming);
      const clients = options.counts?.sockets ?? 0;
      if (clients >= maxClients) {
        raw.destroy();
        return;
      }
      if (options.counts) options.counts.fibers += 1;
      yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        const socket = yield* trackSocket(raw, options.counts);
        const value = yield* readOneFrame(socket);
        yield* handleRequest(socket, options.generation, value);
      })).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => {
        if (options.counts) options.counts.fibers = Math.max(0, options.counts.fibers - 1);
      }))));
    })));
    return { path: listener.path, generation: options.generation, server: listener.server };
  });
}
