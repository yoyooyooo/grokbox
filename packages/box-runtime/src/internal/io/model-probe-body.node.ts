import { BackendFailure } from "@grokbox/runtime-kernel/contract";

export class ProbeBodyCleanupGap extends Error {
  constructor() { super("model_probe_body_cleanup_gap"); }
}

/** Own the reader behind the SDK-facing stream. Stream completion includes the
 * underlying source's asynchronous cancellation, not just returned headers or
 * a downstream iterator that has requested cancellation. */
export function ownProbeResponseBody(source: ReadableStream<Uint8Array>, maxBytes: number) {
  const reader = source.getReader();
  let stopped = false, finished = false, received = 0;
  let sourceErrored = false, sourceError: unknown;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let closing: Promise<void> | undefined;
  let settled!: () => void, failed!: (error: ProbeBodyCleanupGap) => void;
  const done = new Promise<void>((resolve, reject) => { settled = resolve; failed = reject; });
  void done.catch(() => undefined);
  const finish = () => {
    if (finished) return;
    finished = true;
    stopped = true;
    try { reader.releaseLock(); }
    catch { const error = new ProbeBodyCleanupGap(); failed(error); throw error; }
    settled();
  };
  const close = (reason?: unknown): Promise<void> => {
    if (finished) return done;
    if (closing) return closing;
    stopped = true;
    output.error(reason ?? new DOMException("Model probe scope closed", "AbortError"));
    closing = reader.cancel(reason).then(finish, cause => {
      // cancel() on an already-errored source rejects its stored error; it
      // never invokes underlying cancellation. That source is already terminal.
      if (sourceErrored && cause === sourceError) { finish(); return; }
      finished = true;
      try { reader.releaseLock(); } catch { /* The cleanup gap remains explicit. */ }
      const error = new ProbeBodyCleanupGap(); failed(error); throw error;
    });
    void closing.catch(() => undefined);
    return closing;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    async pull(controller) {
      if (stopped) return;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try { next = await reader.read(); }
      catch (error) {
        // An upstream error is already terminal. Cancellation in progress owns
        // settlement; a cancelled pending read must not prematurely settle it.
        if (!stopped) { finish(); controller.error(error); }
        return;
      }
      if (stopped) return;
      if (next.done) { finish(); controller.close(); return; }
      received += next.value.byteLength;
      if (received > maxBytes) {
        const error = new BackendFailure("stream_limit");
        try { await close(error); }
        finally { controller.error(error); }
        return;
      }
      controller.enqueue(next.value);
    },
    cancel: close,
  });
  void reader.closed.catch(error => {
    sourceErrored = true; sourceError = error;
    if (!stopped) { finish(); output.error(error); }
  }).catch(() => undefined);
  return { stream, close, done };
}
