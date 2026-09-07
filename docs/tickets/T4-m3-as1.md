## Goal
Implement / design-lock real model path **A+S1**: AI SDK (or provider SDK) only inside modeld ModeldDriver; buffered collect into existing response-only `complete()` IPC; Host PromptSession remains tool/queue/Transcript/Memory/SendToUser owner.

## Fence
- Reject SDK in preload/seam/session/Host
- No second admission registry; pin/STEP rules as offline-proven
- Credentials: fingerprint-only port inside modeld later (C1) — not this ticket unless needed for dry wiring

## Depends
- Credible stub contract + explicit live stub green under G1 gates before real spend
- Do not install AI SDK “just to look ready” without admit

## Driver
Herdr (grok); astra only on true design blockers.
