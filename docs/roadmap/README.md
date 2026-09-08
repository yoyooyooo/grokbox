# Roadmap

This directory contains the accepted box-runtime strategy plan, its current implementation spec, and deferred candidates. None proves current implementation or deployment.

## Active box-runtime homes

- [Strategy plan](box-runtime-plan.md): Phases 0–4, product exits and scope. Not a second source-layout specification.
- [Current Implementation Spec](box-runtime-impl-spec.md): the **single-track destructive rebuild** tree, ports, import rules, execution chain, removal inventory and proof gates. Implementers use this build reference; do not preserve POC internal compatibility.
- [T20–T33 tickets](../tickets/README.md): executable slices and evidence. Start T20 → T21; establish T27 facets early. Historical done tickets stay done.
- [2026-09-08 adjudication](../decisions/2026-09-08-host-seam-normalization-and-roadmap.md): D1–D12 product/trust decisions retained by the strategy/spec.

The dated `2026-09-08-box-runtime-next.md` remains only a redirect. No intermediate review report or machine-local artifact is required for public build/contribution.

## Authority

- [Product contract](../product-contract.md) owns accepted behavior.
- [Architecture](../architecture.md) owns implementation boundaries.
- [Upstream integration](../upstream-integration.md) and [Compatibility](../compatibility.md) own interoperability constraints.
- [GitHub Issues](https://github.com/yoyooyooo/grokbox/issues) owns public work intake and delivery discussion.

## Deferred candidates

- [Daemon access and streaming](daemon-access-and-streaming.md)
- [Box lifecycle and tailnet hardening](box-lifecycle-and-tailnet-hardening.md)
- [Credential discovery](cursor-credential-discovery.md)
- [Quota source expansion](quota-query.md)

A candidate moves into a current home only after a concrete need, an accepted security/product decision, and executable acceptance criteria. Private research, local evidence, or documentation presence alone is insufficient.

## Freshness

Review the strategy, implementation spec and affected tickets when Host ABI, package/import ownership, configuration/wire schema, backend capabilities, Effect pin, or phase evidence changes. Review deferred candidates when daemon consumers, box lifecycle, network transport, provider-supported credential surfaces, quota contracts, or real implementation constraints change.
