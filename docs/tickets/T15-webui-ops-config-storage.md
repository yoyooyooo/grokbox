# T15 — WebUI ops console + config/storage interoperability

## Status
**Open · scope route, not a separate implementation lane.** [T29](T29-runtime-webui.md) owns the shared CLI/API boundary, concurrent writes and browser delivery. Web UI is part of the accepted [end-to-end rebuild](../roadmap/agent-first-cli/spec.md); [CLI-05](CLI-05-implementation-follow-through.md) owns cross-domain consolidation and final delivery. Earlier browser deferral and phase ordering no longer constrain that target. Do not create a parallel UI from this older scope ticket.

## Goal
Deliver a box-local ops console for preparation/confirmed application, Bot inspection, existing-model selection and recent runtime evidence through the same use cases as CLI.

## Scope
- Keep canonical runtime configuration/control artifacts and Host stores authoritative. Status/events are observations, not recovery commands.
- Reuse shared contracts and domain mutation use cases, not a CLI subprocess or parser as the application API. CLI/API concurrency uses the same domain writer, expected revision and result receipts. Existing modules may be reshaped; the accepted native/follow-default/explicit-model meanings remain distinct.
- Separate prepare from confirmed apply. Bind confirmation to target/revisions/expiry; use one operation identity and query unknown outcomes without redispatch.
- Own server/modeld/control lifetimes outside browser requests; only stop owned services, never borrowed ones.
- Build browser auth, Host/Origin/CSRF protection and finite command limits before exposing the API.
- Separate saved selection, readiness, last observed use and Host delivery. Per-Bot official reset follows T24's qualified implementation, not the historical blanket route-reset restriction.

## Acceptance
Pages and interactions live in [webui-console](../roadmap/future/webui-console.md); T29 owns implementation and browser acceptance, T41 owns persistent observation. Validate CLI/API equivalence, concurrent writes, wrong-box refusal, read-only GET, stale confirmation, duplicate/unknown reconciliation, safe output and truthful partial states. The user adopts the complete final version; intermediate development builds need not remain usable.

## Non-goals
- SQLite configuration/execution SoT. The blanket SQLite ban is superseded by [Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation): T41 can persist observation/history/incident before UI; management facts are not wholly disposable cache.
- Arbitrary secret CRUD, chat composer, unlimited historical charts or a second assignment store. Model management and qualified Memory/Project/file writes follow the accepted scope in the owning spec.
- Direct browser access to Host ABI/SQLite or private stores; native changes must use the qualified domain capability.
- Runtime mutation over arbitrary Profile, daemon/SSH or raw exec/RPC.
