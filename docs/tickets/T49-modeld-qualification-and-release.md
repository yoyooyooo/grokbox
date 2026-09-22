# T49 — Policy, hot-path qualification and controlled release

Status: linearly integrated into v2 and combined-candidate offline gates verified; independent review externally blocked (`review_pending`); current live disposition is maintained only in the linked LIVE rows. Milestone M4. Depends on: [T43](T43-modeld-authority-baseline.md) through [T48](T48-modeld-causal-observation.md), with their scoped offline exits and fixed-tip review. Spec: [S10.1, S10.7–S10.8](../roadmap/box-runtime-impl-spec.md#modeld-effect-core).

## Live acceptance route

For current proved scope, missing native/App/rollback evidence, blockers and next actions, read the [LIVE index](LIVE-integration-validation.md#live-modeld-native) and its related MODELD rows. The [window index](LIVE-integration-validation.md#window-20260917) links fixed-run reports. This ticket owns the G0–G6 contracts and source/review gates; dated receipts below retain only their original scope and do not maintain current deployment status.

## Core-runtime adoption scheduling

The accepted [core adoption boundary](../roadmap/agent-first-cli/spec.md#core-runtime-adoption) allows a fully qualified runtime to be adopted within W3 before the complete management product and custom Web UI. [Route R](../roadmap/agent-first-cli/routes/r-managed-runtime.md) owns the execution work; [Q](../roadmap/agent-first-cli/routes/q-integration-and-qualification.md) joins the fixed candidate and independent review. All applicable G0–G6 obligations below remain: current native/worker and deployed patch closure, real model matrix, original App, tools/auxiliary Memory/checkpoints, recovery/official return, necessary protection and bounded sustained operation. Scope is not permission to skip a reachable safety dependency.

J2 authorizes only a separately approved controlled adoption window after pre-adoption qualification; actual loaded/live evidence is produced afterward for J3. The user accepts the proven core at J4; the [core LIVE aggregate](LIVE-integration-validation.md#core-runtime-lane) does not mark incomplete full-product scenarios passed or grant public release. Unrelated Web/material-management/advanced handover completion is not a new prerequisite for G6 runtime proofs.

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

**G2 behavior/attribution:** isolated unpatched official, patched official passthrough and patched managed comparison; native stop/pause/migration, final tool consumer and restore evidence. Missing native inputs must return missing-proof status, never silently replace them with fake JSON. Schedule and receipts live in [LIVE-MODELD-NATIVE](LIVE-integration-validation.md#live-modeld-native), [AUTHORITY](LIVE-integration-validation.md#live-modeld-authority) and [TOOLS](LIVE-integration-validation.md#live-modeld-tools); this feature ticket still owns their required semantics.

**G3 policy:** strict five-second baseline remains default unless an explicit fixed alternative is approved and tested. For any fifteen-second candidate state the enlarged unobserved-revocation window, source guarantee limitations, supported delays and failure budget. Do not dynamically adapt permission age to source latency. Source failure/timeout and freshness success are separate cases.

**G4 performance:** frozen comparable workload with controlled source/storage/provider delays. Record native reads per STEP, source/waiter/queue/fence/lock/storage time, event-loop lag, cancellation delay, peak resources and cleanup. Prove request demand does not grow with token/fragment count and one blocked Bot does not indefinitely stall unrelated cancellation. Do not invent a production SLA or percent improvement from synthetic time.

**G5 independent review:** complete applicable independent review on the integrated functional candidate, with fixed-content fixes and revalidation. Development checks are scoped to changed properties; this is not a deployment/review ceremony for every commit. P0/P1 regressions block qualification. Historical review gaps remain attached to the affected old content; reused paths require current scrutiny, not automatic inheritance or blanket old-window closure.

**G6 live:** qualify the integrated core-runtime or full-product candidate under its explicit [current LIVE scope](LIVE-integration-validation.md#core-runtime-lane), not a retired v2 rollout; v2 integration alone is not deployment qualification. Bind artifacts, targets, source/profile, permissions and request/cost bounds. Use the real lifecycle owner, preserve native state and unknown effects, then verify authority/tools/terminals, App and accepted recovery properties. Safe stop, repair/reinstall or qualified official exit can be the recovery target; generic old-schema downgrade and continuous service throughout development are not required. No global shim or active service adopts a construction worktree. Old integration receipts authorize neither new live actions nor public release.

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

**Current integration receipt (2026-09-17):** under the user's explicit linear-integration instruction, eleven feature commits were rebased onto existing v2 `36e6dc5`, preserving its MiniMax/provider/delivery fixes, and v2 was fast-forwarded to `b57574844428219ead9b9ee18dce90ad3c8535fc`. [The integration report](../reports/2026-09-17-modeld-v2-integration.md) maps all original commits to their rebased counterparts and records actual conflict handling and the combined tree's typecheck, 66 targeted tests, 2054-pass full suite with six native skips, and 424-pass rebuilt offline release aggregate. No merge commit, remote push or live cutover occurred. G5 remains explicitly pending. Historical reports below retain the hashes of the trees they actually tested; they do not replace this combined-candidate verification.

Implemented: all finite `verify:modeld-core` cases route to executable production-path suites. `release-offline` aggregates lifecycle/evidence/state/authority/observation, packed Node replacement, import/provenance and package/privacy checks. The runner records exact source revision/digest, installed SDK/compiler pins and explicit native/review/live claim limits; source changes during proof fail the run.

`benchmark:modeld-core -- --baseline-root <clean-checkout>` compares the same production source/Unix/LevelDB workload in separate isolated processes, not a duplicated legacy simulator. It checks four sequential STEPs at one versus 2,048 output fragments, first-read delays of 5.5/7.75/9 seconds with a fast second read, and cancellation during initial source waiting. Both source trees are checked for drift; mismatched workloads, duplicate model calls, missing terminal/cleanup or a failed candidate do not yield a passing comparison. Per-case timings, native/full/local read counts, recorded queue/source/local-witness waits, lock/storage totals, event-loop observations and cancellation settlement are returned without private machine roots. Native server processing time and a production SLA remain unobserved.

G3 remains the strict five-second policy. Slow first observations are discarded; success in these vectors requires a distinct fresh read within the unchanged finite budget. Persistently slow reads still refuse, as tested. No fifteen-second policy is enabled.

The [earlier offline report](../reports/2026-09-17-modeld-effect-core-offline.md) is historical evidence for `6d0e914`. The [closeout report](../reports/2026-09-17-modeld-effect-core-closeout.md) records clean candidate `c6156c4`, incorporating deadline fix `743daea`: final typecheck passed; 25 targeted regressions passed; rebuilt `release-offline` passed 424 tests / 47 files; full suite passed 2005 tests with five explicit native skips / 0 failures across 258 files. The clean baseline benchmark was rerun on this candidate and retained its behavior/cleanup oracles. Exact source/artifact digests and dependency reality are in that report, not inferred from historical counts.

G0/G1 and the stated G4 vectors are offline verified; G3 remains strict five seconds. G2/G6 remain required, unsatisfied native/live gates, scheduled in [LIVE](LIVE-integration-validation.md). G5 is a **non-live** code-review gate and remains here: three bounded primary reviewer invocations returned HTTP 503 without a report; one configured same-model alternate route timed out without a report. The closeout report records targets/scope/exits. This is `review_pending`, not a pass, not a Host defect and not something to defer as live-only. T50 remains nonblocking review residue only. Implementation/offline verification, independent review, integration and native/live acceptance are separate claims.
