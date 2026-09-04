# Documentation Map

This documentation separates current source truth, accepted product behavior, upstream compatibility facts, and deferred work.

## Current homes

- [Product contract](product-contract.md): commands, Profiles, capabilities, output, and security boundaries.
- [Architecture](architecture.md): modules, transports, daemon, Sandbox, and verification boundaries.
- [Compatibility](compatibility.md): unofficial status, stability classes, trademarks, and revalidation policy.
- [Upstream integration](upstream-integration.md): minimum interoperability facts required by the implementation.
- [Sandbox control plane](cursor-sandbox-control-plane.md): lifecycle terminology, trust separation, and validation requirements.
- [Quota](quota.md): implemented explicit source, normalized output, and failure boundary.

## Roadmap

[Roadmap](roadmap/README.md) contains deferred candidates and promotion gates. It does not prove delivery or override a current home.

## Maintainers

- [Source provenance review](maintainers/provenance.md)
- [Release runbook](maintainers/release.md)

Public bugs and proposals use [GitHub Issues](https://github.com/yoyooyooo/grokbox/issues). Security reports follow [`SECURITY.md`](../SECURITY.md). Machine-local plans, raw operational evidence, credentials, provider dumps, and private research do not belong in this repository.

## Authority

Current behavior is owned by source and executable tests. Product and architecture documents may describe accepted targets. Compatibility observations can invalidate assumptions but do not silently redefine product behavior.

## Freshness

Review the relevant current homes when any of these change:

- Gateway methods, schemas, discovery, generation, or token scope;
- Sandbox, quota, or desktop compatibility behavior;
- daemon protocol, filesystem/process policy, or network transport;
- Profile format, package layout, runtime requirements, license, or bundled dependencies.
