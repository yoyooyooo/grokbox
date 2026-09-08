# T5b — S2 streaming IPC

## Goal
True streaming frames on `modeld.sock` (backpressure / cancel-of-partial). Host-facing `fullStream` is not empty-by-policy.

## Status
**Framing done; Host streaming follow-through open.** Submit writes `{ method: "chunk", part }` frames as `complete({ onPart })` emits, then a terminal `{ method: "submit", parts, ... }`. `callStubModeld` reads until the terminal frame. Socket close still aborts admit. Host route driver `delivery: "stream"` replays buffered parts onto `fullStream`, but still waits for the complete terminal response.

Complete the bounded Host consumer, terminal-only outcome and backpressure/cancellation proof under A8 / Phase 1 of the [implementation plan](../roadmap/box-runtime-plan.md). Framing alone is not end-to-end first-token evidence.

## Fence
No Host re-adopt required. Preload/seam stay Effect-free; server lifecycle is E3 `modeld-serve.ts`.
