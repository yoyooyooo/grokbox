import { createConnection } from "node:net";
import {
  REQUEST_WALL_DEADLINE_MS, WireError, annotateStreamFailure, type StreamDiagnostic,
} from "@grokbox/runtime-kernel/contract";
import {
  acceptModeldFrame,
  clientSessionFor,
  decodeModeldFrame,
  encodeModeldFrame,
  MODELD_MAX_FRAME,
  type ClientSession,
} from "../wire/modeld-wire.ts";
import { modeldSocketPath } from "../wire/modeld-probe.node.ts";
import { resumeStepFrameForCompactRequest, type CompactInFlight } from "./compact.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export type ModeldTransportReason = "deadline" | "caller_abort" | "peer_eof" | "socket_error" | "write_error" | "reader_closed";
/** Side-qualified local IPC error. No original socket error/path/body is copied. */
export class ModeldTransportError extends Error {
  readonly side = "host_modeld_ipc";
  constructor(readonly reason: ModeldTransportReason) {
    super(reason === "deadline" ? "timeout" : reason === "peer_eof" ? "incomplete" : reason === "caller_abort" || reason === "reader_closed" ? "aborted" : "transport");
    this.name = "ModeldTransportError";
    annotateStreamFailure(this, { transportSide: this.side, transportEvent: reason });
  }
}
class ModeldCompactError extends Error {
  constructor() { super("compact_rejected"); this.name = "ModeldCompactError"; }
}
function inFlightFromBody(body: unknown): CompactInFlight | undefined {
  if (!isRecord(body) || body.method !== "run-step") return undefined;
  if (typeof body.agentId !== "string" || typeof body.turnId !== "string" || typeof body.stepId !== "string") return undefined;
  const selection = isRecord(body.selection) ? body.selection : undefined;
  if (!selection || typeof selection.selectionRevision !== "string") return undefined;
  return {
    agentId: body.agentId, turnId: body.turnId, stepId: body.stepId, selectionRevision: selection.selectionRevision,
    ...(typeof body.bindingId === "string" ? { bindingId: body.bindingId } : {}),
  };
}
function noteAccepted(inFlight: CompactInFlight | undefined, value: unknown): void {
  if (!inFlight || !isRecord(value)) return;
  if (value.ok === true && value.kind === "accepted" && typeof value.bindingId === "string") inFlight.bindingId = value.bindingId;
}
function serialize(onError: (error: Error) => void): (task: () => Promise<void>) => void {
  let tail = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch(error => onError(error instanceof Error ? error : new ModeldTransportError("socket_error")));
  };
}
async function applyIncomingFrame(input: {
  session: { current: ClientSession };
  inFlight: CompactInFlight | undefined;
  value: unknown;
  write: (value: unknown) => void;
  stopped: () => boolean;
  remainingMs: () => number;
}): Promise<{ done: boolean; emit?: unknown }> {
  const next = acceptModeldFrame(input.session.current, input.value);
  input.session.current = next.session;
  noteAccepted(input.inFlight, input.value);
  if (next.control) {
    if (next.control.method !== "compact-request") throw new ModeldCompactError();
    const resume = await resumeStepFrameForCompactRequest(next.control, input.inFlight, {
      stopped: input.stopped, deadlineMs: Math.max(0, input.remainingMs()),
    });
    if (!resume || input.stopped()) throw new ModeldCompactError();
    input.write(resume);
    return { done: false };
  }
  return { done: next.done, emit: input.value };
}

/** Finite collection uses exactly the same validated transport as streaming. */
export async function requestModeld(runRoot: string, body: unknown, timeoutMs = 2_000): Promise<unknown[]> {
  const frames: unknown[] = [];
  for await (const frame of streamModeld(runRoot, body, { timeoutMs })) frames.push(frame);
  return frames;
}

/** Effect-free Host client. Fixed frame/aggregate budgets, no raw socket errors,
 * no hidden retry. Socket data and EOF are serialized in arrival order; a valid
 * terminal queued for decoding cannot be discarded by an earlier EOF callback. */
export function streamModeld(
  runRoot: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): AsyncIterable<unknown> {
  const timeoutMs = options.timeoutMs ?? REQUEST_WALL_DEADLINE_MS;
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let session: ClientSession;
      try {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > REQUEST_WALL_DEADLINE_MS) throw new ModeldTransportError("deadline");
        session = clientSessionFor(body);
      } catch (error) {
        const failed = error instanceof Error ? error : new ModeldTransportError("write_error");
        return { next: async () => { throw failed; } };
      }
      const inFlight = inFlightFromBody(body);
      const pending: unknown[] = [];
      let waiting: { resolve: (result: IteratorResult<unknown>) => void; reject: (error: Error) => void } | undefined;
      let demand: (() => void) | undefined;
      const resumeDecoder = () => { const ready = demand; demand = undefined; ready?.(); };
      let closed = false, complete = false;
      let failure: Error | undefined;
      let buf = Buffer.alloc(0);
      const socket = createConnection({ path: modeldSocketPath(runRoot) });
      const deadlineAt = performance.now() + timeoutMs;
      const sessionRef = { current: session };
      const timer = setTimeout(() => settle(new ModeldTransportError("deadline")), timeoutMs);
      const onAbort = () => settle(new ModeldTransportError("caller_abort"));
      const settle = (error?: Error) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        try { socket.destroy(); } catch { /* no retry or replacement error */ }
        buf = Buffer.alloc(0);
        failure = error ?? (!complete ? new ModeldTransportError("peer_eof") : undefined);
        // A failure is never delayed behind stale queued tool material/terminal.
        // Consumers retain whatever they already observed, not an invented rollback.
        if (failure) pending.length = 0;
        resumeDecoder();
        if (waiting) {
          const waiter = waiting; waiting = undefined;
          if (failure) waiter.reject(failure);
          else waiter.resolve({ done: true, value: undefined });
        }
      };
      const emit = (value: unknown) => {
        if (waiting) {
          const waiter = waiting; waiting = undefined;
          waiter.resolve({ done: false, value });
        } else pending.push(value);
      };
      const enqueue = serialize(settle);
      const frameError = (details: StreamDiagnostic, code: "malformed_frame" | "extra_keys" | "capacity" = "malformed_frame") => annotateStreamFailure(new WireError(code), {
        ...details,
        ...(sessionRef.current.method === "run-step" ? { wireSequence: sessionRef.current.sequence } : {}),
      });
      const write = (value: unknown) => {
        try { socket.write(encodeModeldFrame(value)); }
        catch { throw new ModeldTransportError("write_error"); }
      };
      // Install handlers even for pre-abort: asynchronous connection errors must
      // always have an owner, including after destroy().
      socket.on("error", () => enqueue(async () => { if (!closed) settle(new ModeldTransportError("socket_error")); }));
      socket.on("end", () => enqueue(async () => { if (!closed) settle(); }));
      socket.on("close", () => enqueue(async () => { if (!closed) settle(); }));
      socket.on("connect", () => {
        if (closed) return;
        try { write(body); } catch (error) { settle(error as Error); }
      });
      socket.on("data", (chunk: Buffer) => {
        // Read demand owns the pause, not merely decoding speed. At most one
        // decoded frame waits for a consumer; no cumulative event-count quota.
        socket.pause();
        enqueue(async () => {
          try {
            if (closed) return;
            if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
              settle(frameError({ normalizeCause: "stream_budget", rejectSite: "wire_event" }, "capacity")); return;
            }
            buf = Buffer.concat([buf, chunk]);
            while (!closed) {
              if (pending.length > 0) await new Promise<void>(resolve => { demand = resolve; });
              if (closed) return;
              const decoded = decodeModeldFrame(buf);
              if (decoded == null) break;
              if ("error" in decoded) {
                settle(frameError({ normalizeCause: decoded.error === "too-large" ? "stream_budget" : "invalid_event_shape", rejectSite: "wire_event" })); return;
              }
              buf = Buffer.from(decoded.rest);
              const next = await applyIncomingFrame({
                session: sessionRef, inFlight, value: decoded.value, write,
                stopped: () => closed, remainingMs: () => deadlineAt - performance.now(),
              });
              if (closed) return;
              if (next.done) {
                if (buf.length > 0) {
                  settle(frameError({ normalizeCause: "event_after_finish", rejectSite: "wire_terminal" }, "extra_keys")); return;
                }
                complete = true;
                if (next.emit !== undefined) emit(next.emit);
                settle(); return;
              }
              if (next.emit !== undefined) emit(next.emit);
            }
          } finally { if (!closed) socket.resume(); }
        });
      });
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      return {
        next: () => {
          if (pending.length > 0) {
            const value = pending.shift()!;
            resumeDecoder();
            return Promise.resolve({ done: false, value });
          }
          if (closed) return failure ? Promise.reject(failure) : Promise.resolve({ done: true, value: undefined });
          if (waiting) return Promise.reject(new ModeldTransportError("reader_closed"));
          return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
        },
        return: async () => {
          pending.length = 0;
          settle(new ModeldTransportError("reader_closed"));
          return { done: true, value: undefined };
        },
      };
    },
  };
}
