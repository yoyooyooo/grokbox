# Runtime rebuild specification — compatibility routes

This former monolithic implementation specification no longer owns current contracts or a construction sequence. Use the concern below directly. Stable historical anchors are retained for existing tickets/reports and external references; they do not revive old model choices, wire versions, layouts, milestone order or permissions.

The exact pre-convergence text and unresolved-obligation mapping are preserved in [the rebuild archive](../archive/runtime-rebuild.md). Current product semantics are [Product](../product-contract.md), architecture is [Architecture](../architecture.md), and the only current live result index is [LIVE](../tickets/LIVE-integration-validation.md).

| Historical anchor | Current owning home |
| --- | --- |
| <a id="stable-delivery"></a>Stable delivery | [Runtime overview](../box-runtime.md), [acceptance V01–V30](../runtime/acceptance.md) |
| <a id="host-only-model-switch"></a>Host-only switching | [Execution](../runtime/execution.md#model-selection-and-reasoning) |
| <a id="server-authority-rollout"></a>Server authority | [Execution authority](../runtime/execution.md#authority-and-identity) |
| <a id="delivery-command-contract"></a>Commands | [Product](../product-contract.md), [registry](../../packages/cli/src/registry.ts) |
| <a id="continuous-observation"></a>Observation | [Operations](../runtime/operations.md) |
| <a id="template-ops-automation"></a>Native operations | [Operations](../runtime/operations.md) |
| <a id="configuration-rebuild"></a>Configuration | [Configuration](../configuration.md) |
| <a id="scope"></a>Scope | [Product](../product-contract.md), [runtime](../box-runtime.md) |
| <a id="layout"></a>Layout | [Architecture](../architecture.md#3-repository-shape) |
| <a id="imports"></a>Imports | [Architecture](../architecture.md#3-repository-shape), [Effect](../effect-box-runtime.md) |
| <a id="contracts"></a>Fact owners | [Architecture](../architecture.md#2-事实和写入权) |
| <a id="ports"></a>Ports | [Execution source entry points](../runtime/execution.md#source-entry-points) |
| <a id="config"></a>Configuration writer | [Configuration](../configuration.md#scope-and-result) |
| <a id="chain"></a>STEP chain | [Execution](../runtime/execution.md#one-step-program) |
| <a id="binding"></a>Binding | [Execution](../runtime/execution.md#model-selection-and-reasoning) |
| <a id="wire"></a>Wire | [Current source](../../packages/runtime-kernel/src/internal/contract/wire.ts), [execution](../runtime/execution.md) |
| <a id="host-output"></a>Output | [Content/stream/recovery](../runtime/execution.md#content-stream-and-recovery) |
| <a id="effect-root"></a>Effect root | [Effect standard](../effect-box-runtime.md) |
| <a id="controller"></a>Controller | [Host compatibility](../runtime/host-compatibility.md) |
| <a id="status-journal"></a>Status/journal | [Operations storage](../runtime/operations.md#storage), [result observation](../maintainers/run-outcome-observation.md) |
| <a id="webui"></a>Web UI | [Future console](future/webui-console.md) |
| <a id="backends"></a>Backends | [Execution](../runtime/execution.md), [future scope](README.md) |
| <a id="recovery-diagnostics"></a>Recovery | [Context](../runtime/context.md), [maintainer routes](../maintainers/README.md) |
| <a id="pi-ai-qualification"></a>Pi transport candidate | [PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md) |
| <a id="delete"></a>POC retirement | [Rebuild archive](../archive/runtime-rebuild.md) |
| <a id="tickets"></a>Implementation work | [Ticket routes](../tickets/README.md) |
| <a id="proof"></a>Proof | [Acceptance](../runtime/acceptance.md) |
| <a id="ownership-release-proof"></a>Ownership release | [Acceptance](../runtime/acceptance.md), [LIVE](../tickets/LIVE-integration-validation.md) |
| <a id="review-live"></a>Review/live | [Acceptance](../runtime/acceptance.md#finish-a-scoped-change), [LIVE](../tickets/LIVE-integration-validation.md) |
| <a id="modeld-effect-core"></a>Modeld execution | [Execution](../runtime/execution.md) |
| <a id="model-reasoning-policy"></a>Reasoning | [Reasoning vectors R01–R06](../runtime/execution.md#model-selection-and-reasoning) |
| <a id="context-maintenance"></a>Context | [Context maintenance](../runtime/context.md) |
| <a id="pi-compaction-reuse"></a>Pi reuse | [Context algorithm ownership](../runtime/context.md#pi-复用与请求所有权), [Pi source](../maintainers/pi-compaction-reference.md) |
| <a id="ownership-continuity"></a>Continuity | [Continuity](../runtime/continuity.md) |
| <a id="continuity-north-star"></a>Continuity product | [One product model](../runtime/continuity.md#一个产品模型) |
| <a id="continuity-observation"></a>Loss protection | [Loss/Routine/notification](../runtime/continuity.md#归属丢失routine-与通知) |
| <a id="continuity-policy-evidence"></a>Continuity policy | [Continuity](../runtime/continuity.md), [operations](../runtime/operations.md) |
| <a id="continuity-material"></a>Recovery material | [Material authority](../runtime/continuity.md#当前状态与材料的权威) |
| <a id="continuity-primitives"></a>Current state primitives | [Native preparation](../runtime/continuity.md#原生准备接受和启动), [operation guide](../maintainers/current-state-control.md) |
| <a id="continuity-handover"></a>Handover | [Handover/retirement](../runtime/continuity.md#并行交接与退役) |
| <a id="continuity-architecture"></a>Continuity ownership | [Continuity](../runtime/continuity.md), [architecture](../architecture.md) |
| <a id="continuity-delivery"></a>Continuity work | [CONT responsibilities](../runtime/continuity.md#实施与证明责任), [tickets](../tickets/README.md#ownership-continuity) |
