import { STREAM_STORAGE_CHARS } from "@grokbox/runtime-kernel/contract";
export type ReplayTextCodec<T> = { read: (part: T) => { key: string; text: string } | undefined; withText: (part: T, text: string) => T };
type Entry<T> = { part: T; delta?: { key: string; text: string }; sealed: boolean };
/** Per-reader cursors never drive production. Optional text compaction stores
 * bounded chunks rather than one object per transport delta. Each reader owns
 * a character offset into the mutable tail: appending cannot replay old text,
 * skip new text, or mutate an already yielded object. Late readers may receive
 * differently sized deltas, with exactly the same ordered content. */
export function replayStream<T>(codec?: ReplayTextCodec<T>) {
  const parts: Entry<T>[] = [];
  const readers = new Set<() => void>();
  let closed = false, retainedBytes = 0;
  const wake = () => { for (const reader of [...readers]) reader(); };
  const done = (): IteratorResult<T> => ({ done: true, value: undefined });
  return {
    push(part: T) {
      if (closed) return;
      const delta = codec?.read(part);
      if (!delta) {
        if (parts.length) parts.at(-1)!.sealed = true;
        parts.push({ part: structuredClone(part), sealed: true });
        retainedBytes += 192 + 2 * (JSON.stringify(part)?.length ?? 0);
      } else {
        for (let offset = 0; offset < delta.text.length;) {
          let tail = parts.at(-1);
          if (!tail?.delta || tail.sealed || tail.delta.key !== delta.key) {
            if (tail) tail.sealed = true;
            tail = { part: structuredClone(codec!.withText(part, "")), delta: { key: delta.key, text: "" }, sealed: false };
            parts.push(tail); retainedBytes += 192 + 2 * delta.key.length;
          }
          const take = Math.min(STREAM_STORAGE_CHARS - tail.delta!.text.length, delta.text.length - offset);
          tail.delta!.text += delta.text.slice(offset, offset + take); offset += take; retainedBytes += take * 2;
          if (tail.delta!.text.length === STREAM_STORAGE_CHARS) tail.sealed = true;
        }
      }
      wake();
    },
    /** Accounting estimate for retained UTF-16 data/record overhead, not heap telemetry. */
    storage: () => ({ records: parts.length, estimatedBytes: retainedBytes }),
    close() { closed = true; if (parts.length) parts.at(-1)!.sealed = true; wake(); },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let index = 0, offset = 0, ended = false;
        const pending: Array<(result: IteratorResult<T>) => void> = [];
        const drain = () => {
          while (pending.length) {
            if (ended) { pending.shift()!(done()); continue; }
            const entry = parts[index];
            if (!entry) { if (closed) { pending.shift()!(done()); continue; } break; }
            if (entry.delta) {
              if (offset < entry.delta.text.length) {
                const text = entry.delta.text.slice(offset); offset = entry.delta.text.length;
                pending.shift()!({ done: false, value: structuredClone(codec!.withText(entry.part, text)) });
              }
              if (offset === entry.delta.text.length && entry.sealed) { index++; offset = 0; continue; }
              break;
            }
            index++; offset = 0;
            pending.shift()!({ done: false, value: structuredClone(entry.part) });
          }
          if (!pending.length) readers.delete(drain);
        };
        return {
          next: () => ended ? Promise.resolve(done()) : new Promise((resolve) => { pending.push(resolve); readers.add(drain); drain(); }),
          return: () => { ended = true; drain(); readers.delete(drain); return Promise.resolve(done()); },
        };
      },
    } satisfies AsyncIterable<T>,
  };
}
