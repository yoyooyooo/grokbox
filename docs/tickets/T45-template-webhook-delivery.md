# T45 — 固定现场通知、原生 Webhook 与投递对账

## Status / Goal

**Partial：固定证据/J1接纳、单目标策略及事务化发送程序已实现；原生配对driver、自动安装和真实回执对账未完成，M3未关闭。** [Spec §4/§5.4/§6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。把已固定的故障摘要、ID和取证命令送给配置目标Bot；默认仅提醒，不自动执行取证或Issue。

## Depends-on / Modules

依OBS-02/03证据与视图、T43 transport、T51/T54最小目标合同；Fake可先行，T53/T46完成原生接收集成。不依赖T47/T48/T49/T52/T56/高级多Bot路由。

kernel `internal/commands/ops-notification.ts`及policy/routing；box-runtime原SQLite扩outbox/attempt/budget/claim域、`native-notification.node.ts`，由monitor宿主有界Scope装配。

## J1 共享接纳（不等于投递可用）

`openContinuityObservationBridge`复用`openMonitorStore.ingestEvidence/evidenceCursor/evidenceSourceStatus/linkedEvidenceIncidents`；CONT从自己的store提交后用稳定事件ID与源cursor重入，不创建第二通知器或跨store事务。固定revision与本地work复用现有SQLite；ops off仍保留证据但不创建新通知意图。归属丢失作为保护对象用户影响，不套用纯上游项目bug过滤；原ownership_changed边沿不改。

bridge receipts明确`transport=unavailable/automaticRetry=false`，本地export/已有attempt未知时可查unknown；没有POST、绑定、网络去重或接收者模型资格。14项J1合同测试覆盖真实SQLite重复/重启、提交前后故障、窗口/序号gap与关闭通知不结束CONToperation，真实网络unknown仍待下文T45验收。接口唯一归[Spec J1](../roadmap/template-ops-automation-spec.md#obs-continuity-interface)，不把J1算作原生Bot送达。

## 单次可靠投递切片（2026-09-18）

`notification-contract.ts`从已校验effective ops选取唯一default目标；`ops-notification.ts`经OpsNotification port执行一次程序。原monitor SQLite的`notification_work/notification_attempts`承载预留、启动和结算，不另建router/queue数据库，也不改schema4/models2/wire8。存储方法是`notificationScope/notificationDelivery/reserveNotification/beginNotification/settleNotification`。

同一work本片至多一次attempt，BEGIN IMMEDIATE共同预留实际Agent的滑动24h额度和安装额度；别名不增加额度，未决及已拒绝attempt仍占普通额度，不借critical reserve。冻结incident revision、binding/model/routine/data/policy身份及实际body digest/bytes；只发程序生成的安全摘要和只读命令，最大8KiB。新增最多4096个attempt和既有文件空间接纳门，不按TTL删除unknown以换取再次发送。

`runOpsNotificationDelivery`默认无driver；有明确信任的`PairedNotificationDriver`时才检查配对。inspect不能返回secret/endpoint，发送前再检查身份，并在现有config锁内对照最新policy后提交启动。网络在所有本地事务/锁之外，真正返回后才结算；取消不会遗留detached writer。callback异常/本地提交回执丢失保留unknown，既有attempt不重发；native-accepted不表示Bot完成或用户已读。T46仍需实现实际私有binding/凭据/资格owner，不能把测试注入对象写成config来启用。

只读`ops notifications list/show`已注册，坏Profile不挡本地取证；不建库、配对或发消息，列表明确有限窗口。明确未接收的有限重试、native unknown对账、备份恢复fence和自动worker安装仍在下文未完成范围。J1 bridge接口与CONT生命周期边界不变。

## Work

同incident/occurrence/阶段稳定workId；准备工作只在固定manifest可读后ready，缺证可partial。冻结evidenceRevision/目标/binding/dataPolicy，默认inline安全摘要足够提醒。最多一主一补充只读command descriptor；不发完整JSON/任意shell，标box-local限制。

发送前短事务预留attempt和可能的唤醒额度，事务外网络。保存native-accepted/definitely-not-accepted/unknown，Bot报告单列。崩溃在attempting先对账，不自动POST；HTTP接受不代表用户收到。可用native claim仅返回安全摘要、验证真实caller与租约；没有能力不伪装身份隔离。

unknown默认不重投/不切备用；确定未接收有限退避，遵守安装/目标/发生周期预算。关闭/撤销阻止未发，不取消用户任务。TTL15min、有限待办与恢复合并摘要、source重放floor及去重退役接OBS-04；目标长期不在线不无限排队，通知失败不递归报警。

## Executable acceptance

已实现`packages/box-runtime/test/ops-notification-outbox.test.ts`（含真实source/packed CLI、子进程强杀）和`packages/runtime-kernel/test/ops-routing.test.ts`；组合`bun scripts/verify-runtime-rebuild.mjs ops-notification`。固定结果与依赖范围见[本片回执](../reports/2026-09-18-notification-outbox.md)。

`ops-webhook-delivery.test.ts`真实HTTP契约、自动worker与原生对账仍待实现；不创建空测试文件或把owned transport算native资格。

临时真实DB/HTTP＋Fake原生Bot，注入prepare/manifest/commit/reserve/POST后崩溃，证明游标/证据不丢，未知不会重复创建工作或唤醒。多进程争领、错误binding/旧revision/预算耗尽/同Bot多alias、禁用、断网、过期恢复、恶意payload均有断言；网络实际bytes通过OBS-03投影。

固定native通知回执与Bot report引用，提醒不执行diagnostic/GitHub/control，无回应不再唤醒。原生模型消耗无法硬限制时明确notProven，不以本地请求数冒充token上限。

## Forbidden / Non-goals / Exit

不sendPrompt代Webhook、不要求Bot常驻poll、不复活旧未知动作、不在SQLite事务内网络/模型。实际目标/消息链看[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)和[OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)；本地callback returned不是交付资格。
