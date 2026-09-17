# T45 — Typed evidence and service-owned shared source lifetime

Status: implemented and integrated with T47; final qualification and independent review tracked by T49. Milestone M1. Depends on: [T43](T43-modeld-authority-baseline.md), [T44](T44-modeld-service-lifetime.md). Spec: [S10.2–S10.4](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

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

Implemented in the production modeld Layer: a service-scoped coordinator with per-request waiters, bounded source slots and fair eligible-capacity queue; independent source/waiter deadlines; remote-only cache with fresh native local witnesses before/after every use; typed trusted admission results; safe per-waiter/source correlation. The existing native bridge now accepts a distinct local-only capability, shares only in-flight native work, and does not keep a completed registration cache. It tracks uncooperative native work until actual settlement and preserves cancellation origin. Both source and local-witness transport promises are physically bounded after interruption.

The isolated `evidence` proof initially passed 120 tests across 12 suites with a fresh build, including actual packed Node/preload -> production modeld Unix -> fake provider. A complete repository run passed 1956 tests / 5 explicit native qualification skips / 0 failures across 251 files before the final additional local-witness resource tests; the final rerun is recorded below when executed. The strict 5.5/7.75/9-second vectors still reject without renewing evidence. No larger policy or native/live qualification is claimed.

T47 now supplies the single STEP's remaining budget and bounded pre-terminal recovery allowance. The coordinator repeats only eligible read acquisition, with bounded jitter and no provider/STEP replay; successful recovery retains the first failure reason and elapsed time rather than hiding a stale first observation. Queued time, source wait and current local-witness time are separately observed. A scope invalidation observed by another request wakes existing waiters immediately while retaining the uncooperative source's physical slot until actual settlement.

Priority classes for monitor/refresh are not invented: only active execution readers use this pool, while direct CLI/monitor inspection retains its independent bounded native path. There is no autonomous refresh loop. T48 carries the public status/progress projection. The initial foundation counts above are historical, not the final candidate's qualification.

Independent fixed-tip review and native consumer/release gates remain pending in T49. The production-program synthetic recovery chain is implemented; it does not demonstrate current official Server latency, native tool execution or a production release.
