/** Node 20 baseline: fan in cancellation without AbortSignal.any or retained listeners after completion. */
export function combineAbortSignals(signals: readonly AbortSignal[]): { signal?: AbortSignal; dispose: () => void } {
  const sources = [...new Set(signals)];
  if (sources.length < 2) return { signal: sources[0], dispose() {} };
  const controller = new AbortController();
  const abort = () => { controller.abort(); dispose(); };
  const dispose = () => { for (const source of sources) source.removeEventListener("abort", abort); };
  for (const source of sources) {
    if (source.aborted) { abort(); break; }
    source.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}
