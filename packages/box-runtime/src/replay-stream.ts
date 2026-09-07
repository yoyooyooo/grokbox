/** Per-reader cursors; completion waiters never consume delivery parts. Owner bounds the retained log. */
export function replayStream<T>() {
  const parts: T[] = [];
  const readers = new Set<() => void>();
  let closed = false;
  const wake = () => { for (const reader of [...readers]) reader(); };
  const done = (): IteratorResult<T> => ({ done: true, value: undefined });
  return {
    push(part: T) { if (!closed) { parts.push(structuredClone(part)); wake(); } },
    close() { closed = true; wake(); },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let index = 0;
        let ended = false;
        const pending: Array<(result: IteratorResult<T>) => void> = [];
        const drain = () => {
          while (pending.length && (ended || index < parts.length || closed)) {
            const resolve = pending.shift()!;
            resolve(ended || index >= parts.length ? done() : { done: false, value: structuredClone(parts[index++]!) });
          }
          if (!pending.length) readers.delete(drain);
        };
        return {
          next: () => ended ? Promise.resolve(done()) : new Promise((resolve) => {
            pending.push(resolve); readers.add(drain); drain();
          }),
          return: () => { ended = true; drain(); readers.delete(drain); return Promise.resolve(done()); },
        };
      },
    } satisfies AsyncIterable<T>,
  };
}
