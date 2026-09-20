import { API_VERSION, ManagementClientError, decodeObservationWatch } from "@grokbox/client";

/** Pull-based validation keeps one bounded frame in flight. Cancellation and the
 * window deadline also release an idle (not currently pulling) subscriber. */
export async function bridgeEventStream(response: Response, input: { installationId: string; cursor: string; limit: number; signal: AbortSignal; release: () => void }): Promise<Response> {
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, input.signal]);
  const iterator = decodeObservationWatch(response, { ...input, signal });
  let first: Awaited<ReturnType<typeof iterator.next>>;
  try { first = await iterator.next(); } catch (error) { controller.abort(); await iterator.return(undefined); throw error; }
  if (first.done) { controller.abort(); await iterator.return(undefined); throw new ManagementClientError("protocol_error", "The event stream has no initial frame."); }
  const invocationId = first.value.invocationId;
  let finished = false, output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let pending: typeof first | undefined = first;
  const release = () => { if (!finished) { finished = true; signal.removeEventListener("abort", abort); input.release(); } };
  const abort = () => {
    if (finished) return;
    release(); output?.error(new Error("event_stream_interrupted"));
    void iterator.return(undefined).catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) { output = value; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); },
    async pull(output) {
      if (finished) return;
      try {
        const item = pending ?? await iterator.next(); pending = undefined;
        if (finished) return;
        if (item.done) { release(); output.close(); return; }
        output.enqueue(new TextEncoder().encode(`${JSON.stringify(item.value)}\n`));
        if (item.value.data.kind === "end") { release(); output.close(); controller.abort(); await iterator.return(undefined); }
      } catch (error) {
        if (finished) return;
        const known = error instanceof ManagementClientError;
        output.enqueue(new TextEncoder().encode(`${JSON.stringify({ schemaVersion: API_VERSION, installationId: input.installationId, invocationId,
          ok: false, error: { code: known ? error.code : "unavailable", message: known ? error.message : "The event connection was interrupted. Resume from the last verified cursor." } })}\n`));
        release(); output.close(); controller.abort(); await iterator.return(undefined);
      }
    },
    async cancel() { release(); controller.abort(); await iterator.return(undefined); },
  }, { highWaterMark: 1 });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-accel-buffering": "no" } });
}
