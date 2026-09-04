# Quota Source Expansion

**Role:** deferred source candidates

The implemented explicit `cursor-web` source is owned by [Quota](../quota.md). This roadmap covers only additional source ownership and must not create implicit fallback.

## Candidate sources

A future source may be admitted only when its credential owner can expose a bounded, authorized quota operation without leaking account identity, credentials, machine identity, raw provider responses, or unrelated usage events. Possible ownership shapes include a supported host/Gateway method or an application-owned local broker.

The grokbox daemon must not borrow credentials from another process merely because it runs on the same machine. Presence of an application, host schema, credential file, or method name is not authorization evidence.

## Required product decisions

Before implementation, define:

- an explicit Profile source selector;
- purpose-specific credential ownership and revocation;
- normalized DTO and source-local account binding;
- freshness and optional cache semantics;
- account switching and cross-source equivalence rules;
- platform packaging, consent, and failure behavior;
- refusal when the source is absent or unauthorized.

One source failing must never activate another source automatically.

## Security stop conditions

Stop if the candidate requires:

- scraping transcripts or estimating quota;
- process injection or private memory inspection;
- copying refresh credentials or aggregate secret stores;
- silently reusing Sandbox, Gateway, daemon, or SSH credentials;
- returning raw provider payloads;
- bypassing provider refusal or account policy.

## Promotion evidence

Promotion requires fake-provider schema/refusal/redaction tests plus an explicitly authorized, bounded external validation of the exact adapter. Operational evidence remains private; public documentation records only the reusable contract and claim limit.

## Freshness

Re-evaluate when the provider publishes a supported quota API, the current adapter changes, or a credential-owning host/application exposes a stable sanitized broker.
