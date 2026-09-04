# Credential Discovery

**Role:** deferred compatibility candidate

The current Sandbox and quota contracts require explicit, purpose-specific `env:`, protected `file:`, or macOS `keychain:` references. A Gateway session, daemon credential, dashboard key, Sandbox credential, and quota credential are not interchangeable.

## Default decision

Do not parse opaque application persistence, browser storage, aggregate secret bundles, or unrelated Keychain entries to discover account credentials. Do not patch an application, copy refresh credentials, or guess among accounts.

The preferred future direction is a provider-supported or application-owned broker that performs one bounded operation and returns a sanitized result without exporting credentials.

## Promotion gates

Investigate an additional discovery adapter only when all are true:

- explicit configuration is a demonstrated adoption blocker;
- no supported token handoff or operation broker exists;
- the user can give explicit, revocable consent;
- account selection, rotation, logout, and permission prompts have defined behavior;
- the adapter can isolate one purpose without copying unrelated material;
- maintenance of an upstream-private format is explicitly accepted.

Stop when the design requires hidden development APIs, broad persistence decryption, process injection, renewal-credential export, or format guessing. The fallback remains an explicit reference or the official application path.

Private feasibility research does not change this public policy.

## Freshness

Re-evaluate when a supported credential API, operation broker, documented Keychain contract, or lifecycle authentication model becomes available.
