# CONT-04 — 预授权自动替换与工作交接

**状态：planned；须先完成手动原生导入闭环，当前不自动克隆真实Bot。**

合同：[S13.6–S13.7](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。依赖CONT-01可靠事件/通知、CONT-02快照、CONT-03新身份恢复，以及可验证的来源执行控制。现场：[LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)。

## 目标与权限

用户按逻辑Bot注册 `alert`、`prepare` 或 `auto-replace`。auto-replace是有效期/范围/预算明确的持久策略，在条件通过时自动继续，不要求每次接管重新审批。注册不等于绕过新身份准入或来源对账；缺可靠执行隔离时只准备替身并通知原因。

逻辑Bot映射由本地管理DB的revision/CAS维护，服务有唯一Effect operation owner。新physical UUID/generation/predecessor显式保留，只路由经过grokbox管理的入口，不冒充官方全局身份代理。

## 固定骨架

kernel continuity拥有纯状态机/下一步决策；`roots/continuity.runtime.ts` 使用已声明ports协调；`io/continuity-store.node.ts` 持久operation/nonce/槽位revision/恢复manifest与审计。observer只提交候选事件，创建/暂停/导入等执行由该owner及相应授权控制。

```text
confirmed_loss → evidence_frozen → replacement_creating
→ replacement_prepared → native_restored → old_effects_reconciled
→ replacement_activated → replacement_verified
```

所有外部调用之前保存operation身份，之后保存结果或unknown。创建超时重读同一operation/已知ID；服务重启不会换nonce生第二个Bot。处理旧事件时核对scope、物理ID及logical generation，不允许迟到操作覆盖新槽位。

## 交接门

替身默认不执行、routine默认禁用。原Temporal侧主回合、子任务、inbox、routine和外部job需分别对账；本地idle或App没Working不是停止证明。已执行效果不重放，未知执行结果通过原业务查询确认，无法确认则保留prepared。

旧routine的停用须经支持的接口并读回；新routine按原schedule/timezone和触发水位重建，避免已经到点的fire被重复消费。Webhook凭据和目标绑定由正式新建/重绑流程产生，旧URL和硬编码UUID仍未改的入口列为剩余影响。群成员、其他Bot引用和对外消息通道也按授权独立处理，不文本全替换历史ID。

源副作用隔离证明、new ownership/model/effort/数据授权、native读回和输入水位全通过后才CAS切槽位并开放执行。结束后再次验证实际新回合及通知；不删除原Bot或篡改其历史ownership事实。旧App仍向旧ID发消息时需明确提示，grokbox不能声称能阻止全部官方入口。

## 防风暴与可执行验收

一个逻辑Bot最多一个未完成replacement；跨重启保留冷却/限额和失败状态。新身份立即Temporal、相同时间窗多次被回收、创建策略改变或授权失效时进入明确blocked并通知，而不是无限创建。

实现时每个状态边界注入崩溃/取消/结果丢失；使用真实管理SQLite与独立进程验证唯一nonce/继任ID/CAS。owned Creator/Importer/ExecutionControl/Notification端口独立记录实际effect次数，证明旧pending不被重放、迟到reply不串generation、源仍运行时不会激活、新Bot再次失去Box时不会无限增殖。测试还需区分source读取不可用与已确认迁移、准备成功与激活成功、通知accepted与实际接收。

## 非目标

不永久钉住Server所有权，不修改原Temporal为Box，不转移活动进程/网络连接/审批权限，不承诺官方App和第三方固定ID透明重定向。用户只启通知时不得升级成auto-replace，管理ack不视为执行授权。
