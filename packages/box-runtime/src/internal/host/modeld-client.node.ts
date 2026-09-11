import { createConnection } from "node:net";
import {
  acceptModeldFrame,
  clientSessionFor,
  decodeModeldFrame,
  encodeModeldFrame,
  MODELD_MAX_FRAME,
  type ClientSession,
} from "../wire/modeld-wire.ts";
import { modeldSocketPath } from "../wire/modeld-probe.node.ts";
import {
  resumeStepFrameForCompactRequest,
  type CompactInFlight,
} from "./compact.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inFlightFromBody(body: unknown): CompactInFlight | undefined {
  if (!isRecord(body) || body.method !== "run-step") return undefined;
  if (typeof body.agentId !== "string" || typeof body.turnId !== "string" || typeof body.stepId !== "string") return undefined;
  const selection = isRecord(body.selection) ? body.selection : undefined;
  if (!selection || typeof selection.selectionRevision !== "string") return undefined;
  return {
    agentId: body.agentId,
    turnId: body.turnId,
    stepId: body.stepId,
    selectionRevision: selection.selectionRevision,
    ...(typeof body.bindingId === "string" ? { bindingId: body.bindingId } : {}),
  };
}

function noteAccepted(inFlight: CompactInFlight | undefined, value: unknown): void {
  if (!inFlight || !isRecord(value)) return;
  if (value.ok === true && value.kind === "accepted" && typeof value.bindingId === "string") {
    inFlight.bindingId = value.bindingId;
  }
}

function serialize(onError: (error: Error) => void): (task: () => Promise<void>) => void {
  let tail = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch((error) => {
      onError(error instanceof Error ? error : new Error("frame"));
    });
  };
}

async function applyIncomingFrame(input: {
  session: { current: ClientSession };
  inFlight: CompactInFlight | undefined;
  value: unknown;
  write: (value: unknown) => void;
  stopped: () => boolean;
}): Promise<{ done: boolean; emit?: unknown }> {
  const next = acceptModeldFrame(input.session.current, input.value);
  input.session.current = next.session;
  noteAccepted(input.inFlight, input.value);
  if (next.control) {
    if (next.control.method !== "compact-request") throw new Error("unexpected_compact");
    const resume = await resumeStepFrameForCompactRequest(next.control, input.inFlight);
    if (!resume || input.stopped()) throw new Error("compact_rejected");
    input.write(resume);
    return { done: false };
  }
  return { done: next.done, emit: input.value };
}

/** Effect-free Host client. Schema/sequence/method SM. EOF without complete session is incomplete. */
export async function requestModeld(runRoot: string, body: unknown, timeoutMs = 2_000): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    let session: ClientSession;
    try { session = clientSessionFor(body); }
    catch (error) {
      reject(error instanceof Error ? error : new Error("request"));
      return;
    }
    const inFlight = inFlightFromBody(body);
    const socket = createConnection({ path: modeldSocketPath(runRoot) });
    const frames: unknown[] = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    let done = false;
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (!done) reject(new Error("incomplete"));
      else resolve(frames);
    };
    const enqueue = serialize((error) => finish(error));
    const sessionRef = { current: session };
    socket.on("connect", () => {
      try { socket.write(encodeModeldFrame(body)); }
      catch (error) { finish(error instanceof Error ? error : new Error("write")); }
    });
    socket.on("data", (chunk: Buffer) => {
      enqueue(async () => {
        if (settled) return;
        if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
          finish(new Error("frame"));
          return;
        }
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
            const next = await applyIncomingFrame({
              session: sessionRef,
              inFlight,
              value: decoded.value,
              write: (value) => { socket.write(encodeModeldFrame(value)); },
              stopped: () => settled,
            });
            if (next.emit !== undefined) frames.push(next.emit);
            if (next.done) {
              done = true;
              if (buf.length > 0) {
                finish(new Error("extra_keys"));
                return;
              }
              finish();
              return;
            }
          } catch (error) {
            finish(error instanceof Error ? error : new Error("malformed_frame"));
            return;
          }
        }
      });
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish());
    socket.on("close", () => { if (!settled) finish(); });
  });
}

/** Yield each validated frame as it arrives. Buffer-all mutants cannot satisfy first-chunk-before-terminal. */
export function streamModeld(
  runRoot: string,
  body: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): AsyncIterable<unknown> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let session: ClientSession;
      try { session = clientSessionFor(body); }
      catch (error) {
        const failed = error instanceof Error ? error : new Error("request");
        return {
          next: async () => { throw failed; },
        };
      }
      const inFlight = inFlightFromBody(body);
      const socket = createConnection({ path: modeldSocketPath(runRoot) });
      const pending: unknown[] = [];
      let waiting: ((result: IteratorResult<unknown>) => void) | undefined;
      let closed = false;
      let complete = false;
      let failure: Error | undefined;
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => settle(new Error("timeout")), timeoutMs);
      const settle = (error?: Error) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        if (error) failure = error;
        else if (!complete) failure = new Error("incomplete");
        if (waiting) {
          const resume = waiting;
          waiting = undefined;
          if (failure) resume({ done: true, value: undefined });
          else resume({ done: true, value: undefined });
        }
      };
      const emit = (value: unknown) => {
        if (waiting) {
          const resume = waiting;
          waiting = undefined;
          resume({ done: false, value });
          return;
        }
        pending.push(value);
      };
      const enqueue = serialize((error) => settle(error));
      const sessionRef = { current: session };
      const onAbort = () => settle(new Error("aborted"));
      if (options.signal?.aborted) {
        settle(new Error("aborted"));
      } else {
        options.signal?.addEventListener("abort", onAbort, { once: true });
        socket.on("connect", () => {
          try { socket.write(encodeModeldFrame(body)); }
          catch (error) { settle(error instanceof Error ? error : new Error("write")); }
        });
        socket.on("data", (chunk: Buffer) => {
          enqueue(async () => {
            if (closed) return;
            if (buf.length + chunk.length > MODELD_MAX_FRAME + 4) {
              settle(new Error("frame"));
              return;
            }
            buf = Buffer.concat([buf, chunk]);
            while (!closed) {
              const decoded = decodeModeldFrame(buf);
              if (decoded == null) break;
              if ("error" in decoded) {
                settle(new Error(decoded.error));
                return;
              }
              buf = Buffer.from(decoded.rest);
              try {
                const next = await applyIncomingFrame({
                  session: sessionRef,
                  inFlight,
                  value: decoded.value,
                  write: (value) => { socket.write(encodeModeldFrame(value)); },
                  stopped: () => closed,
                });
                if (next.done) {
                  complete = true;
                  if (buf.length > 0) {
                    settle(new Error("extra_keys"));
                    return;
                  }
                  if (next.emit !== undefined) emit(next.emit);
                  settle();
                  return;
                }
                if (next.emit !== undefined) emit(next.emit);
              } catch (error) {
                settle(error instanceof Error ? error : new Error("malformed_frame"));
                return;
              }
            }
          });
        });
        socket.on("error", (error) => settle(error));
        socket.on("end", () => settle());
        socket.on("close", () => { if (!closed) settle(); });
      }
      return {
        next: () => {
          if (pending.length > 0) return Promise.resolve({ done: false as const, value: pending.shift()! });
          if (closed) {
            if (failure) return Promise.reject(failure);
            return Promise.resolve({ done: true as const, value: undefined });
          }
          return new Promise((resolve, reject) => {
            waiting = (result) => {
              if (result.done) {
                if (failure) reject(failure);
                else resolve(result);
                return;
              }
              resolve(result);
            };
          });
        },
        return: async () => {
          settle(new Error("aborted"));
          return { done: true, value: undefined };
        },
      };
    },
  };
}
