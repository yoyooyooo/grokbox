# T35 — HostCompact wait-point (register before custom-model stream)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open · Phase 4 · queued.** Owner course-correction 2026-09-12: Spec/Ticket-controlled. **Not authorized to implement** until owner picks wait-point (or observation) over park. Execution authority is this ticket + Spec — not roadmap alone.

## Goal
Make the D2 compact **slot** exist before managed `executeToolStream` can return a first-request structured overflow, so same-connection `compact-request` → Host `requestHostCompact` → `resume-step` can complete on the custom-model path (attempt0 terminate → Host Compact → attempt1 same binding).

## Module / dirs touched
- Host live-slice insert for `compact-register` (preload / `live-slices` ordering vs `runStep`).
- Possibly narrower: do not `await startBackgroundSummary()` before the slot on managed STEPs.
- Offline tests pinning order (stream after register) + blocked-vs-unready.
- Packed preload + legal `runtime re-adopt` only after offline green and owner auth for live.

## Depends-on
[T32](T32-runtime-confirmed-compact.md) offline wire/classifier/bind; [T32-host-compact-seam](T32-host-compact-seam.md) wait-graph qualification for any insert move. Owner briefing / plan are inputs, not substitutes.

## Forbidden
GATE invent without Acceptance live clause; unload solely “to dig”; circuit hand-clear; parallel grokbox summarizer; routing dedicated Host summarizer onto the busy managed STEP; raising `COMPACT_WAIT_MS` as the product fix; claiming live success from `overflow_candidate` or message-count drop alone; overnight lane without this ticket.

## Acceptance (executable)
1. Offline: tip tests prove compact-register runs **after** STEP id assign and **before** `executeToolStream` (or document owner-accepted narrower patch: no await approaching-limit before slot) without reintroducing `responseSummaryLaunch` / background deadlock (seam negative cases).
2. `bun test` for touched HostCompact / live-slice / CF fixtures green on tip.
3. After owner-authorized packed re-adopt on a grokbox-attested Host: one GATE-on canary (prefer test2, `harness=box`) journals structured overflow → compact-request → resume-step → attempt1; then GATE/canary restored **unset**.
4. Astra/grok review of wait-graph + ledger per Spec review rules (exact tip SHA).
5. Default-off unchanged when GATE unset.

## Non-goals
App composer Working ([T36](T36-composer-working-activity.md)); F3 custom-model W for Host S/P; accepting “fast canary cannot dogfood” as continuity strategy.

## Related
[T32](T32-runtime-confirmed-compact.md) · [managed-compact-path](../roadmap/2026-09-12-managed-compact-path.md) · [owner-brief](../roadmap/2026-09-12-managed-compact-owner-brief.md) · receipts `PRIVATE_EVIDENCE`, `PRIVATE_EVIDENCE`
