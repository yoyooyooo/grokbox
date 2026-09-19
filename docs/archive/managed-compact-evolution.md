# Managed compact evolution — historical explanation

Scope: early planning and observations summarized on 2026-09-12. This is not a current compact procedure, deployment receipt or authorization. Current mechanics are [context maintenance](../runtime/context.md); active proof responsibilities are [runtime-T32](../tickets/T32-runtime-confirmed-compact.md), [Host-T32](../tickets/T32-host-compact-seam.md) and [T35](../tickets/T35-host-compact-wait-point.md).

## Why timer-only recovery was insufficient

The early fixed Host sequence recorded STEP identity, began executeToolStream, optionally began a background summary, closed the step and only then registered its compact slot. A smaller model window could overflow on the very first request, before recovery was available, or while another summary blocked it.

Fast disconnect/unready/blocked and a roughly five-second wait expiry were distinct observations. Classifier success, a control-frame log or a smaller message count did not prove a legal resume. Increasing a timer did not repair registration order or establish root/ctx validity.

The considered alternatives were repairing the real wait-point/lifetime, improving diagnostic attribution, and deferring the fast-overflow case to a slower trigger. The first became the implementation direction; diagnostics complemented it. Waiting for a convenient trigger could not cover an actual first-request overflow. That decision is historical, not a fresh A/B/C approval question.

## Reasons that remain useful

Host ownership of summary policy, partition, carrier, archive, root and persistent acceptance was intentional. Managed attempts keep the original TURN/STEP/binding, while an external summarizer must not re-enter the same waiting managed STEP. Neither a second compressor, prompt reconstruction from presentation data nor outer-Host new-STEP retry can replace bounded recovery.

Registration before inference is necessary but insufficient: actual root/ctx readiness, one summary owner, parent deadline, cancellation/generation fences and control of outer retry also matter. Later proactive local context maintenance adds earlier checks; it does not erase these failure-recovery constraints.

## Historical interpretations later corrected

Local harness-stick had been treated as progress; original Server evidence instead exposed a Server-temporal/local-box conflict. A conflicting identity became a preserved rejection sample, not a positive heavy canary. A stable profile does not prove the original App uses the same input path.

Working was not merely a pixel issue after a currentActivity field appeared. Running, composing, named activity, per-message streaming and client sending state have distinct scopes. Actual App and source/generation proof is required; clearing caches is not semantic qualification.

Model capacity/usage could not remain postponed when the daily-use contract depended on real budgets, Memory and restart continuity. Historical GATE unlocks, process IDs, old preload fingerprints, worker preferences and temporary routines were window facts, not future permissions.

Branch commit counts were not an implementation-difference oracle. Some changes had been ported or were patch-equivalent; any later worktree cleanup must inspect current dirty/untracked/active references rather than use this historical summary as deletion approval.

## Provenance and preservation

Exact previous summary:

```bash
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/reports/2026-09-12-managed-compact-evolution.md
```

The earlier summary referenced sanitized pre-publication revisions and private machine receipts. They are not public CI inputs, and their missing content cannot be reconstructed as fact. No raw Host dump, user conversation or credential is copied here. Current evidence, blockers and next live action remain only in [LIVE](../tickets/LIVE-integration-validation.md), with fixed window reports linked there.
