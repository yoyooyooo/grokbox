# T14 — Managed context compact / overflow on model switch

## Goal
When a bot is opted into a managed model (e.g. test0 → luna) and **Host-accumulated conversation > that model’s context window**, product parity requires an explicit **compact / overflow** path—not silent near-window amnesia.

## Status
**step 1 landed: overflow observability only.** Auto-compact is **open**. Host-reuse compact is **step 2+**, and only on distinctly identified overflow—never generic `model_error`.

## Step 1 (this slice)
- Inspect OpenAI/CCS chat+responses errors in modeld (`inspectProviderError`).
- Conservative `overflowCandidate` (provider code or 400/413 + overflow-shaped message). Auth / rate-limit / generic 400 / 500 → false.
- Durable `provider_error_observed` in events.ndjson (status, provider code/type, truncated redacted snippet, modelId, api, prompt size hints).
- Host IPC / App still allowlisted `model_error` (T11). No compact, retry, or near-window chop.

## Step 2+ (not this slice)
Reuse Host compact core **only** when overflow is distinctly identified from step 1 signals.

## Product bar (context selection)
Managed STEPs pass through Host-compacted `getExecutor` context (CCS-safe shape). No `store.db` prompt prepend. `GROKBOX_LIVE_PROMPT_*_CAP` unset in live. Long-term facts stay Memory distillation.

## Note
Repo `compactEvents` is **event-log** compaction, not conversation compact. Do not confuse.
