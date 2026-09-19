# Native operations specification — compatibility routes

The current contract is [Native Bot operations, evidence and storage](../runtime/operations.md). This old path retains stable anchors for tickets and receipts, not a second specification or progress ledger. The former staged descriptions are recoverable from [the fixed rebuild baseline](../archive/runtime-rebuild.md); they do not describe the current sender or configuration. Current live results remain only in [LIVE](../tickets/LIVE-integration-validation.md).

| Prior section | Current owner |
| --- | --- |
| <a id="scope"></a>Scope | [Scope and implementation boundary](../runtime/operations.md#范围与能力现状) |
| <a id="baseline"></a>Baseline | [Current source boundaries](../runtime/operations.md#范围与能力现状), [source tickets](../tickets/README.md#template-ops-automation) |
| <a id="authority"></a>Authority | [Objects and authority](../runtime/operations.md#对象与权威) |
| <a id="chain"></a>Discovery chain | [Discovery/evidence/delivery](../runtime/operations.md#发现固定现场与投递) |
| <a id="evidence"></a>Evidence | [E01–E08 and views](../runtime/operations.md#最低证据与视图) |
| <a id="privacy"></a>Privacy | [Evidence and views](../runtime/operations.md#最低证据与视图) |
| <a id="payload"></a>Payload | [Pairing/receiver](../runtime/operations.md#配对接收者与自动授权), [native boundary](../upstream-integration.md#native-routine-and-notification-webhook-boundary) |
| <a id="support-issue"></a>Support | [Accepted scope](../runtime/operations.md#范围与能力现状), [deferred support](../tickets/T52-consented-support-issues.md) |
| <a id="issue-automation"></a>Public issue branch | [Deferred publisher](../tickets/T56-scripted-issue-publishing.md) |
| <a id="policy"></a>Policy | [Operations](../runtime/operations.md), [configuration](../configuration.md) |
| <a id="capability-tiers"></a>Capabilities | [Scope](../runtime/operations.md#范围与能力现状) |
| <a id="configuration"></a>Configuration | [Configuration](../configuration.md#storage-policy-and-adoption), [source schema](../../packages/runtime-kernel/src/internal/config/schema.ts) |
| <a id="bot-routing"></a>Routing | [Delivery/withdrawal](../runtime/operations.md#投递状态成本与撤销) |
| <a id="receiver-resilience"></a>Receiver | [Pairing/qualification](../runtime/operations.md#配对接收者与自动授权) |
| <a id="configuration-operations"></a>Change/revoke | [Delivery/withdrawal](../runtime/operations.md#投递状态成本与撤销) |
| <a id="execution"></a>Delegated operations | [Routine and maintenance](../runtime/operations.md#routine-与后续自主维护) |
| <a id="storage"></a>Storage | [Storage contract](../runtime/operations.md#storage) |
| <a id="obs-continuity-interface"></a>OBS/CONT J1 | [Domain interface](../runtime/operations.md#obs--cont-接口) |
| <a id="layout"></a>Layout/ports | [Architecture](../architecture.md), [source domain map](../runtime/operations.md) |
| <a id="surface"></a>Commands | [Operations guide](../maintainers/template-ops-automation.md), [registry](../../packages/cli/src/registry.ts) |
| <a id="agent-routines"></a>Routines | [Routine contract](../runtime/operations.md#routine-与后续自主维护), [ops/T53](../tickets/T53-agent-routines-cli.md) |
| <a id="routine-e2e"></a>User journeys | [Proof](../runtime/operations.md#证明与失效), [LIVE](../tickets/LIVE-integration-validation.md) |
| <a id="tickets"></a>Implementation | [OBS/ops ticket map](../tickets/README.md#incident-evidence) |
