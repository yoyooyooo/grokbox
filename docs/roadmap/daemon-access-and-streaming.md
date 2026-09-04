# Daemon Access and Streaming

**Role:** deferred candidates, not v1 product contract

The minimal v1 daemon is owned by [Architecture](../architecture.md): finite JSON request/response over local socket or loopback, an explicit handshake, one rotatable remote credential, method allowlisting, and capability checks before host effects.

## Deferred Candidates

### Per-client principals and revocation

Do not build a client registry, per-client capability grants, `daemon clients` command tree, token inventory, or remote revocation list for the single-operator v1. Rotation of the one remote daemon credential is the sufficient revocation mechanism.

Promote this candidate only when at least one is true:

- two independent human or automation clients need different authority;
- one credential must be revoked without disrupting another client;
- audit requirements need stable per-client attribution;
- a shared daemon is operated across trust boundaries.

Promotion must define principal authority, issuance, storage, rotation, revocation, audit retention, and migration from the shared credential before changing the command tree.

### Generalized streaming protocol

Do not design a generic duplex protocol, multi-language SDK, resumable stream framework, or public daemon API before a concrete command requires it. Finite commands remain JSON request/response. Events, Job logs, and file transfer may add the smallest command-specific HTTP streaming or chunking contract in their owning delivery slice.

Promote a shared streaming abstraction only after at least two implemented command families repeat the same framing, cancellation, resume, backpressure, and error semantics. Until then, duplication in typed command-specific adapters is cheaper than a speculative protocol platform.

## Stop Conditions

Stop architecture work when a proposed mechanism exists only to make the protocol look complete, support hypothetical third-party clients, or unify one implemented stream with future streams. A version field and incompatibility check do not imply a public compatibility program.

## Freshness

Re-evaluate when daemon consumers, trust boundaries, audit policy, or implemented streaming families change. Current source and executable protocol tests are stronger than this candidate description once implementation exists.
