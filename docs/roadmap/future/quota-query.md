# Quota source expansion

**Deferred source candidates.** The implemented explicit `cursor-web` source remains owned by [Quota](../../quota.md). This page only covers future additional providers/owners and never creates implicit fallback.

## Admission conditions

A supported Host/Gateway operation or application-owned broker may expose a bounded authorized quota fact while withholding account identity, credentials, machine identity, raw payloads and unrelated usage. Running on the same computer or seeing a schema/file is not authority to borrow another process's credentials.

Before implementation define an explicit Profile source selector, credential ownership/revocation, normalized DTO and source-local binding, freshness/cache semantics, account-switch and cross-source equivalence, platform packaging/consent and absent/unauthorized failure. One failing source must not activate another automatically.

## Relationship to monitoring

T41/Web UI may eventually display qualified quota DTOs, but a new table or dashboard does not authorize new acquisition. Cached quota requires its own expiry and source, cannot be inferred from model usage or conversation history, and cannot be equated across accounts by numeric value.

## Stop conditions and proof

No transcript scraping/estimated quota, process injection/private-memory access, refresh-secret copying, silent reuse of Sandbox/Gateway/daemon/SSH credentials, raw payload output or bypass of provider/account refusal. Require fake-provider schema/refusal/redaction tests and explicit bounded external qualification of the exact adapter. Keep private operational receipts out of public fixtures.

Revisit when a provider publishes a supported API, the current adapter changes, or a credential-owning broker exposes a stable narrow operation. This page does not declare any new command available.
