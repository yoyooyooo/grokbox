# T54 — 固定用途与单目标配对

## Status / Goal

**Partial：普通提醒与维护分析任务复用原接收者、配对、outbox 和管理 Server sender；维护用途的显式授权、认领/结果接口已有隔离证明。未配置维护 Bot 时的真实默认用户出口、真实 Bot 回合和完整冷启动接续尚未关闭；高级路由不是这些缺口的前置。** [Spec §6.3](../roadmap/template-ops-automation-spec.md#bot-routing)。

## Current Home / 所有者

当前配置和权威边界见 [operations](../runtime/operations.md#maintenance-task-delivery)。AH-143 独占本轮公共 ops schema / Server 配置接线、固定用途、接收者和 outbox；AH-188 独占来源变化分类及原 `host_patch_health` producer。任务消费者读取原 incident 的固定 evidence revision 中 `sourceChange`，不从 SHA、checker 文案或模型输出自行分类。AH-189 的修复执行和 AH-190 的采用控制不在本票内。

实现复用 `notification-contract.ts`、`pairing-contract.ts`、`ops-bindings.node.ts`、`notification-outbox.node.ts` 和原管理 CLI/API。没有 router.db、第二套事件库、模型目录、修复执行器或另一个 sender。

## 两种固定用途

普通 `brief-notice` 使用 `ops.routing.defaultTarget`，`routing.enabled=false` 仍选择该目标，`notifications.mode=off` 阻止本用途投递。专用 `diagnose-or-report` 使用 `ops.maintainer.target`；须显式开启 `maintainer.enabled` 和 `diagnostics.mode=automatic-bounded`，目标允许相同 intent，并经过独立分析授权。preset、目标配置、准备配对及 severity 都不是授权。

两种用途各只有一个确切目标，不按消息内容选择或升级目标，不以维护 Bot 替换未知用户提醒。一次原工作对应一个用途；`sourceState=snapshot`、`no-intersection` 不派工，`related-same-shape`、`structural-change`、`unknown` 形成分析任务。结构风险仍须普通用户可达出口，当前不能用维护任务或本地记录代替该验收。

`NotificationBinding` 继续绑定 database/scope、alias/exact Agent/Routine、model/qualification、policy revision 和五秒观察窗口。用途还必须匹配固定 Routine 行为：`notify_then_end` 或 `claim_analyze_report`。共享真实 Bot 的多 alias / 多用途共用目标唤醒额度；安装用途分别限额，每次 reservation 包括未知结果和明确拒绝均消耗额度。

## 配对与授权

正式入口是 `notification`、`routine` 与 `system config` 管理族；本页历史报告中的 `ops targets` / `ops notifications` 入口已退役，不可按旧报告复活本地 writer。配置提交不会新建/唤醒 Bot、启用 Routine 或变更模型。

原配对 owner 处理确切受管 disabled Webhook 定义、预期 revision、scope/代际和至多一次凭据获取。capsule 仍为单一私有凭据/元数据 owner，8 槽、主/暂存各 64KiB，查询不返回 key。prepared-only 不授予发送；unbind 也不证明在途效果取消或原生 key 已撤销。

`notification receiver verify` 只读当前资格。`notification receiver enable` 需要原接收者引用、预期绑定 revision、实际预检的 model revision、持久 request UUID 和 `--confirm`；不再需要 test work 或操作人声明已收到。维护分析另须 `--confirm-analysis`，旧提醒的 enable 请求/authorization capsule 不会升级为分析授权。启用不发送测试、不自动开启原生 Routine、不补旧积压。独立测试不是启用前置。

HTTP accepted、receiver-credential 认领/结果、实际原生 Bot 回合和用户展示分别记录。认领不能清除原 HTTP unknown，更不能授权修复/采用。有限拒绝重试、查询与冷启动界限见 [T45](T45-template-webhook-delivery.md)，实际接收模型/工具/数据资格见 [T55](T55-custom-receiver-delivery.md)。

## 检查和剩余范围

`ops-routing.test.ts`、`notification-task.test.ts` 验证固定用途、合同、独立配置及授权；`ops-notification-outbox.test.ts` 验证原 SQLite、预算、明确拒绝重试和未知/备份恢复围栏。`test/notification-management.test.ts` 的真实 Node/HTTP 子套件包含原 CLI/API 以及新任务的认领、丢 HTTP 确认、重启续报和反例。

新任务 HTTP 证明使用自有接收端、隔离安装和符合 AH-188 合同的固定样例，在原安全通知/attempt 边界装载任务；不是已经运行真实 AH-188 producer、官方 Webhook 或模型分析回合的证明。真实 producer 合入 v2 后须验证原分类→固定 evidence→本 outbox→实际目标，不复制兄弟分支未合代码绕过合流。

高级有序路由、备用、集中 reportTarget 和跨 Bot 交接均后置。unknown 不 fan-out，不猜最近 Bot，不自动换模型、广播或新建接收者。配置/绑定故障必须可查询，不以备用成功掩盖原任务义务。

## Exit evidence

待验只归 [LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)、[LIVE-OPS-OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime) 和原索引内 AH-143 段。源码与隔离证明不等于默认出口可达、部署或整票 Done。
