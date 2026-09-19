# Box-local model runtime

The runtime adds governed per-Bot model execution and maintenance to the native Grok Bot Host. It does not replace the upstream Agent loop, rewrite Server ownership or modify the official App. Source and tests provide evidence to challenge, not a correctness guarantee; installation and actual user journeys require separate [LIVE evidence](tickets/LIVE-integration-validation.md).

## 1. Product and authority

A Bot with an explicit managed assignment uses its captured model/effort within the same native conversation. Unassigned Bots retain official behavior. Changing a future selection does not change an in-flight TURN, change harness or silently migrate history. Missing managed configuration/qualification fails visibly rather than selecting another model.

Server registration owns execution ownership; native Host/worker owns root, tools, approvals, Memory, checkpoint and delivery. Kernel/modeld owns durable STEP identity, authority waiting and the bounded provider request. Configuration owns intent; observed loaded state and receipts establish effects. [Architecture](architecture.md) maps all writers and composition roots.

## 2. 接缝

The reviewed Host profile applies exact source/ordered literal/transformed-hash checks. Host/preload is a pure/bounded bridge, with no Effect, SDK, SQLite, parser or provider credential loading. Modeld exposes a finite versioned local protocol; the actual [wire constant](../packages/runtime-kernel/src/internal/contract/wire.ts), schemas and package metadata are the implementation owners.

Native synchronous API shape, identity, mixed-content order and validated tool material need qualification. The intended createSession-before-provider boundary conflicts with the current late hook; official-provider precondition independence is unverified (see [upstream integration](upstream-integration.md#host-session-boundary)). A private upstream corpus may explain interoperability but cannot become a public build dependency, runtime fallback or executable restoration source.

## 3. Read by concern

| Concern | Current contract | Implementation / operational route |
| --- | --- | --- |
| STEP, model/effort, authority, streams and retry | [Execution](runtime/execution.md) | [modeld tickets](tickets/README.md#modeld-effect-core), [result observation](maintainers/run-outcome-observation.md) |
| Local context budgets, Pi reuse, summary and checkpoint | [Context](runtime/context.md) | [CTX](tickets/README.md#context-maintenance), [configuration](configuration.md) |
| Current state, duplicate and remaining continuity goals | [Continuity](runtime/continuity.md) | [CONT](tickets/README.md#ownership-continuity), [state guide](maintainers/current-state-control.md), [duplicate guide](maintainers/native-agent-duplicate.md) |
| Incident/evidence, notifications and bounded storage | [Operations](runtime/operations.md) | [OBS/ops](tickets/README.md#incident-evidence), [operations guide](maintainers/template-ops-automation.md) |
| Source/profile, loaded capability and controller recovery | [Host compatibility](runtime/host-compatibility.md) | [HCR](tickets/README.md#host-capability-recovery), [rollback](maintainers/official-rollback-acceptance.md) |
| Resource/error/cancellation composition | [Effect standard](effect-box-runtime.md) | Affected production program and its tests |

These are independent reading scopes, not an ordered startup checklist. Accepted remainder is explicit inside its domain and routed through [roadmap](roadmap/README.md). Old rebuild phases, initial wire versions and model-specific review choreography are [history](archive/README.md), not current implementation instructions.

## 4. Completion and limits

One writer per fact; one STEP program; original identity on unknown outcomes; no silent fallback, duplicate side effect, implicit history pruning or permanent permission from cached state. Metadata/state saved, command accepted, provider completed, native checkpoint persisted, user delivery and App visibility are distinct.

Daily per-Bot official selection differs from removing the patch and returning to an unmodified Host. Shared service restart, model spend, identity migration, irreversible cleanup and publishing require the relevant task authorization. A successful build, profile write or health probe does not provide it.

Revalidate affected boundaries when upstream ABI, schema/wire, model encoding, writer ownership, resource lifetime or deployment artifacts change. Use fixed evidence rather than restoring old operating instructions or copying pass counts into this overview.
