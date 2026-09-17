# T57 — 统一配置 schema、物理根与领域边界

## Status / Goal

**Implemented · source/temporary-filesystem/packaged-Node verified。** 配置 v2 已实现；日常两份文件，Box canonical 留 durable，client Profiles、daemon、desktop、runtime desired、ops 意图聚合，机器授权独立。实际用法见 [配置指南](../configuration.md)，合同归 [配置 Spec](../roadmap/configuration-rebuild-spec.md#schema)。不表示现役安装已迁移。

## Implementation

`runtime-kernel/src/config.ts` 导出统一 path/schema/revision/runtime 合同；`internal/config/schema.ts` 是字段与默认值唯一定义。`box-runtime/internal/io/config-layout.node.ts` 负责有界 no-follow canonical 读取、安装定位与安全发布。

全文件仅接受 schemaVersion2。嵌入 camelCase Profiles；desktop idleReclaim/keep 与 installation floor 分开；runtime desired 不含执行回执；ops 的显式叶直接覆盖固定版本预设。模型仍由原 parser/Host 同步快照管理，未搬 secrets、reviewed 或 source corpus。

重复 decoded JSON key、危险原型名、未知字段、类型/范围错误和不合法引用拒绝。文件根检查能拒绝 `/./proc`、重复斜杠和父级跳转；父对象替换不能夹带安装权限。Box/client/root/受管别名有独立身份校验。

## Executable acceptance

```bash
bun test packages/runtime-kernel/test/unified-config.test.ts packages/box-runtime/test/unified-config-store.test.ts packages/box-runtime/test/config-aliases.test.ts test/config-domain-invalidation.test.ts
bun run typecheck
```

测试覆盖严格 JSON/路径、完整 schema、数组与整对象权限、关闭配置 unset 后不得隐式开启收费能力、不同领域摘要隔离。真实临时目录测试 canonical 写入保留别名，脱离的编辑器文件可保全并修复。Host 实际模型捕获在 desktop/client 变化前后相同，模型文件字节不变。

迁移夹具包含当前 v2 的 chatDialect 和真实格式 secret ref，验证不规范化丢字段。变基基线为 v2 `f8c82c0`；不拿更早的模型 parser 写回新目录。

## Boundaries / Remaining proof

上述隔离验收没有创建现役数据、安装服务、改 Bot 模型或发 Provider 请求，不是当前现场状态声明。配置 schema 包含 ops 偏好不表示 T43–T56 workers 已实现。第三方独立复审仍是发布门；当前现场切换看 [LIVE-CONFIG-CUTOVER](LIVE-integration-validation.md#live-config-cutover)，平台 Reset 独立看 [LIVE-CONFIG-HOME-RESET](LIVE-integration-validation.md#live-config-home-reset)，不能由源码测试代签。

T58/T59/T60 消费同一合同。AH-99 的完整工程验收还包含 writer、迁移与命令整合，不能只凭 schema 文件存在关闭。
