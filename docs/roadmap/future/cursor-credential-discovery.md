# Purpose-specific credential discovery

**Deferred compatibility candidate.** Current Sandbox/quota/Gateway credentials remain explicit `env:`, protected `file:` or supported `keychain:` references; authorities are not interchangeable. See [Product contract](../../product-contract.md) and [Architecture](../../architecture.md).

## Accepted safety boundary

Do not parse opaque App/browser persistence, aggregate secret bundles or unrelated Keychain entries to discover account credentials. No App patch/injection, refresh-token copying, account guessing or hidden development API. Prefer a provider-supported or credential-owner-operated broker that performs one bounded operation and returns only a safe result.

The native Host ownership-read bridge already borrows the Host's own official client without exporting its secret. T41 observations and Web UI must consume that safe interface, not turn this future candidate into a new credential scanner.

## Promotion gates

All must hold: explicit configuration is an actual adoption blocker; no supported handoff/operation broker solves it; the user can give revocable purpose-specific consent; account selection, rotation, logout and permission prompts have defined behavior; unrelated secret material remains inaccessible; the upkeep of any private format is explicitly accepted.

Refuse discovery when it requires broad persistence decryption, process injection, renewal-credential export or format guessing. The fallback is the explicit reference or official App operation, never another hidden credential source. Private feasibility research does not change this public boundary.

## Evidence / freshness

Qualify absent/locked/denied/malformed/ambiguous/account-change cases plus packaging and least-privilege behavior before promotion. Revisit on a supported credential API, operation broker or documented Keychain/lifecycle-auth contract; presence of a file or method is not permission.
