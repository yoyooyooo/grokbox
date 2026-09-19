# Documentation

Enter from the question you are answering. These routes are not a mandatory reading sequence. Current source/schema/tests determine implementation; the latest applicable adopted change resolves documentary disagreement. A future target, a fixed observation and the current installation are different scopes.

## Contracts and implementation

| Question | Owning home |
| --- | --- |
| What does grokbox promise, and what is outside its scope? | [Product contract](product-contract.md) |
| Which component owns a fact, effect, resource or interface? | [Architecture](architecture.md) |
| How does Box-local model execution work? | [Runtime overview](box-runtime.md), [execution](runtime/execution.md) |
| How are model history, compact and next-input recovery maintained? | [Context maintenance](runtime/context.md) |
| What do duplicate, current state, clone, spawn and handover mean? | [Continuity](runtime/continuity.md) |
| How are configuration, migration and application distinguished? | [Configuration](configuration.md) |
| What governs native notifications, evidence and storage? | [Native Bot operations](runtime/operations.md) |
| What qualifies a Host profile or recovery operation? | [Host compatibility](runtime/host-compatibility.md) |
| Which runtime effects belong in Effect? | [Effect standard](effect-box-runtime.md) |
| Which upstream facts and compatibility limits matter? | [Upstream integration](upstream-integration.md), [compatibility](compatibility.md) |
| What are Sandbox and quota boundaries? | [Sandbox control plane](cursor-sandbox-control-plane.md), [quota](quota.md) |

Exact command inventory is derived from the [registry](../packages/cli/src/registry.ts) and command help, not a second manually maintained command tree. The installed [operator Skill](../skills/grokbox/SKILL.md) expands one capability at a time.

## Operate and verify

[Maintainer guides](maintainers/README.md) route diagnosis, configuration, current-state control, recovery, release and provider qualification. [LIVE-integration-validation](tickets/LIVE-integration-validation.md) alone maintains current live results; its [execution guide](maintainers/live-end-to-end.md) owns procedure, not another status table.

[Implementation tickets](tickets/README.md) own scoped code/offline/review gaps. [Roadmap](roadmap/README.md) separates remaining accepted targets from unaccepted or unscheduled extensions. [Decisions](decisions/README.md) explain adopted choices and explicit supersession. [Archive](archive/README.md) routes retired design and fixed evidence; historical success does not qualify a new deployment.

## Maintain these routes

[Documentation maintenance](maintainers/documentation.md) defines source alignment, freshness, ticket identity, archive/receipt lifecycles and checks. Update the owning meaning and its actual consumers together. Routers link to facts; they do not copy schema versions, test counts, temporary blockers, deployment status or worktree inventories.
