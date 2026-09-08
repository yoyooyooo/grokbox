# T14b — Host-reuse compact on confirmed provider overflow (todo)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**Open.** Phase 4 of the [implementation plan](../roadmap/box-runtime-plan.md): requires the Phase 1 binding/lifecycle contract, a verified Host compact capability, and separately authorized provider evidence. Does not wait for all T16 backends.

## Goal
When managed model switch leaves Host-compacted context still too large for the **new** model, trigger **Host’s own conversation compact** (same core / experience as official), then retry the managed STEP. Do **not** invent a grokbox near-window compactor.

## Preconditions (from T14 step1)
- Safe provider observations support classifier qualification; `overflowCandidate` alone never authorizes recovery.
- A typed current-attempt outcome confirms context overflow using provider-specific, non-conflicting evidence and trusted request correlation.
- The failed attempt is terminal and no executable tools/user delivery have been released. Unknown outcomes are not retryable overflow.
- App IPC stays allowlisted; do not treat generic `model_error` as overflow.

## Acceptance
1. Compact/retry only on confirmed context overflow—not auth, rate-limit, generic 400/500, HTTP payload limits, timeout/disconnect or unknown failures.
2. Call **Host compact core** with the same turn/model binding and evidence-backed budget; receive a new Host-selected snapshot and revalidate admission.
3. Permit at most one recovery attempt with original TURN/STEP correlation and ledger deduplication. Do not invent Host invocation IDs or clear prior records to retry.
4. No silent near-window chop, `store.db` prepend or product-live `GROKBOX_LIVE_PROMPT_*_CAP`.
5. Missing capability, cancellation, unchanged/still-oversize snapshot or failed retry ends visibly; no parallel summarizer or loop.
6. Offline proof covers the recovery chain, duplicate completion, cancellation and zero compact for non-overflow errors. Live validation still requires separate authorization.

## Non-goals
- Replacing Host compact with a parallel summarizer
- Auto-compact on every model_error
- Memory distillation product (separate)
- Repo `compactEvents` (event-log only)

## Pointers
- Step1: `docs/tickets/T14-managed-context-compact-on-model-switch.md`, `packages/box-runtime/src/provider-overflow.ts`, event `provider_error_observed`
- Landed commit: `pre-publication-revision`
