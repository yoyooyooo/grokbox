# T15 — WebUI ops console + config/storage interoperability

## Status
**Open · product-scope tracker, not an implementation lane.** Rebuild execution is [T29](T29-runtime-webui.md): the default ticket pressure is the shared CLI/API command boundary and second-writer CAS. The browser MVP stays deferred in T29 and [plan Phase 2](../roadmap/box-runtime-plan.md); it is not the next slice after T28. Phase 1 establishes thin selection and early facets; simple shared CAS starts with the second writer, not as the first binding gate. Do not create a parallel UI/layout from this older scope ticket.

## Goal
Deliver a box-local ops console for preparation/confirmed application, Bot inspection, existing-model selection and recent runtime evidence through the same use cases as CLI.

## Scope
- Keep canonical runtime configuration/control artifacts and Host stores authoritative. Status/events are observations, not recovery commands.
- Reuse the parser and config mutation entry. Before the second writer can save, add shared short-lock/reread/expected-revision protection for CLI/API, source receipts and safe DTOs; no general transaction service or projection-file family. Fix same-box roster/runtime identity and preserve T10 absence=official.
- Separate prepare from confirmed apply. Bind confirmation to target/revisions/expiry; use one operation identity and query unknown outcomes without redispatch.
- Own server/modeld/control lifetimes outside browser requests; only stop owned services, never borrowed ones.
- Build browser auth, Host/Origin/CSRF protection and finite command limits before exposing the API.
- Separate saved selection, readiness, last observed use and Host delivery. Per-Bot official reset follows T24's qualified implementation, not the historical blanket route-reset restriction.

## Acceptance
Future pages/interaction live in [future/webui-console](../roadmap/future/webui-console.md); T29 owns implementation, T41 owns persistent monitoring. Use the Phase 2 exits and their updated contracts: CLI/API equivalence, concurrent writes, wrong-box refusal, read-only GET, stale confirmation, double-click/reload/disconnect, safe output and truthful partial/unknown states.

## Non-goals
- SQLite configuration/execution SoT. The blanket SQLite ban is superseded by [Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation): T41 can persist observation/history/incident before UI; management facts are not wholly disposable cache.
- Catalog/secret CRUD, chat composer, long-term charts or a second assignment store.
- Host ABI/SQLite access, Memory/transcript replacement or T14b compact automation.
- Runtime mutation over arbitrary Profile, daemon/SSH or raw exec/RPC.
