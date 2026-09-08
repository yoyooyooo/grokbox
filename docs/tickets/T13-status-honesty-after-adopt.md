# T13 — Status honesty after adopt

## Status
**Open.** Deliver minimal shared status semantics in Phase 1, use them in the Phase 2 console, and extend diagnostics in Phase 4 of the [implementation plan](../roadmap/box-runtime-plan.md). This work does not wait for T14b samples.

## Goal
Separate current serving/coverage evidence, controller liveness, mutation permission, operation recovery and Host delivery observation. Do not turn attested coverage into a blanket health claim.

## Decision
- `coverage=attested` does not prove watchdog liveness or permission to mutate.
- A stored open circuit may coexist with valid current coverage. Show the mutation inhibit and its reason; keep unobserved liveness unknown.
- An actual pending, invalid or unavailable operation journal remains recovery-required/unknown. Do not hide it behind an old attestation.
- Preserve the circuit. Legacy `watchdog.state=degraded` may remain during compatibility migration, with explicit facets/reasons rather than silently changing it to green.
- Host Transcript publication remains Host-owned. Observe reliable same-source watermarks only when available; otherwise report not_observed. Never replay models/SendToUser or re-adopt because publication is pending.

## Acceptance
- CLI and API expose the same facets and evidence freshness.
- Cover attested + stored inhibit, actual pending journal, invalid/missing evidence and unknown liveness separately.
- Status reads perform no repair, circuit close, signal or provider request.
- Deep publication/operation diagnostics retain source identity and gaps; model terminal is not App delivery.

## Fence
No re-adopt, no secret or provider body in status JSON. Source entry: `packages/box-runtime/src/observe.ts`.
