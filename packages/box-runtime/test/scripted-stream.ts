import type { StreamPart } from "../src/session.ts";

/** No provider, timer pacing or transport: the test alone releases each producer step. */
export function scriptedStream() {
  const values: IteratorResult<StreamPart>[] = [];
  const readers: Array<(value: IteratorResult<StreamPart>) => void> = [];
  let returned = 0;
  const push = (value: IteratorResult<StreamPart>) => {
    const reader = readers.shift();
    if (reader) reader(value); else values.push(value);
  };
  return {
    push: (part: StreamPart) => push({ done: false, value: part }),
    end: () => push({ done: true, value: undefined }),
    returns: () => returned,
    source: { [Symbol.asyncIterator](): AsyncIterator<StreamPart> { return {
      next: () => values.length ? Promise.resolve(values.shift()!) : new Promise((resolve) => readers.push(resolve)),
      return: () => { returned += 1; while (readers.length) readers.shift()!({ done: true, value: undefined }); return Promise.resolve({ done: true, value: undefined }); },
    }; } } satisfies AsyncIterable<StreamPart>,
  };
}

export async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("offline stream deadline exceeded")), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
