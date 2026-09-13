# Additional Box lifecycle and private-endpoint hardening

**Deferred extensions; not a reason to defer the current production lifecycle.** T40 owns the current machine's normal runtime/collector startup, restart and safe exit. This page owns only additional hosts, network-tool versions and multi-handler situations. Current contracts remain [Product](../../product-contract.md) and [Architecture](../../architecture.md).

## Promotion conditions

Before adding a lifecycle adapter, demonstrate a supported user-owned startup hook across installation, resume, crash and recreation. Do not modify upstream supervisor ownership or build a second generic process manager merely to compensate for an unknown environment. Unsupported additional environments remain explicit ensure/recover or unsupported; they do not silently weaken T40's promised supported environment.

A new network handler problem must involve actual independent managed handlers or incompatible tool versions; one current handler is not evidence for a generic merger.

## Private endpoint ownership

Inspect before mutation; own one exact recorded handler; preserve unrelated handlers; refuse occupancy/drift rather than take over. Rotation validates recorded and live identity. Removal targets only the matching handler, never global reset. Verify final mapping, authentication and rollback/unknown outcomes.

Future candidates are bounded user-space restart support where actually needed, adapters for additional hosts, multi-handler configuration ownership and explicit network-tool-version migration. These require target-specific real evidence; machine-local experiments remain private and do not become public build dependencies.

## Relationship to Web UI / fleet

A multi-Box dashboard does not grant remote runtime writes. [Fleet observation](fleet-observation.md) separately defines target identity and external liveness; endpoint reachability is not proof of ownership or a current executing Host. No public binding on all interfaces merely to make a page reachable.

Revisit when installed lifecycle hooks, process owners, tailnet routing or supported targets change. This page adds no current command or deployment authorization.
