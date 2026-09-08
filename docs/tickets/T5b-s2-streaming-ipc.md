# T5b — S2 streaming IPC

## Goal
True streaming frames on `modeld.sock` (backpressure / cancel-of-partial). Host-facing `fullStream` is not empty-by-policy.

## Status
**done.** Submit writes `{ method: "chunk", part }` frames as `complete({ onPart })` emits, then a terminal `{ method: "submit", parts, ... }`. `callStubModeld` reads until the terminal frame. Socket close still aborts admit. Host route driver `delivery: "stream"` already replays buffered parts onto `fullStream` (not empty-by-policy).

## Fence
No Host re-adopt required. Preload/seam stay Effect-free; server lifecycle is E3 `modeld-serve.ts`.
