# Daemon access and streaming

**Deferred candidates, not current product behavior.** Canonical home relocated here on 2026-09-12; the previous roadmap path is a discovery redirect. The implemented finite daemon and capability contracts remain in [Architecture](../../architecture.md) and source/tests.

## Per-client principals and revocation

Single-operator operation uses one rotatable remote credential; it does not need a speculative client registry, token inventory, grant editor or `daemon clients` hierarchy. Promote separate principals only when independent consumers need different permissions, selective revocation, stable audit attribution or cross-trust sharing. Define issuance/storage/rotation/logout/revocation/retention and migration from the existing credential before implementation.

A future Web UI session is a scoped console identity, not automatically an extra daemon principal or permission to reuse Gateway/provider keys. [Web UI](webui-console.md) keeps its own API boundary.

## Shared streaming abstraction

Finite commands stay JSON request/response. Existing event, Job-log and file-transfer families may use their smallest typed framing/cancellation/resume contract. Promote a generalized duplex SDK/streaming framework only when at least two implemented families duplicate the same framing, cancellation, backpressure, replay and errors.

T41's bounded observation feed does not by itself justify a general protocol platform. Reuse source/epoch/cursor/gap semantics without reinterpreting process-control authority or requiring every older command to migrate.

## Exit / stop / freshness

Promotion requires explicit consumers, security review and executable incompatible-version, revoke, cancel, reconnect and slow-reader tests. Stop when the work exists only to make the protocol appear complete or support hypothetical SDKs. Revisit when consumers, trust, audit or actual streaming-family duplication changes; implemented contracts win over this proposal.
