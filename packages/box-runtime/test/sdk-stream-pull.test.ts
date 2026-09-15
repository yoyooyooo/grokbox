import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { nextSdkStreamPart } from "../src/internal/backends/ai-sdk.ts";

const listeners = (signal: AbortSignal) => getEventListeners(signal, "abort").length;

test("SDK pulls release their listener after every value and EOF, not just at stream close", async () => {
  const controller = new AbortController();
  let index = 0;
  const iterator: AsyncIterator<number> = {
    next: async () => index < 1024 ? { done: false, value: index++ } : { done: true, value: undefined },
  };
  for (let i = 0; i < 1024; i++) {
    const next = nextSdkStreamPart(iterator, controller.signal);
    expect(listeners(controller.signal)).toBe(1);
    expect(await next).toEqual({ done: false, value: i });
    expect(listeners(controller.signal)).toBe(0);
  }
  expect(await nextSdkStreamPart(iterator, controller.signal)).toEqual({ done: true, value: undefined });
  expect(listeners(controller.signal)).toBe(0);
});

for (const synchronous of [false, true]) {
  test(`SDK pull releases its listener and preserves a ${synchronous ? "synchronous" : "promise"} failure`, async () => {
    const controller = new AbortController();
    const error = new Error("synthetic pull failure");
    const iterator: AsyncIterator<unknown> = {
      next: () => {
        if (synchronous) throw error;
        return Promise.reject(error);
      },
    };
    await expect(nextSdkStreamPart(iterator, controller.signal)).rejects.toBe(error);
    expect(listeners(controller.signal)).toBe(0);
  });
}

test("an already aborted SDK pull does not advance the iterator or install a listener", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const iterator: AsyncIterator<unknown> = { next: async () => { calls++; return { done: true, value: undefined }; } };
  await expect(nextSdkStreamPart(iterator, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(0);
  expect(listeners(controller.signal)).toBe(0);
});

test("cancellation settles a blocked SDK pull and consumes a later losing rejection", async () => {
  const controller = new AbortController();
  let rejectPull!: (error: Error) => void;
  const iterator: AsyncIterator<unknown> = {
    next: () => new Promise((_, reject) => { rejectPull = reject; }),
  };
  const next = nextSdkStreamPart(iterator, controller.signal);
  const rejected = next.catch((error: unknown) => error);
  expect(listeners(controller.signal)).toBe(1);
  controller.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(listeners(controller.signal)).toBe(0);
  rejectPull(new Error("synthetic late rejection"));
  // The test runner also reports any unhandled rejection from the losing pull.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const synchronous of [false, true]) {
  test(`cancellation during next() consumes a ${synchronous ? "synchronous" : "promise"} failure`, async () => {
    const controller = new AbortController();
    const iterator: AsyncIterator<unknown> = {
      next: () => {
        controller.abort();
        const error = new Error("synthetic failure after cancellation");
        if (synchronous) throw error;
        return Promise.reject(error);
      },
    };
    await expect(nextSdkStreamPart(iterator, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(listeners(controller.signal)).toBe(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

test("cancelling one SDK pull does not cancel a sibling stream", async () => {
  const a = new AbortController();
  const b = new AbortController();
  let resolveB!: (value: IteratorResult<string>) => void;
  const first = nextSdkStreamPart({ next: () => new Promise<IteratorResult<string>>(() => {}) }, a.signal);
  const second = nextSdkStreamPart({ next: () => new Promise<IteratorResult<string>>((resolve) => { resolveB = resolve; }) }, b.signal);
  const rejected = first.catch((error: unknown) => error);
  a.abort();
  expect(await rejected).toMatchObject({ name: "AbortError" });
  expect(b.signal.aborted).toBe(false);
  expect(listeners(a.signal)).toBe(0);
  expect(listeners(b.signal)).toBe(1);
  resolveB({ done: false, value: "sibling value" });
  expect(await second).toEqual({ done: false, value: "sibling value" });
  expect(listeners(b.signal)).toBe(0);
});
