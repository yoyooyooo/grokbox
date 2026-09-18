# T45 — 固定现场通知、原生 Webhook 与投递对账

## Status / Goal

**Partial：固定证据/J1、事务化outbox、显式HTTPS及持久授权后的daemon自动发送已实现；采集/服务持久安装、真实接收者回合及native对账仍未完成，M3未关闭。** [Spec §4/§5.4/§6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。把已固定的故障摘要、ID和取证命令送给配置目标Bot；默认仅提醒，不自动执行取证或Issue。

## Depends-on / Modules

依OBS-02/03证据与视图、T43 transport、T51/T54最小目标合同；Fake可先行，T53/T46完成原生接收集成。不依赖T47/T48/T49/T52/T56/高级多Bot路由。

kernel `internal/commands/ops-notification.ts`及policy/routing；box-runtime原SQLite扩outbox/attempt/budget/claim域、`native-notification.node.ts`，事件采集继续由monitor持有；发送由既有daemon的有界生命周期装配，不在调用Bot/RPC的请求Scope中启动。

## J1 共享接纳（不等于投递可用）

`openContinuityObservationBridge`复用`openMonitorStore.ingestEvidence/evidenceCursor/evidenceSourceStatus/linkedEvidenceIncidents`；CONT从自己的store提交后用稳定事件ID与源cursor重入，不创建第二通知器或跨store事务。固定revision与本地work复用现有SQLite；ops off仍保留证据但不创建新通知意图。归属丢失作为保护对象用户影响，不套用纯上游项目bug过滤；原ownership_changed边沿不改。

bridge receipts明确`transport=unavailable/automaticRetry=false`，本地export/已有attempt未知时可查unknown；没有POST、绑定、网络去重或接收者模型资格。14项J1合同测试覆盖真实SQLite重复/重启、提交前后故障、窗口/序号gap与关闭通知不结束CONToperation，真实网络unknown仍待下文T45验收。接口唯一归[Spec J1](../roadmap/template-ops-automation-spec.md#obs-continuity-interface)，不把J1算作原生Bot送达。

## 单次可靠投递切片（2026-09-18）

`notification-contract.ts`从已校验effective ops选取唯一default目标；`ops-notification.ts`经OpsNotification port执行一次程序。原monitor SQLite的`notification_work/notification_attempts`承载预留、启动和结算，不另建router/queue数据库，也不改schema4/models2/wire8。存储方法是`notificationScope/notificationDelivery/reserveNotification/beginNotification/settleNotification`。

同一work本片至多一次attempt，BEGIN IMMEDIATE共同预留实际Agent的滑动24h额度和安装额度；别名不增加额度，未决及已拒绝attempt仍占普通额度，不借critical reserve。冻结incident revision、binding/model/routine/data/policy身份及实际body digest/bytes；只发程序生成的安全摘要和只读命令，最大8KiB。新增最多4096个attempt和既有文件空间接纳门，不按TTL删除unknown以换取再次发送。

`runOpsNotificationDelivery`默认无driver；有明确信任的`PairedNotificationDriver`时才检查配对。inspect不能返回secret/endpoint，发送前再检查身份，并在现有config锁内对照最新policy后提交启动。网络在所有本地事务/锁之外，真正返回后才结算；取消不会遗留detached writer。callback异常/本地提交回执丢失保留unknown，既有attempt不重发；native-accepted不表示Bot完成或用户已读。T46已有私有binding/capsule，显式发送driver复用它；持续授权必须走下述显式激活程序，不能把测试注入对象写成config来启用。

只读`ops notifications list/show`已注册，坏Profile不挡本地取证；不建库、配对或发消息，列表明确有限窗口。明确未接收的有限重试、native unknown对账、备份恢复fence和自动worker安装仍在下文未完成范围。J1 bridge接口与CONT生命周期边界不变。

## 显式原生发送出口（2026-09-18）

`ops notifications send <work-id> --expect-binding-revision <n> --expect-model-revision <sha256> --confirm`只发送一个既有work；不自动启用Routine、不领取新key、不接受任意body/URL。绑定的提醒Routine须已单独启用且只有enabled位改变，模型须匹配用户确认指纹；Host同帧与Server所有权采用现有准入事实并保持原始时龄。复用原outbox的预算、二次检查和单attempt语义。

`ops-explicit-delivery.runtime.ts`装配现有程序，`ops-bindings.node.ts`在私有owner内持key调用`native-notification.node.ts`；生产只允许已登记backend，Node HTTPS验证证书且不重定向/重试。固定body再次全量重构校验，响应仅有界计数，不输出正文/敏感头。完整200与Bot报告、用户已读分列；断连/异常响应保持unknown，取消必须结算真实描述符。当前控制命令是explicit，不产生永久automaticDelivery授权。

官方HTTP事实已写入[上游Current Home](../upstream-integration.md#native-routine-and-notification-webhook-boundary)。固定源码/Node/HTTP证明与两次整目录测试宿主超时的诚实限定见[回执](../reports/2026-09-18-explicit-native-notification.md)。

## 持久授权与自动发送（2026-09-19）

已实现`ops targets activate`：必须引用24小时内同一binding/model/qualification的实际accepted测试work，并单独确认观察到提醒和未来唤醒费用。`--confirm-receiver`是操作人声明，不由HTTP200、Bot文字或preflight推导，不声称程序观测了原生工具/回合。精确操作ID幂等；同配置锁内保存授权并增加binding revision，不领取key、启用Routine、启动服务或发消息。明确锁竞争是activation_busy，可能落盘仍是unknown；重复操作不能刷新授权边界。

既有daemon持有`startOpsNotificationWorker`。每轮最多一条，空闲5秒、阻断30秒起指数退避到5分钟，上一轮结算后才等下一轮；无新work/关闭/预算不足时不访问原生。只处理创建时间严格晚于授权边界的work，历史积压不补发；复用原outbox、私有owner和HTTPS，不增加router/队列/凭据文件。每次发送重新核对模型、Host/账户代际、Routine、scope、预算和撤销。unknown仍不可重投，退出中止并等待真实HTTP与落盘结算，不留后台晚写。

`ops notifications worker`只读现有daemon状态，不启动服务；`ops targets show`区分持久授权和当前资格。disable/unbind删除授权并递增revision。循环自身不调用模型，但发送原生提醒可能消耗模型额度。collector生产新work和daemon/collector开机安装仍是独立前置，不由sender自动初始化观测库或启动采集。

专项`automatic-notification`131 pass/0 fail，含真实私有capsule/SQLite/loopback HTTP、并发与撤销、daemon生命周期及打包Node。与最新v2的CONT交叉回归52项通过；完整回归范围与末组工具拦截见[固定回执](../reports/2026-09-19-automatic-notification.md)。

## Work

同incident/occurrence/阶段稳定workId；准备工作只在固定manifest可读后ready，缺证可partial。冻结evidenceRevision/目标/binding/dataPolicy，默认inline安全摘要足够提醒。最多一主一补充只读command descriptor；不发完整JSON/任意shell，标box-local限制。

发送前短事务预留attempt和可能的唤醒额度，事务外网络。保存native-accepted/definitely-not-accepted/unknown，Bot报告单列。崩溃在attempting先对账，不自动POST；HTTP接受不代表用户收到。可用native claim仅返回安全摘要、验证真实caller与租约；没有能力不伪装身份隔离。

unknown默认不重投/不切备用；确定未接收有限退避，遵守安装/目标/发生周期预算。关闭/撤销阻止未发，不取消用户任务。TTL15min、有限待办与恢复合并摘要、source重放floor及去重退役接OBS-04；目标长期不在线不无限排队，通知失败不递归报警。

## Executable acceptance

已实现`packages/box-runtime/test/ops-notification-outbox.test.ts`（含真实source/packed CLI、子进程强杀）和`packages/runtime-kernel/test/ops-routing.test.ts`；组合`bun scripts/verify-runtime-rebuild.mjs ops-notification`。固定结果与依赖范围见[本片回执](../reports/2026-09-18-notification-outbox.md)。

HTTP验证实际实现为`packages/box-runtime/test/ops-native-notification.test.ts`与`test/ops-native-notification-cli.test.ts`，含独立Node传输子进程，不另建同义空文件。组合`bun scripts/verify-runtime-rebuild.mjs native-notification`122 pass；全仓不重叠分组2612 pass/20 skip/0 fail。daemon自动worker已有源码/隔离验证；实际原生TLS/接收者回合、collector安装和native对账仍待资格，不能把loopback HTTP算native产品已收到。

临时真实DB/HTTP＋Fake原生Bot，注入prepare/manifest/commit/reserve/POST后崩溃，证明游标/证据不丢，未知不会重复创建工作或唤醒。多进程争领、错误binding/旧revision/预算耗尽/同Bot多alias、禁用、断网、过期恢复、恶意payload均有断言；网络实际bytes通过OBS-03投影。

固定native通知回执与Bot report引用，提醒不执行diagnostic/GitHub/control，无回应不再唤醒。原生模型消耗无法硬限制时明确notProven，不以本地请求数冒充token上限。

## Forbidden / Non-goals / Exit

不sendPrompt代Webhook、不要求Bot常驻poll、不复活旧未知动作、不在SQLite事务内网络/模型。实际目标/消息链看[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)和[OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)；本地callback returned不是交付资格。
