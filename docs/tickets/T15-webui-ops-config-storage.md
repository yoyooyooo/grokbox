# T15 — WebUI ops console + config/storage interoperability

## Status
**Open.** Implement Phase 2 of the [Box-runtime implementation plan](../roadmap/box-runtime-plan.md). Shared configuration, binding and status contracts begin in Phase 1; safe read-only UI may be delivered before writable capabilities.

## Goal
Deliver a box-local ops console for preparation/confirmed application, Bot inspection, existing-model selection and recent runtime evidence through the same use cases as CLI.

## Scope
- Keep canonical runtime configuration/control artifacts and Host stores authoritative. Status/events are observations, not recovery commands.
- Share parser, CAS mutation, source receipts and safe DTOs between CLI and API; fix same-box roster/runtime identity and preserve T10 absence=official.
- Separate prepare from confirmed apply. Bind confirmation to target/revisions/expiry; use one operation identity and query unknown outcomes without redispatch.
- Own server/modeld/control lifetimes outside browser requests; only stop owned services, never borrowed ones.
- Build browser auth, Host/Origin/CSRF protection and finite command limits before exposing the API.
- Separate saved selection, readiness, last observed use and Host delivery. Preserve current route-reset restrictions.

## Acceptance
Use the Phase 2 exits in the implementation plan: CLI/API equivalence, concurrent writes, wrong-box refusal, read-only GET, stale confirmation, double-click/reload/disconnect, safe output and truthful partial/unknown states.

## Non-goals
- SQLite in MVP; later SQLite is disposable UX cache/index only.
- Catalog/secret CRUD, chat composer, long-term charts or a second assignment store.
- Host ABI/SQLite access, Memory/transcript replacement or T14b compact automation.
- Runtime mutation over arbitrary Profile, daemon/SSH or raw exec/RPC.
