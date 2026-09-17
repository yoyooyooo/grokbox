# T59 — 配置迁移、bootstrap 与旧 writer 单向退役

## Status / Goal

**Implemented · isolated migration/bootstrap/recovery verified。** 当前程序只读写统一配置；历史文件由明确的迁移命令一次性处理。当前生产 writer/迁移进度只看 [LIVE-CONFIG-CUTOVER](LIVE-integration-validation.md#live-config-cutover)，真实平台 Reset 独立看 [LIVE-CONFIG-HOME-RESET](LIVE-integration-validation.md#live-config-home-reset)；本票不复制当前现场状态。合同归 [配置 Spec §7](../roadmap/configuration-rebuild-spec.md#migration)。

## Implementation

`box-runtime/internal/io/config-migrate.node.ts` 拥有 preview/apply/status/recover；`config-bootstrap.node.ts` 管安装资源 saga；`config-aliases.node.ts` 管 home 别名冲突的显式保全修复。CLI/bootstrap 调这些程序，不再内联脚本合并和覆盖长期配置。

迁移固定来源原字节与 digest，验证新字段、role/root、冲突选择和旧 writer；锁内重查后发布 prepared/publishing/published/activated/retired 阶段。Box 的 config/models 入口是受管别名，canonical 在 durable；client-only 不制造模型文件。模型文件验证而不重写，chatDialect、secret refs 与格式均保留。

普通读者没有历史路径 fallback。切换过程的原文件进入本操作受保护备份/退役目录，部分发布可对账恢复；后续用户编辑使恢复受阻，不能以旧备份覆盖。实际存在的 ops 原型偏好可迁入，原绑定/授权保全且要求重新验证，不复活执行许可。

bootstrap 用稳定 operationId 记录本次 before/after 配置和安全状态，所有偏好经同一 ConfigChange。新装只写 canonical；已有老配置先迁移。回退只允许仍属于本次操作的版本，后来编辑保留为冲突；不更改模型字节或启动服务。

别名修复能保留不合法 JSON 的编辑器片段，固定预览后恢复链接。未知链接/非 owner/冲突不得静默采用，已完成 repair 也不能覆盖第二次用户编辑。

## Executable acceptance

```bash
bun test packages/box-runtime/test/config-migration.test.ts packages/box-runtime/test/config-bootstrap.test.ts packages/box-runtime/test/config-aliases.test.ts
bun test test/config-packed.test.ts test/profile.test.ts
```

覆盖每个迁移阶段中断、active writer 阻断、preview 后 source 变化、canonical/legacy 显式冲突选择、后续编辑、client-only、bootstrap 重入/回退和实际 Node CLI。既有模型 bytes 与 file/env 引用保持；源与 alias 被修改时不自动合并。

## Remaining proof / Stop conditions

Linux 的进程扫描是当前停写预检；无法判定的进程/平台拒绝迁移。它不等于持续监督所有外部 writer，也不证明当前服务已经切换；现役运行须统一安排已知旧 writer 的退出、固定制品、备份与消费者读回。当前没有实际停生产 daemon/modeld/Host 或执行云电脑 Reset。

独立代码复审是非 live 发布阻断，留在本票和 T60；不得转移成“只差 live”。LIVE 条目只有源提交映射、复审和授权满足后才能 ready。禁止为验收删除旧用户数据、重放任务或隐式增加通知费用。
