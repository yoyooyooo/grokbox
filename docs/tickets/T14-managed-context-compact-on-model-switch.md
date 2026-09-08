# T14 — Managed context compact / overflow on model switch

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

## Goal
When a bot is opted into a managed model (e.g. test0 → luna) and **Host-accumulated conversation > that model’s context window**, product parity requires an explicit **compact / overflow** path—not silent near-window amnesia.

## Status
**Observation landed** (`pre-publication-revision`, safe projection tightened in `pre-publication-revision`). Correlation/classification follow-through is governed by Phase 1/4 of the [implementation plan](../roadmap/box-runtime-plan.md). **Host compact recovery is [T14b](./T14b-host-reuse-compact-on-confirmed-overflow.md)** (open).

## Step 1 (landed)
- Inspect OpenAI/CCS chat+responses errors in modeld (`inspectProviderError`).
- Log-only `overflowCandidate` (provider code or 400/413 + overflow-shaped message). It is not a confirmed-overflow control signal; status/code conflicts and classifier gaps require further proof.
- Durable `provider_error_observed` contains status, finite local code/type enums, API mode and size hints. No bodySnippet or raw provider tokens. Trusted local request correlation remains to be added; do not infer it from timestamps.
- Host IPC / App still allowlisted `model_error` (T11). No compact, retry, or near-window chop.

## Step 2
See **T14b** — Host-reuse compact only on confirmed overflow.

## Product bar (context selection)
Managed STEPs pass through Host-compacted `getExecutor` context (CCS-safe shape). No `store.db` prompt prepend. `GROKBOX_LIVE_PROMPT_*_CAP` unset in live. Long-term facts stay Memory distillation.

## Note
Repo `compactEvents` is **event-log** compaction, not conversation compact. Do not confuse.
