# T13 — Status honesty after live adopt

## Goal
`runtime status` should not look broken when coverage is attested.

## Current (honest but confusing)
After T12 adopt, observed:

- `coverage: attested`, `activation.reconcile: converged`
- `circuit: open`, `coordinator.circuitReason: pending-uncertain`
- `watchdog.state: degraded` because circuit is open (`observe.ts`)
- Host `transcript-publish` `writerSeq` can lead `publishedThroughSeq` (Host-owned; App/CLI may still show recent `send-message`)

Do **not** auto-close the circuit. Decide in Astra whether pending-uncertain should degrade watchdog when coverage is attested.

## Status
**open.** Feature closeout documents the lie; no silent green.

## Fence
No re-adopt, no secret in status JSON.
