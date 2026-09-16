# T49 — Policy, hot-path qualification and controlled release

Status: planned; live qualification not started. Milestone M4. Depends on: [T43](T43-modeld-authority-baseline.md) through [T48](T48-modeld-causal-observation.md), with their scoped offline exits and fixed-tip review. Spec: [S10.1, S10.7–S10.8](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Goal

Prove the new single execution path reduces avoidable coordination without weakening identity/replay/cancellation contracts. Decide any freshness-policy change explicitly, qualify exact artifacts and deploy only within an authorized release envelope. A green source suite is not native or production acceptance.

## Module / files

- `scripts/verify-modeld-core.mjs`: `release-offline` aggregate over implemented cases, plus isolated benchmark entry if earned.
- Existing build/package/profile and Node-process proof surfaces.
- Spec policy section, maintainers' boundary/qualification notes and current ticket evidence.
- Native qualification evidence stays in a private authorized environment; public repository retains minimal interoperability facts and synthetic fixtures only.

## Release gates

**G0 source:** typecheck, all new production-path cases, full existing suite, no retired execution path/imports, publication working-tree and history scans.

**G1 artifact:** frozen Node/Bun/Effect/SDK/storage pins, complete build, independent installed-package entry, Host import contribution, wire/profile capability matrix and old-peer rejection. Exact test inputs and tip must be fixed before review.

**G2 behavior/attribution:** isolated unpatched official, patched official passthrough and patched managed comparison; native stop/pause/migration, final tool consumer and restore evidence. Missing native inputs must return missing-proof status, never silently replace them with fake JSON.

**G3 policy:** strict five-second baseline remains default unless an explicit fixed alternative is approved and tested. For any fifteen-second candidate state the enlarged unobserved-revocation window, source guarantee limitations, supported delays and failure budget. Do not dynamically adapt permission age to source latency. Source failure/timeout and freshness success are separate cases.

**G4 performance:** frozen comparable workload with controlled source/storage/provider delays. Record native reads per STEP, source/waiter/queue/fence/lock/storage time, event-loop lag, cancellation delay, peak resources and cleanup. Prove request demand does not grow with token/fragment count and one blocked Bot does not indefinitely stall unrelated cancellation. Do not invent a production SLA or percent improvement from synthetic time.

**G5 independent review:** one review, fix, one re-look per milestone per project process. Fixed-tip P0/P1 regressions block. No self-signed production acceptance or model-name build dependency. Honest nonblocking residuals go to T50; failed mandatory gates do not.

**G6 live:** explicit target(s), exact artifacts, source/profile preflight, provider request/cost limit and stop conditions. Drain/stop new managed work, terminate old service generation without replay, switch Host/preload/modeld together, then bounded canary. Restore prior artifact/policy on failure; never replay failed messages or copy live permits across generations. Original v2 and other Bots remain untouched until a separately authorized integration/release action.

## Acceptance

```bash
bun run typecheck
bun run verify:modeld-core -- release-offline
bun test
bun run verify:package
bun run check:publication
bun run check:publication:history
```

The commands above close only G0/G1 and those G4 scenarios actually executed. G2/G3/G5/G6 require their own evidence, not a success flag emitted by these commands. No implicit push, merge into v2, service restart, forced adoption, native upgrade or provider spend is granted by running a verifier.

## Forbidden / non-goals

No dependency sweep, generic performance platform, automatic repair/monitoring, old/new dual execution mode, policy changes disguised as observability, reassignment of user's production Bot, or silently skipped mandatory proof. No long-lived canary/listener left after a bounded run.

## Exit evidence

Pending for each gate separately. Implementation complete, offline-qualified, independently-reviewed, native-qualified and live-released must be reported as distinct states. A release blocker is not closed by creating a residue item.
