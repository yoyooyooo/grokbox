# Additional Box lifecycle; network management excluded

**Only additional-host process lifecycle remains a future candidate. Tailscale-specific hardening is outside product scope, not postponed work.** Current contracts are [Product §2.2](../../product-contract.md#2-默认入口与连接) and [Architecture](../../architecture.md#6-连接和授权). This historical filename remains a discovery route, not a second network roadmap.

## Process lifecycle promotion conditions

T40 owns supported-environment runtime/collector startup, restart and safe exit; those obligations are not deferred here. Before adding a lifecycle adapter for another host, demonstrate a supported user-owned startup hook across installation, resume, crash and recreation. Do not take over the upstream supervisor or build a second generic process manager to compensate for an unknown environment. Unsupported hosts remain explicit ensure/recover or unsupported.

## Network non-goals

Do not add Tailscale discovery, installation, joining, DNS/ACL/tag management, multi-handler ownership/merging, network-tool-version migration or automatic endpoint repair. The operator provides DNS/IP, routing, TLS and proxy exposure; existing generic endpoint configuration is the application boundary.

Explicit legacy peer/bootstrap and `recover --legacy-tailnet` retain their original safety checks and ownership records. They are not a promotion path for new networking features. Do not automatically remove working mappings or credentials; any retirement is separately scoped and authorized. Their exact compatibility contract remains in Product §2.2 rather than being duplicated here.

## Relationship to Web UI / fleet

A [single-Box Web UI](webui-console.md) can run inside the Box and serve an external browser through an operator-managed entry point. That does not require a Tailscale integration, a remote runtime or a multi-Box dashboard. Application sessions, Origin/CSRF protection, target binding and authorization still apply. [Fleet observation](fleet-observation.md) separately defines multi-target identity and external liveness; reachability is not ownership proof.

Revisit lifecycle candidates when supported hosts, startup hooks or process ownership change. Revisiting excluded networking scope requires an explicit product decision, not merely a new Tailscale version or available handler. This page adds no command or deployment authorization.
