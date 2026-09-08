# T14b — Host-reuse compact on confirmed provider overflow (todo)

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Status
**open / blocked on live `provider_error_observed` evidence** (T14 step1).

## Goal
When managed model switch leaves Host-compacted context still too large for the **new** model, trigger **Host’s own conversation compact** (same core / experience as official), then retry the managed STEP. Do **not** invent a grokbox near-window compactor.

## Preconditions (from T14 step1)
- Durable `provider_error_observed` with conservative `overflowCandidate`.
- Enough live/provider samples to trust the classifier (codes/messages per provider).
- App IPC stays allowlisted; do not treat generic `model_error` as overflow.

## Acceptance
1. Compact / retry **only** when overflow is distinctly identified (`overflowCandidate=true` or a later hardened signal)—never auth, rate-limit, generic 400, 500, or unknown failures.
2. Prefer calling / driving **Host compact core** sized for the newly assigned managed model; managed path then receives the post-compact `getExecutor` window as today.
3. No silent near-window chop; no `store.db` prompt prepend; `GROKBOX_LIVE_PROMPT_*_CAP` stay unset in product live.
4. Visible failure if compact cannot help or Host compact is unavailable—no infinite retry.
5. Offline tests for “overflow → Host compact hook → retry once”; non-overflow errors unchanged.
6. Update T14 / README when landed.

## Non-goals
- Replacing Host compact with a parallel summarizer
- Auto-compact on every model_error
- Memory distillation product (separate)
- Repo `compactEvents` (event-log only)

## Pointers
- Step1: `docs/tickets/T14-managed-context-compact-on-model-switch.md`, `packages/box-runtime/src/provider-overflow.ts`, event `provider_error_observed`
- Landed commit: `pre-publication-revision`
