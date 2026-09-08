# T13 — Status honesty after adopt

## Status
**Open · product-scope tracker, not an implementation lane.** Rebuild execution is [T27](T27-runtime-status-facets.md) (early Phase 1) and [T33](T33-runtime-diagnostics.md) (Phase 4), under the [implementation spec](../roadmap/box-runtime-impl-spec.md#status-journal). Do not implement another status path in this ticket or wait for T14b samples.

## Goal
Separate current serving/coverage evidence, controller liveness, mutation permission, operation recovery and Host delivery observation. Do not turn attested coverage into a blanket health claim.

## Decision
- `coverage=attested` does not prove watchdog liveness or permission to mutate.
- A stored open circuit may coexist with valid current coverage. Show the mutation inhibit and its reason; keep unobserved liveness unknown.
- An actual pending, invalid or unavailable operation journal remains recovery-required/unknown. Do not hide it behind an old attestation.
- Preserve the circuit fact. The destructive rebuild uses one new facets DTO, not the legacy `watchdog.state=degraded` aggregate or parallel old/new projections.
- Host Transcript publication remains Host-owned. Observe reliable same-source watermarks only when available; otherwise report not_observed. Never replay models/SendToUser or re-adopt because publication is pending.

## Acceptance
- CLI and API expose the same facets and evidence freshness.
- Cover attested + stored inhibit, actual pending journal, invalid/missing evidence and unknown liveness separately.
- Status reads perform no repair, circuit close, signal or provider request.
- Deep publication/operation diagnostics retain source identity and gaps; model terminal is not App delivery.

## Fence
No re-adopt, no secret or provider body in status JSON. The POC `observe.ts` is substrate only; target owners and executable exits are T27/T33, not a compatibility wrapper around the old projector.
