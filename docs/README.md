# Documentation Map

This documentation separates current source truth, accepted product behavior, upstream compatibility facts, and deferred work.

## Current homes

- [Product contract](product-contract.md): commands, Profiles, capabilities, output, and security boundaries.
- [Architecture](architecture.md): modules, transports, daemon, Sandbox, and verification boundaries.
- [Compatibility](compatibility.md): unofficial status, stability classes, trademarks, and revalidation policy.
- [Upstream integration](upstream-integration.md): minimum interoperability facts required by the implementation.
- [Sandbox control plane](cursor-sandbox-control-plane.md): lifecycle terminology, trust separation, and validation requirements.
- [Quota](quota.md): implemented explicit source, normalized output, and failure boundary.
- [Box-local model runtime](box-runtime.md): accepted createSession seam, inject/watchdog/guardian, modeld, window semantics, and evidence ladder. Not an implementation-complete claim. Product obligations are in the [product contract](product-contract.md) §12.
- [Box-runtime strategy plan](roadmap/box-runtime-plan.md): Phases 0–4, product exits and scope.
- [Box-runtime Current Implementation Spec](roadmap/box-runtime-impl-spec.md): the single-track target package/module tree, ports, allowed imports, execution chain, POC removal inventory and proof gates. [T20–T33](tickets/README.md) own rebuild slices; neither document proves implementation completion.
- [Host seam ops recognition](roadmap/host-seam-ops-recognition.md): forward-only upgrade recognition, private corpus replay, candidate review/publication and phased offline gates. Runtime SHA/literal application and separate adopt confirmation remain unchanged.

## Roadmap

[Roadmap](roadmap/README.md) routes to the box-runtime strategy/spec pair and deferred candidates. Plans and candidates do not prove delivery or override product and architecture authority.

## Maintainers

- [Source provenance review](maintainers/provenance.md)
- [External PromptSession reference](maintainers/grok-bot-setup-session.md): bounded `grok-bot-setup` session-contract evidence; not product or architecture authority.
- [Release runbook](maintainers/release.md)

Public bugs and proposals use [GitHub Issues](https://github.com/yoyooyooo/grokbox/issues). Security reports follow [`SECURITY.md`](../SECURITY.md). Machine-local execution notes, raw operational evidence, credentials, provider dumps, and private research do not belong in this repository.

## Authority

Current behavior is owned by source and executable tests. Product and architecture documents may describe accepted targets. Compatibility observations can invalidate assumptions but do not silently redefine product behavior.

The [2026-09-08 Host seam adjudication](decisions/2026-09-08-host-seam-normalization-and-roadmap.md) records binding normalization, patch-surface and execution-scope decisions. They are incorporated into the [strategy plan](roadmap/box-runtime-plan.md) and [implementation spec](roadmap/box-runtime-impl-spec.md); the ADR is not a second roadmap. The spec records this rebuild's explicit single-track policy without turning earlier POC implementation details into compatibility obligations.

## Freshness

Review the relevant current homes when any of these change:

- Gateway methods, schemas, discovery, generation, or token scope;
- Sandbox, quota, or desktop compatibility behavior;
- daemon protocol, filesystem/process policy, or network transport;
- Profile format, package layout, runtime requirements, license, or bundled dependencies;
- Host PromptSession/`SendToUser` contract, or box-runtime config root / local-only boundary.
