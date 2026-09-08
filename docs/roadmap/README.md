# Roadmap

This directory contains the accepted box-runtime implementation plan and deferred candidates. Neither a plan nor a candidate proves current behavior or implementation completion.

## Active implementation plan

[Box-runtime implementation plan](box-runtime-plan.md) is the single Current Home for its forward execution order, contracts, owners, and phase exits. Use it for Phase 0–4 and T13–T16 work. The dated `2026-09-08-box-runtime-next.md` is only a redirect; intermediate comparison and review reports are not required for day-to-day work.

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

Review the box-runtime plan when Host ABI, configuration/wire schema, backend capabilities, Effect pin, or phase evidence changes. Review deferred candidates when daemon consumers, box lifecycle, network transport, provider-supported credential surfaces, quota contracts, or real implementation constraints change.
