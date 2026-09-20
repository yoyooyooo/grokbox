import type { Writable } from "node:stream";

/** At most one pending frame. A stalled pipe cancels this CLI observation, never
 * the Server's collector or a previously submitted domain operation. */
export function writeStreamOutput(stream: Writable, chunk: string, signal?: AbortSignal): Promise<void> {
  const deadline = AbortSignal.timeout(5000), bounded = signal ? AbortSignal.any([deadline, signal]) : deadline;
  return new Promise((resolve, reject) => {
    const cleanup = () => { bounded.removeEventListener("abort", stop); stream.off("error", stop); stream.off("close", stop); };
    const stop = () => { cleanup(); reject(new Error("stream_output_unavailable")); };
    if (bounded.aborted || stream.destroyed) return stop();
    bounded.addEventListener("abort", stop, { once: true }); stream.once("error", stop); stream.once("close", stop);
    try { stream.write(chunk, error => { cleanup(); error ? reject(new Error("stream_output_unavailable")) : resolve(); }); } catch { stop(); }
  });
}
