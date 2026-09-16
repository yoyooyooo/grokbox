# Modeld execution-core consolidation

Status: accepted architecture target, 2026-09-16. Implementation and release qualification are separate. The single build bible remains [Box-runtime Spec S10](../roadmap/box-runtime-impl-spec.md#modeld-effect-core); [T43–T50](../tickets/README.md#modeld-effect-core) carry scope and completion evidence.

## Context

Managed inference already runs through Effect, a durable STEP identity index, a bounded Unix service and a narrow native Host bridge. The remaining pressure is not lack of an Effect dependency. It is fragmented ownership: native shared-read lifetime belongs to the first waiter, authority re-reads deployment and registration together, coarse failure handling closes turns, and storage/maintenance can hold a global state update across I/O.

`ownership_evidence_stale` after a slow successful List and `server_read_failed` with a shared cancelled read are two different paths. Slow upstream behavior can trigger an incident while grokbox policy and coordination amplify its impact. A registration list has not been established as a revocable execution lease.

## Decisions

1. **Consolidate, do not replace the product.** Keep one package graph, one execution kernel, one execution-history writer and the existing Host-owned Agent loop/tools/store/delivery. No new daemon, identity database, general Actor framework, SDK tool executor or frontend.
2. **Audit native coverage before deleting gates.** Per-Agent/per-TURN identity, pause/migration, revocation, model dispatch and tool consumption must be separately proven. Current allowed/bound booleans do not prove all of these. Until the proof exists, retain the supplemental Server evidence gate. Do not ship native/polling dual execution modes.
3. **Separate responsibility from severity.** Integration obligations, self-introduced defects/policy, external triggers, proven upstream defects, normal behavior and unresolved attribution have different owners. Source location or temporal correlation is not causal proof. Cross-identity/replay/terminal-resurrection defects block release regardless of origin.
4. **Effect owns orchestration.** One logical service acquisition program; service-owned shared reads; STEP-owned waiters/streams; TURN-owned pinned resources; explicit cleanup and unknown outcomes. Callback/Promise syscall adapters remain thin. Failure, defect, interruption and uncertain external settlement remain distinct.
5. **Separate evidence from permission and observation.** A live, bounded evidence pool may serve execution. Only the kernel decides at side-effect boundaries. SQLite, alerts, titles, last-known snapshots and CLI receipts cannot grant or restore authority.
6. **Wait before terminal, never replay after terminal.** Temporary evidence gaps can wait within one claimed STEP and one remaining deadline. Explicit invalidation fences immediately. Published terminal, closed TURN or retired service epoch cannot be revived. Waiting after inference cannot call inference again.
7. **Remove avoidable hot-path coordination.** Use qualified evidence at multiple checkpoints while rechecking local fences. Serialize by execution identity; do not hold a global mutable-state lock across unrelated slow storage/maintenance. Durable claims still precede effects. Remove repeated deployment I/O only after an effective invalidation protocol is proven.
8. **Do not silently weaken freshness.** Keep request-start conservative aging and strict existing defaults during structural replacement. A larger fixed window is a separately reviewed policy change. No RTT subtraction, completion-time renewal or adaptive permission widening. The previously discussed 15/30/2-second numbers are candidates, not accepted defaults.
9. **Do not couple diagnostics to execution uptime.** CLI can inspect through the existing native read when modeld is unavailable; it cannot authorize managed execution. Monitor and its database remain independently fallible. Refresh exists only for bounded live demand; no perpetual execution keepalive.
10. **Keep dependency and Host boundaries stable.** Retain the exact Effect, SDK, Bun and storage pins. Host/preload stays Effect-free and SDK-free. J13 journal placement is unchanged. A necessary new wire frame requires explicit version/capability qualification, not silent compatibility.
11. **One implementation, three evidence realities.** Test the production program with substitute capabilities; qualify unpatched official, patched official passthrough, and patched managed paths independently in isolated fixed-version environments. Fake qualification cannot become a live claim.
12. **Independent integration line.** Start from a clean v2 commit and use a dedicated worktree/branch, with one writer. No implicit merge into v2, push, live deployment or provider spend. Milestone commits, review and final release gates are explicit.

## Consequences and rejected alternatives

- This may expose necessary residual refusal under sustained source latency: a strict five-second policy cannot admit a nine-second observation without a different qualified source or an explicit policy change.
- Refactoring only error strings, changing five to fifteen, or wrapping the current Promise workflow in Effect is insufficient.
- A complete greenfield rewrite would discard earned compatibility and durable-claim properties without establishing better authority. Reuse the existing kernel and replace the affected mechanisms in place.
- Moving every file read into a perpetual cache is rejected: notification/watch loss and foreign mutation must invalidate or force re-verification, not create permanent authority.
- A second control-plane owner, observer-driven auto-repair, cross-restart workflow resumption and distributed execution leases are not this delivery.

## Decision evidence and invalidation

[Authority boundary audit](../maintainers/modeld-authority-boundaries.md) records source anchors and unknowns. Exact native profile, wire, policy, credential binding, lifecycle or final writer changes require re-evaluating the affected proof; ordinary source refactoring does not qualify a running deployment.

This ADR changes accepted architecture, not historical incident data or upstream promises. Only tickets with executable proof and independent review can close; live qualification remains its own gate.
