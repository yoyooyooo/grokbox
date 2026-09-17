import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Cause, Clock, Deferred, Effect, Layer, Queue, Stream } from "effect";
import {
  BackendFailure,
  BindingFailure,
  StreamOutputBudget,
  annotateStreamFailure,
  PARTIAL_SOCKET_MS,
  REQUEST_WALL_DEADLINE_MS,
  SERVER_ACTIVE_CLIENTS_MAX,
  WIRE_VERSION,
  projectFailureSummary, failureSummaryFromObservation, projectProviderRecoveryState, projectAuthorityProgress, type AuthorityProgress, type ProviderRecoveryState, type FailureSummary,
  WireError,
  type InferenceEvent,
  type RunStepRequest,
} from "@grokbox/runtime-kernel/contract";
import { cancelStep, runStep, inferenceCapacity } from "@grokbox/runtime-kernel/inference";
import { HostCompact, ModelBackend, RuntimeEvents } from "@grokbox/runtime-kernel/ports";
import { withOverflowCanary } from "../backends/overflow-canary.ts";
import { decodeModeldFrame, encodeModeldFrame, MODELD_MAX_FRAME, parseModeldRequest } from "../wire/modeld-wire.ts";
import { acquireUnixListener, trackSocket, type ListenHooks, type ResourceCounts } from "./unix-listen.node.ts";
import { modeldFailureOutcome, withTransportOutcome, type ModeldStepOutcome } from "./step-outcome.ts";

function errorFrame(code: string, failure?: FailureSummary): unknown {
  return { ok: false, version: WIRE_VERSION, error: { code, ...(failure ? { failure } : {}) } };
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
      signal.removeEventListener("abort", onAbort);
      if (error) resume(Effect.fail(error));
      else resume(Effect.void);
    };
    const onDrain = () => finish();
    const onFail = () => finish(new Error("disconnected"));
    const onAbort = () => finish(new Error("aborted"));
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
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
      signal.removeEventListener("abort", onAbort);
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
    const onAbort = () => finish(new Error("aborted"));
    if (signal.aborted) {
      finish(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.on("data", check);
    check();
  });
}

function watchDisconnect(socket: Socket, onClose: (kind: "peer_end" | "peer_close" | "socket_error") => void): () => void {
  let fired = false;
  const fire = (kind: "peer_end" | "peer_close" | "socket_error") => { if (!fired) { fired = true; onClose(kind); } };
  const end = () => fire("peer_end"), close = () => fire("peer_close"), error = () => fire("socket_error");
  socket.on("end", end); socket.on("close", close); socket.on("error", error);
  if (socket.destroyed) close();
  return () => { socket.off("end", end); socket.off("close", close); socket.off("error", error); };
}

function emit(socket: Socket, value: unknown) {
  if (!writable(socket)) return Effect.void;
  return writeFrame(socket, value).pipe(Effect.ignore);
}

function handleRequest(incoming: Incoming, generation: string, value: unknown, extra: Buffer, options: ServeOptions,
  enqueueAuthority: (request: RunStepRequest, state: AuthorityProgress, gap: () => void) => void) {
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
      parsed = parseModeldRequest(value);
    } catch (error) {
      yield* emit(socket, errorFrame(mapFail(error)));
      return;
    }
    if (parsed.method === "health") {
      yield* emit(socket, { ok: true, method: "health", version: WIRE_VERSION, serverGeneration: generation });
      return;
    }
    if (parsed.method === "service-info") {
      yield* emit(socket, { ok: true, method: "service-info", version: WIRE_VERSION,
        serverGeneration: generation, rootId: options.rootId ?? null });
      return;
    }
    if (parsed.method === "execution-status") {
      const execution = yield* inferenceCapacity;
      yield* emit(socket, { ok: true, method: "execution-status", version: WIRE_VERSION, serverGeneration: generation, execution });
      return;
    }
    if (parsed.method === "cancel-step") {
      const result = yield* Effect.result(cancelStep(parsed.request));
      if (result._tag === "Failure") {
        yield* emit(socket, errorFrame(mapFail(result.failure)));
        return;
      }
      yield* emit(socket, { ok: true, method: "cancel-step", version: WIRE_VERSION });
      return;
    }

    const request = parsed.request;
    // One request deadline across claim/admission/prepare and streaming. Use the
    // same injected monotonic clock and origin as the kernel; the authority
    // gate owns its smaller cumulative allowance, not another admission timer.
    const clock = yield* Clock.Clock;
    const startedTick = clock.monotonicTimeNanosUnsafe();
    const startedAt = new Date().toISOString();
    const deadlineAt = startedTick + BigInt(REQUEST_WALL_DEADLINE_MS) * 1_000_000n;
    const remainingMs = () => Math.max(0, Number(deadlineAt - clock.monotonicTimeNanosUnsafe()) / 1_000_000);
    const observeStep = options.observeStep;
    let observation: ModeldStepOutcome = { outcome: "unknown", phase: "admission", eventCount: 0, startedAt };
    let backendAttempts = 0;
    const attempts: NonNullable<ModeldStepOutcome["attempts"]> = [];
    let readRecovery: (() => ProviderRecoveryState | undefined) | undefined;
    let recoverySequence = 0, authoritySequence = 0;
    let lastAuthority: AuthorityProgress | undefined;
    let authorityObservationGaps = 0;
    const withFailureSummary = (value: ModeldStepOutcome): ModeldStepOutcome => {
      if (!value.failureCode) return value;
      const base = value.failureSummary ?? failureSummaryFromObservation(value);
      const summary = base && projectFailureSummary({ ...base, failureId: base.failureId ?? randomUUID(),
        identity: { agentId: request.agentId, turnId: request.turnId, stepId: request.stepId,
          hostGenerationId: request.hostEpoch.compile, serviceEpoch: request.serviceEpoch.incarnationId,
          ...(value.bindingId ? { bindingId: value.bindingId } : {}) },
        progress: { canonicalEvents: value.eventCount, backendAttempts }, recovery: readRecovery?.() ?? value.recovery });
      return { ...value, ...(summary ? { failureSummary: summary } : {}) };
    };
    yield* Effect.addFinalizer((exit) => {
      if (!observeStep) return Effect.void;
      if (exit._tag === "Failure") {
        const defect = Cause.hasDies(exit.cause);
        const interrupted = Cause.hasInterruptsOnly(exit.cause);
        const exitFailure = defect ? "defect" : interrupted ? "interrupted" : "unknown";
        observation = { ...(observation.outcome === "unknown"
          ? { ...observation, outcome: interrupted ? "cancelled" as const : "error" as const, phase: "internal" as const, failureCode: exitFailure }
          : observation), cleanup: { ...observation.cleanup, exitFailure } };
      }
      observation = withFailureSummary({ ...observation, at: observation.at ?? new Date().toISOString(), startedAt,
        durationMs: Math.max(0, Math.floor(Number(clock.monotonicTimeNanosUnsafe() - startedTick) / 1_000_000)), backendAttempts, attempts,
        ...(lastAuthority ? { authority: lastAuthority } : {}),
        ...(authorityObservationGaps ? { authorityObservationGaps } : {}),
        ...(readRecovery?.() ? { recovery: readRecovery!() } : {}) });
      return Effect.gen(function* () {
        const execution = yield* inferenceCapacity;
        yield* observeStep(request, { ...observation, execution });
      }).pipe(
        Effect.interruptible, Effect.timeout("100 millis"), Effect.catchCause(cause => Effect.sync(() => {
          const error = Cause.squash(cause);
          if (error && typeof error === "object" && "_tag" in error && error._tag === "TimeoutError") {
            try { options.onObservationTimeout?.(); } catch { /* telemetry never changes inference */ }
          }
        })),
      );
    });
    const disconnected = yield* Deferred.make<void>();
    const late = yield* Deferred.make<void>();
    incoming.onLate = () => {
      void Effect.runPromise(Deferred.succeed(late, undefined).pipe(Effect.ignore));
    };
    if (incoming.extra || incoming.overflow) incoming.onLate();
    const unwatch = watchDisconnect(socket, (kind) => {
      observation.transport = { side: "host_modeld_ipc", close: kind, at: new Date().toISOString() };
      void Effect.runPromise(Deferred.succeed(disconnected, undefined).pipe(Effect.ignore));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unwatch));

    const backend = yield* ModelBackend;
    const selectedBackend = withOverflowCanary(backend, parsed.request.agentId, options.env ?? process.env);
    const compactBackend: typeof backend = { ...selectedBackend, infer: (...args) => Stream.unwrap(Effect.sync(() => {
      backendAttempts += 1;
      const attempt: NonNullable<ModeldStepOutcome["attempts"]>[number] = { index: backendAttempts - 1 };
      if (attempts.length < 4) attempts.push(attempt);
      observation.attempts = attempts;
      return selectedBackend.infer(...args).pipe(
        Stream.tap(event => Effect.sync(() => {
          if (event.type === "backend_finish" && event.stream) attempt.stream = event.stream;
        })),
        Stream.tapError(error => Effect.sync(() => {
          const detected = modeldFailureOutcome(error, "provider", 0);
          attempt.failureCode = detected.failureCode;
          attempt.diagnostic = detected.diagnostic;
        })),
      );
    })) };
    const runtimeEvents: typeof RuntimeEvents.Service = { append: value => Effect.gen(function* () {
      const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const authority = projectAuthorityProgress(v.authority);
      if (authority) {
        lastAuthority = authority;
        // Bounded control traffic; suppression never extends a deadline or
        // drops a model/tool event. Final outcome retains the latest phase.
        if (authoritySequence < 256) {
          yield* emit(socket, { kind: "authority", version: WIRE_VERSION, sequence: authoritySequence++, authority });
          // Journal I/O has a separate bounded service worker. A slow or broken
          // observer must not consume the STEP's authority waiting allowance.
          enqueueAuthority(request, authority, () => { authorityObservationGaps++; });
        }
        return;
      }
      const recovery = projectProviderRecoveryState(v.recovery);
      if (!recovery) return;
      yield* emit(socket, { kind: "recovery", version: WIRE_VERSION, sequence: recoverySequence++, recovery });
      if (options.observeRecovery) yield* options.observeRecovery(request, recovery).pipe(Effect.timeout("100 millis"), Effect.catchCause(() => Effect.void));
    }) };
    const transportHalt = Effect.raceFirst(
      Deferred.await(disconnected).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled")))),
      Deferred.await(late).pipe(Effect.andThen(Effect.fail(new WireError(incoming.overflow ? "capacity" : "extra_keys")))),
    );
    const admitted = yield* Effect.result(
      Effect.raceFirst(runStep(parsed.request, { startedTick }), transportHalt).pipe(
        Effect.timeout(`${remainingMs()} millis`),
        Effect.provideService(ModelBackend, compactBackend),
        Effect.provideService(RuntimeEvents, runtimeEvents),
      ),
    );
    if (admitted._tag === "Failure") {
      observation = withFailureSummary(modeldFailureOutcome(admitted.failure, "admission", 0));
      yield* emit(socket, errorFrame(mapFail(admitted.failure), observation.failureSummary));
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
    if ("recovery" in step && typeof step.recovery === "function") readRecovery = step.recovery;
    observation = { ...observation, phase: "provider", bindingId: step.bindingId };
    if (!("stream" in step) && !step.bindingId) {
      // A claim waiting for authority has no acknowledged binding yet. Do not
      // issue an invalid accepted frame, nor dispatch the duplicate request.
      observation = { ...observation, outcome: "duplicate", phase: "admission" };
      yield* emit(socket, errorFrame("binding_missing"));
      return;
    }
    yield* emit(socket, { ok: true, method: "run-step", kind: "accepted", version: WIRE_VERSION, bindingId: step.bindingId });
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
    const outputBudget = new StreamOutputBudget();
    const halt = Effect.raceFirst(
      Deferred.await(disconnected).pipe(Effect.andThen(Effect.fail(new BindingFailure("cancelled")))),
      Deferred.await(late).pipe(Effect.andThen(Effect.fail(new WireError(incoming.overflow ? "capacity" : "extra_keys")))),
    );
    const collected = yield* Effect.result(
      Stream.runForEach(
        Stream.interruptWhen(step.stream, halt).pipe(
          Stream.provideService(ModelBackend, compactBackend),
          Stream.provideService(RuntimeEvents, runtimeEvents),
        ),
        (event: InferenceEvent) => Effect.gen(function* () {
          if (!outputBudget.add(event)) {
            return yield* Effect.fail(annotateStreamFailure(new BackendFailure("stream_limit"), { normalizeCause: "stream_budget", rejectSite: "wire_event", budget: { layer: "canonical", metric: "output_bytes", limit: outputBudget.limit, measured: outputBudget.used } }));
          }
          if (event.type === "backend_finish") {
            observation = { ...observation, at: new Date().toISOString(), outcome: event.finishReason === "stop" ? "ok" : event.finishReason === "abort" ? "cancelled" : "error", phase: "complete", ...(event.stream ? { stream: event.stream } : {}) };
            yield* emit(socket, {
              kind: "terminal",
              outcome: "ok",
              bindingId: step.bindingId,
              finishReason: event.finishReason,
              usage: event.usage,
            });
            return;
          }
          // Count an event only after the socket write accepted it. This is not
          // proof that Host accepted it or executed a tool.
          yield* writeFrame(socket, { kind: "event", sequence, event });
          sequence += 1;
          observation.eventCount = sequence;
        }),
      ).pipe(Effect.timeout(`${remainingMs()} millis`)),
    );
    const clientDisconnected = yield* Deferred.isDone(disconnected);
    const failure = collected._tag === "Failure" ? modeldFailureOutcome(collected.failure, "provider", sequence) : undefined;
    if (failure && attempts.length > 0 && attempts.length === backendAttempts) {
      const attempt = attempts[attempts.length - 1]!;
      attempt.failureCode = failure.failureCode;
      attempt.diagnostic = failure.diagnostic;
    }
    observation = withFailureSummary({
      ...withTransportOutcome(observation, failure, clientDisconnected),
      at: observation.at ?? new Date().toISOString(),
      attempts,
      ...(failure?.diagnostic?.stream && !observation.stream ? { stream: failure.diagnostic.stream } : {}),
    });
    if (clientDisconnected) {
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
      return;
    }
    if (collected._tag === "Failure") {
      yield* emit(socket, { kind: "terminal", outcome: "error", version: WIRE_VERSION, code: mapFail(collected.failure),
        ...(observation.failureSummary ? { failure: observation.failureSummary } : {}) });
      yield* cancelStep(parsed.request).pipe(Effect.ignore);
    }
  });
}

export type ServeOptions = {
  /** Diagnostic scope only; never grants STEP admission or replaces attestation. */
  rootId?: string;
  observeStep?: (request: RunStepRequest, outcome: ModeldStepOutcome) => Effect.Effect<void, unknown>;
  observeRecovery?: (request: RunStepRequest, state: ProviderRecoveryState) => Effect.Effect<void, unknown>;
  observeAuthority?: (request: Pick<RunStepRequest, "agentId" | "turnId" | "stepId" | "hostEpoch" | "serviceEpoch">,
    state: AuthorityProgress, observedAt?: string) => Effect.Effect<void, unknown>;
  onObservationTimeout?: () => void;
  compactForIncoming?: (incoming: Incoming) => Layer.Layer<HostCompact>;
  env?: NodeJS.Dict<string>;
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
    type AuthorityJob = { request: Parameters<NonNullable<ServeOptions["observeAuthority"]>>[0]; state: AuthorityProgress; at: string; gap: () => void };
    const authorityJobs = yield* Queue.bounded<AuthorityJob>(64);
    const pendingAuthority = new Set<AuthorityJob>();
    const enqueueAuthority = (request: RunStepRequest, state: AuthorityProgress, onGap: () => void) => {
      if (!options.observeAuthority) return;
      let noted = false;
      // Retain only identities, never the potentially large prompt snapshot.
      const identity = { agentId: request.agentId, turnId: request.turnId, stepId: request.stepId,
        hostEpoch: { ...request.hostEpoch }, serviceEpoch: { ...request.serviceEpoch } };
      const job = { request: identity, state, at: new Date().toISOString(), gap: () => { if (!noted) { noted = true; onGap(); } } };
      if (Queue.offerUnsafe(authorityJobs, job)) pendingAuthority.add(job);
      else job.gap();
    };
    if (options.observeAuthority) yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      const job = yield* Queue.take(authorityJobs);
      yield* options.observeAuthority!(job.request, job.state, job.at).pipe(
        Effect.timeout("50 millis"),
        Effect.onExit(exit => Effect.sync(() => {
          if (exit._tag === "Failure") job.gap();
          pendingAuthority.delete(job);
        })), Effect.catchCause(() => Effect.void),
      );
    })));
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      for (const job of pendingAuthority) job.gap();
      pendingAuthority.clear();
    }));
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
        const handled = handleRequest(raw, options.generation, frame.value, frame.rest, options, enqueueAuthority);
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
