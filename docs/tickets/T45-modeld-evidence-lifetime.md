# T45 — Typed evidence and service-owned shared source lifetime

Status: planned. Milestone M1. Depends on: [T43](T43-modeld-authority-baseline.md), [T44](T44-modeld-service-lifetime.md). Spec: [S10.2–S10.4](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Replace first-waiter-owned native reads with explicit source-operation and waiter lifetimes. Preserve authentication ownership, original evidence age, local before/after fences and source failure provenance. Implement source sharing at its true resource owner, not by adding retries at each caller.

## Module / files

- `runtime-kernel/src/internal/contract/authority-policy.ts`, `ownership.ts`, `ownership-observation.ts`, `ports.ts`: finite policy/evidence/error contracts and safe observation.
- `box-runtime/src/internal/io/ownership-coordinator.node.ts`: service Scope, demand/queue/cache/source state, Effect waiting and cancellation.
- `box-runtime/src/internal/io/ownership-admission.node.ts`: same pure classifier, native snapshot adapter, no duplicate policy.
- `box-runtime/src/internal/host/ownership-read.ts`, `ownership-slices.ts`, `preload.ts`: thin credential-owning native bridge with finite source guard and causal DTO.
- `cli/src/runtime-ownership.ts`: existing authenticated transport injection; no second credential store.

## Required behavior

One source operation has a fixed original start/deadline/scope/generation/coverage and operation ID. Waiters have their own IDs/deadlines/cancellation and never renew the source or its evidence. A caller leaving must not abort other valid waiters; source timeout has the same cause for every waiter. A source that ignores cancellation remains tracked until it really settles, with a bounded outstanding-operation count.

Compatible requests share; uncovered targets cannot borrow evidence. Queue/demand/source concurrency are bounded. Execution demand outranks observation without starvation. Account/team/backend/machine/Host generation changes invalidate incompatible evidence, and late results cannot repopulate the new scope. No live demand means no execution refresh loop.

The current Host snapshot mixes remote registration with local scope/migration/execution facts. Never cache and replay that complete snapshot as a new local witness. The source adapter must expose a finite, version-qualified local-only witness through the existing Host bridge; cache only the remote part, and recheck current native identity/pause/binding plus Host generation before each proposed permit. A peer missing the local witness capability cannot silently receive the optimization. This is a required security vector, not an optional performance detail.

Use the pinned `Clock.monotonicTimeNanos` for elapsed budgets; `Clock.currentTimeNanos` is wall time, despite its name. A shared source operation and a later local witness must retain separate original timestamps and scope identity.

Only one coordinator owns finite read recovery. Classify source deadline, waiter deadline, caller cancellation, scope/generation invalidation, transport cancellation and unknown cancellation origin separately. `rpcCode=1` alone is not a cancellation-owner proof. A diagnostic direct read stays available without modeld and cannot grant execution fallback.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- evidence
```

Add deterministic production-function tests for: slow 5.5/7.75/9 s source without age renewal; source cancellation with a late waiter; first waiter cancelled while another succeeds; all waiters gone; source that ignores abort; cancellation during scope-before/after; old-generation late success; missing target coverage; bounded fanout; original cause retained through CLI/kernel projection; no token/body/credential leakage.

Use the pinned Effect TestClock and explicit barriers where Effect owns time. Native adapter tests may inject a clock/source without cloning the workflow. Existing scoped-cache/native-pause/ownership-observation-unix/packed-client tests remain required. Strict defaults must still refuse evidence older than five seconds; larger-window scenarios use a clearly selected validated test policy, not global mutation.

## Forbidden / non-goals

No response-time freshness renewal, adaptive authority widening, silent service restart, permanent bot keepalive, universal collector, SQLite authority cache, new credentials, generic RPC export or duplicate Promise/Effect business implementation. Host/preload remains Effect-free. No claim that a client-side clock establishes upstream snapshot consistency or a lease.

## Exit evidence

Pending: typed contract, production wiring, cancellation/freshness proof and fixed-tip review. Exposing a new DTO without changing lifetime ownership does not complete the ticket.
