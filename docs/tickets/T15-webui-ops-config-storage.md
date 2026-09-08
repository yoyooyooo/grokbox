# T15 — WebUI ops console + config/storage interoperability (analysis)

## Status
**open / queued** — independent Astra analysis after incr+Host-kernel review.

## Goal
Cloud-box WebUI: one-click bring-up, bot detail/ops, visual monitoring, convenient model switching. Decide how config/storage interoperate with CLI/runtime **without** forking a second source of truth.

## Product bar (seed)
- **Source of truth**: existing runtime contracts (`models.json` / desired / assignments, events.ndjson, status/observe, Host agent stores)—WebUI reads/writes via API/CLI facades.
- **SQLite**: optional local index/cache for UX only — not a parallel authoritative store for model route or runtime desired state.
- Config fields shaped so CLI and WebUI share the same schema/operations where possible.

## Analysis asks
1. Which current config surfaces need rename/split for UI+CLI parity?
2. What APIs does one-click launch need (`runtime start`, adopt, modeld, status)?
3. Model switch UX vs T10 assignments + T4e modelId alignment.
4. Viz of `provider_error_observed` / STEP terminals / attestation.
5. Risks of embedding SQLite as SoT vs cache.

## Non-goals
- Implementing the WebUI
- Replacing Host Memory/transcript stores
- T14b compact automation

## Depends on
- Astra incr+Host-kernel: `/tmp/grokbox-astra-incr-host-kernel-20260908T090905Z.md`
