# T49 — Policy, hot-path qualification and controlled release

Status: fixed-candidate offline aggregate/full suite and benchmark executed; final typing/timeout integration, independent/native/live gates remain open. Milestone M4. Depends on: [T43](T43-modeld-authority-baseline.md) through [T48](T48-modeld-causal-observation.md), with their scoped offline exits and fixed-tip review. Spec: [S10.1, S10.7–S10.8](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

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

Implemented: all finite `verify:modeld-core` cases route to executable production-path suites. `release-offline` aggregates lifecycle/evidence/state/authority/observation, packed Node replacement, import/provenance and package/privacy checks. The runner records exact source revision/digest, installed SDK/compiler pins and explicit native/review/live claim limits; source changes during proof fail the run.

`benchmark:modeld-core -- --baseline-root <clean-checkout>` compares the same production source/Unix/LevelDB workload in separate isolated processes, not a duplicated legacy simulator. It checks four sequential STEPs at one versus 2,048 output fragments, first-read delays of 5.5/7.75/9 seconds with a fast second read, and cancellation during initial source waiting. Both source trees are checked for drift; mismatched workloads, duplicate model calls, missing terminal/cleanup or a failed candidate do not yield a passing comparison. Per-case timings, native/full/local read counts, recorded queue/source/local-witness waits, lock/storage totals, event-loop observations and cancellation settlement are returned without private machine roots. Native server processing time and a production SLA remain unobserved.

G3 remains the strict five-second policy. Slow first observations are discarded; success in these vectors requires a distinct fresh read within the unchanged finite budget. Persistently slow reads still refuse, as tested. No fifteen-second policy is enabled.

The [fixed-candidate offline report](../reports/2026-09-17-modeld-effect-core-offline.md) records source commit/digest, 416-test release aggregate, 1997-pass full suite with five explicit native skips, the clean baseline comparison and exact remaining claim limits. The final-tree typecheck did not execute and the outer/inner full-budget timeout interaction is not signed; G0 therefore remains partially verified, not complete. G2 (actual native triptych and final tool consumer), G5 (independent fixed-tip review) and G6 (authorized live cutover) remain required and unsatisfied until their own receipts exist. Code/test completion must not mark these gates done or move them to T50 as optional residue.
