# Configuration rebuild — compatibility routes

Current configuration fields, layout, writer behavior, migration and commands are owned by [Configuration](../configuration.md), its linked schemas and [Architecture](../architecture.md). This old rebuild path no longer carries a historical schema example as a current contract. Original staged design is recoverable from [the rebuild archive](../archive/runtime-rebuild.md).

| Historical anchor | Current owner |
| --- | --- |
| <a id="decisions"></a>Decision | [Configuration decision](../decisions/2026-09-17-unified-configuration-rebuild.md), [current configuration](../configuration.md) |
| <a id="baseline"></a>Source baseline | [Source authority](../configuration.md#source-authority) |
| <a id="layout"></a>Physical layout | [Two entry points](../configuration.md#two-human-entry-points) |
| <a id="schema"></a>Schema | [Current shape](../configuration.md#document-shape), [schema source](../../packages/runtime-kernel/src/internal/config/schema.ts) |
| <a id="commands"></a>Commands | [Read/change](../configuration.md#read-validate-and-change), [registry](../../packages/cli/src/registry.ts) |
| <a id="writer"></a>Writer | [Scope and result](../configuration.md#scope-and-result) |
| <a id="migration"></a>Migration | [One-way migration](../configuration.md#one-way-migration-and-recovery) |
| <a id="modules"></a>Modules | [Architecture](../architecture.md#5-配置选择和迁移) |
| <a id="acceptance"></a>Acceptance | [Evidence and boundaries](../configuration.md#evidence-and-boundaries), [T57–T60](../tickets/README.md#configuration-rebuild) |

Source integration does not establish adoption. Current deployment qualification is only in [LIVE](../tickets/LIVE-integration-validation.md#live-config-cutover); historical migration examples neither authorize another migration nor override the actual schema.
