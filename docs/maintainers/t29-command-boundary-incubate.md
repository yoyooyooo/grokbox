# Shared command boundary for a future browser client

This page owns how a future UI consumes existing application capabilities, not a browser implementation plan or a second configuration/state store. [T29](../tickets/T29-runtime-webui.md) owns remaining UI work and [the console target](../roadmap/future/webui-console.md) owns page/interaction scope. [Architecture](../architecture.md) owns current composition.

## Reuse the existing writers

ConfigurationChange and model ConfigurationWrite already have real implementations. Cooperative concurrent CLI writes demonstrated a second-writer need; canonical reread, expected revision, short lock and atomic publication/readback are not deferred until the browser exists. A future client must call the same program and respect the same conflict/unknown result, not write JSON/SQLite directly or add a UI-only lock.

Full config revision and a consumer's domain dependency revision are different. A saved future assignment does not rebind an in-flight TURN; draft, saving, committed-awaiting-use and observed-effective must remain distinguishable. Cancellation of a request is not rollback of a committed preference. No new revision database, assignment mirror or automatic conflict merge is implied.

## Observe without acquiring execution authority

The client consumes bounded status/incident/snapshot/cursor projections. The existing monitor SQLite owns observation history, incident management and notification facts; it is not model configuration, Server ownership or permission to execute. A stale snapshot cannot authorize a write or turn gap into healthy idle. Closing a browser must not stop service-owned collection.

Each mutation has an explicit capability, target, scope, expected revision where applicable, operation identity and confirmation semantics. Unknown writes query/reconcile that same operation. A transport timeout does not justify another nonce or an automatic controller retry. Credentials and private evidence are not exposed merely because a page needs diagnostics.

## Qualification when the client is implemented

Verify CLI/UI concurrency against the same writer, old-TURN/new-choice behavior, read-only no-side-effects, duplicate/unknown reconciliation, slow/disconnected event readers and exact source/generation visibility. Browser draft state may be local; durable facts stay with their original owner. Actual UI availability is not inferred from the existence of these shared interfaces.

The original no-Live-Layer/no-CAS inventory described an earlier snapshot and is no longer a current claim. It remains recoverable for design history:

```bash
git show 4181e5ec822b6a199681822c7b597710c1195a44:docs/maintainers/t29-command-boundary-incubate.md
```

Current qualification is routed through [LIVE-integration-validation](../tickets/LIVE-integration-validation.md), not a new browser readiness ledger. This page neither launches a browser project nor grants live mutations.
