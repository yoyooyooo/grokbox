# T7 — Prove official replacement via Gateway pid

## Goal
Land `waitOfficialReplacement`: after TERM, process-visible new Host is not enough. Gateway pid must equal that Host. Pin the first eligible candidate; do not chase a later generation.

## Design
- `official-chain.ts` owns the bounded poll (`now` / `sleep` injectable).
- Coordinator, H3 adopt deactivate, and live readopt call it.
- Transient-adopt deactivate distinguishes `replacement-gateway-unproven` (Host visible, Gateway mismatch) vs `replacement-unproven`.
- Stale `recovery-required` journals may settle to `direct-official` only when the journal host is gone and Gateway matches the unique official Host.

## Status
**done.** Offline fake-tree tests cover unpublished Gateway, timeout, death, PID reuse, competing Host, delayed Gateway publish, and journal settle.

## Fence
No T3 live/canary/spend, no T5b/S2, no envelope one-liner / root `src/`.
