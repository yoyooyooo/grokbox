# T45 — 固定现场通知、原生 Webhook 与投递对账

## 新版启用、独立测试与剩余资格

[Agent-first Spec](../roadmap/agent-first-cli/spec.md#管理异常与通知)已替代旧的强制测试激活规则：完成必要配置/授权即可显式启用；test 独立、显式、可选，产生真实测试 work/attempt 而不伪造 incident；verify/enable 不暗中投递。启用、测试、上游受理、实际投递和用户已看分别记录。后台持续投递、有限重试与 unknown 先对账仍为必需。

A22 已落实到[启用程序](../../packages/box-runtime/src/internal/roots/ops-activation.runtime.ts)、[共享管理用例](../../packages/server/src/notification-management.ts)和真实浏览器：已准备的接收者可在无历史 incident、无测试投递时显式启用；测试失败或 unknown 不成为启用前置。已退出 `ops targets activate/disable/unbind` 旧直写入口，不恢复 seed/人工已读门槛。首次目标配置/Routine/配对已按下文迁入；仍需完成确定未受理后的有限重试、真实原生对账、长期回执维护与集中 [OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime) 验收；不要求开发期间持续服务。

## Status / Goal

**Partial：固定证据/J1、事务化outbox、显式HTTPS及持久授权后的管理 Server 自动发送已接通；采集/服务持久安装、真实接收者回合及native对账仍未完成，M3未关闭。** [Spec §4/§5.4/§6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。把已固定的故障摘要、ID和取证命令送给配置目标Bot；默认仅提醒，不自动执行取证或Issue。

## Host 健康故障的投递边界（2026-09-20）

HOST-01的安装级condition已进入同一个OBS/outbox准备流程；没有第二通知队列，也没有因接收Host本身故障而放宽model/profile/ownership门。`system host health` 与Web明确显示 `notificationCoverage=local-only`：本地incident/待发送工作不代表独立渠道、HTTP受理或用户收到。独立出口未配置时不发送探测通知、不自动换接收者；真正独立出口及故障域资格仍按T55和HOST-01实现，不由静态通过签收。

## Depends-on / Modules

依OBS-02/03证据与视图、T43 transport、T51/T54最小目标合同；Fake可先行，T53/T46完成原生接收集成。不依赖T47/T48/T49/T52/T56/高级多Bot路由。

kernel `internal/commands/ops-notification.ts`及policy/routing；box-runtime原SQLite扩outbox/attempt/budget/claim域、`native-notification.node.ts`，事件采集继续由monitor持有；发送由管理 Server 的有界生命周期装配，不在调用Bot/RPC的请求Scope中启动。旧 daemon 的自动 sender 和状态 RPC 已退出。

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

## 持久授权与自动发送

新 `notification receiver enable` 需要原接收者引用、绑定 revision、核验得到的模型 revision、持久 request UUID 和明确费用授权。当前身份/模型/Routine/配置仍须通过只读 preflight，但不需要测试或用户已读声明。同一私有 capsule 原子保存 v2 explicit-enable 授权、revision 和操作回执；新动作不领取 key、启用原生 Routine、启动服务或发送消息。原生 Routine 的准备/启用是独立设置步骤。disable/unbind 也通过同一管理用例与 receipt writer；禁用可保留私有凭据供以后显式重新启用，解绑清除本地凭据而不宣称上游撤销。

历史回执绑定安装、主体、数据库、request UUID 与输入摘要，先于当前 revision/配置/原生读取返回；撤销或后续启用不改写旧回执，重放旧 enable 不复活授权。旧 v1 授权仅为读取已有私有状态保留，不允许用旧字段发起新动作，也不把旧测试或 attestation 升格为当前用户收到的证明。

管理 Server 的 Effect Scope 现持有`startOpsNotificationWorker`，复用此前 daemon 中的领域逻辑而不保留旧自动 sender。每轮最多一条，空闲5秒、阻断30秒起指数退避到5分钟，上一轮结算后才等下一轮；无新work/关闭/预算不足时不访问原生。只处理创建时间严格晚于授权边界的work，历史积压不补发；复用原outbox、私有owner和HTTPS，不增加router/队列/凭据文件。每次发送重新核对模型、Host/账户代际、Routine、scope、预算和撤销。unknown仍不可重投，退出中止并等待真实HTTP与落盘结算，不留后台晚写。

`notification status` 经共享管理 API 读取安全 worker 状态，使用独立 notifications.read 权限；旧 `ops notifications worker` 命令退出，不做兼容转发。`notification receiver list/get/verify` 已经共享 API 区分私有绑定、持久授权与当前资格；初始设置已通过 `notification settings get/apply`、`notification receiver blueprint/bind` 和 `routine` 入口接入同一管理服务。disable/unbind删除授权并递增revision。循环自身不调用模型，但发送原生提醒可能消耗模型额度。collector生产新work和管理服务开机安装仍是独立前置，不由sender自动初始化观测库或启动采集。

专项`automatic-notification`131 pass/0 fail，含真实私有capsule/SQLite/loopback HTTP、并发与撤销、daemon生命周期及打包Node。与最新v2的CONT交叉回归52项通过；完整回归范围与末组工具拦截见[固定回执](../reports/2026-09-19-automatic-notification.md)。

## 发生时间与恢复后自动重放防护（2026-09-19）

collector组合反例已修复：自动选择和直接自动发送同时检查incident原始first_seen与work.created_at晚于授权，不能把授权前发生、授权后才索引的旧故障补投。

管理服务的自动 sender 继续持有`notice-replay-fence.ts`：本次worker启动前的work/发生周期不自动补投；真正POST之前记住稳定occurrence摘要，数据库恢复掉attempt或给同一故障换work ID也不能绕过。遇到live记忆存在但DB attempt缺失，将精确匹配的work隔离为unknown，不伪造成功，并让其他新故障继续发送。有限guard在work期限及原始15分钟发生窗口都过后可退役，时间高水位拒绝回拨。停止后留下的旧work需要显式对账；不以重启重新授权、补领凭据或延长旧授权。

该证明由`notification-restore-fence.test.ts`的真实SQLite备份还原/loopback HTTP提供。它不是所有安全账本的恢复协议，也不签整机快照/系统时间回退后的全局计费计数、显式人工重发或上游副作用对账。完整安全退役仍归OBS-05，源文件和固定测试证据见[本次回执](../reports/2026-09-19-pre-e2e-observation.md#restore-fence)。

## 新管理宿主与安全读面

[管理 Server](../../packages/server/src/server.ts)先获得 sender，再获得 collector；关闭结算生产者后终止 sender 的原生读取/HTTP 并等待 outbox 结算。未配置或没有原有持久授权时不创建数据库、领取凭据或调用原生；开启管理服务不是自动授权。竞争进程仍经原 outbox 预留锁保证同 work 单次尝试。

[共享接收者适配](../../packages/box-runtime/src/internal/io/notification-receiver.node.ts)同时供安装 Server 和剩余 CLI 使用，保留已持久配对的 generation 算法，Routine、Host/model 同帧与独立所有权读取都有明确期限。换代、profile变化、重定向、超大/慢响应和取消不给成功资格。`notification status`、安全 HTTP DTO 与 Web 通知状态页只展示有限状态，不输出私有 work/授权引用或诊断正文。

[管理通知 Node 测试](../../test/notification-management.test.ts)已扩展到接收者授权/撤销回执、独立测试、跨主体隔离、真实 HTTP、CLI、SQLite 迁移/容量与未知结果恢复；[浏览器旅程](../../apps/web/test/receiver-browser.node.ts)验证同源权限/CSRF、启用无需测试、测试 unknown 不阻启用、丢回执刷新恢复及窄屏。固定源码与实际计数由 [CLI-05](CLI-05-implementation-follow-through.md)统一记录。原生事实与测试接收端仍为合成隔离输入，不代替实际 Bot/用户收到提醒。

## 独立测试 work 与恢复

`notification receiver test` 使用独立 notifications.test 权限和显式确认，与 notifications.write 启用授权分开。测试在原观察 SQLite schema 4 的 `notification_tests` 表保存身份/目标/期限，不写 incident、伪造证据或向自动采集器插入错误；与真实通知共用原 `notification_attempts`、接收者核验、唤醒预算、私有 HTTPS 出口和不确定性规则。固定测试内容在持 key 的出口再次重构验证，不接受任意正文、命令或 URL。

相同请求只查回原测试，创建后丢回执、发送未知或服务关闭都不能自动再投。自动 worker 只选真实 incident work，不消费独立测试表。测试 unknown 会阻止浏览器再次测试，却不阻止独立的启用/禁用决定。确定阻断/未受理的测试为 refused，POST 返回明确拒绝而不是成功；原始回执和投递原因仍可读取。`notification list/get` 分别展示 test/incident purpose、尝试状态和原始时间，HTTP 接受、Bot 报告和用户已读不混算。

授权/撤销回执保留在原私有 capsule；普通新授权门为64条，另按8个绑定各保留 disable/unbind 两条撤销容量及16 KiB空间，不因普通回执满而锁死有效授权。重复的已禁用/已解绑新动作不能耗用撤销保留；同请求查回历史仍可用。独立测试元数据最多128条，现有总 attempt/物理空间接纳继续生效。达到容量拒绝新增许可/测试，不淘汰旧 unknown 或使历史 enable 复活；安全回收仍随原 owner 完成，不宣称长期无限使用已验收。schema 3→4 只由显式初始化/升级操作执行，先保留备份和数据库/历史身份；普通 GET 不升级，活跃旧 collector 不被迁移夺权。

## 首次接入闭环

[共享 setup 用例](../../packages/server/src/notification-setup.ts)连接原配置 writer、Routine provision/状态操作和私有配对 owner，CLI 与 Web `/notification-setup` 使用同一合同。可以从无接收者状态依次保存目标/预算、创建 disabled Routine、私有配对、明确启用原生 Routine，再到接收者核验/未来授权；不要求已存在 incident 或先发测试。每一步单独确认，未把这些效果藏成一个不可恢复的自动向导。

配置修改只更新声明范围并保留其他目标/系统策略，重放记录先于当前配置读取；prepared 记录不能因当前内容等于 after hash 被升格成历史成功。Routine 修改使用原 SQLite 领域新增的状态 guard，配对历史留在原 capsule；没有第二通用操作库。`operation get` 增加 notification-settings/routine/pairing 领域；仅原 provision 可在 exact disabled definition 与当前 revision 已核对后显式 reconcile，不把 unknown 状态修改或凭据领取变成自动重试。

新 `notifications.bind` / `routines.read` / `routines.write` 能力分别控制凭据领取与原生定义。旧 `agents routines ...`、`ops targets ...` 普通命令和 daemon Routine RPC 已退出；尚未迁移的 CONT/保护本地 primitive、旧 `ops notifications send/list/show` 仍有各自去向，不因此宣称全仓旧入口全部退出。具体输入、恢复和限定见 [T53](T53-agent-routines-cli.md) / [T46](T46-template-ops-pairing.md)。

实际合成 Gateway、Node 服务/CLI、真实浏览器的首次接入及丢回执场景由 [setup Node](../../test/notification-setup.test.ts) / [setup browser](../../apps/web/test/setup-browser.node.ts)验证。现阶段不签原生产品已投递、通知重试/上游对账或长期安全记录维护完成。

## Work

同incident/occurrence/阶段稳定workId；准备工作只在固定manifest可读后ready，缺证可partial。冻结evidenceRevision/目标/binding/dataPolicy，默认inline安全摘要足够提醒。最多一主一补充只读command descriptor；不发完整JSON/任意shell，标box-local限制。

发送前短事务预留attempt和可能的唤醒额度，事务外网络。保存native-accepted/definitely-not-accepted/unknown，Bot报告单列。崩溃在attempting先对账，不自动POST；HTTP接受不代表用户收到。可用native claim仅返回安全摘要、验证真实caller与租约；没有能力不伪装身份隔离。

unknown默认不重投/不切备用；确定未接收有限退避，遵守安装/目标/发生周期预算。关闭/撤销阻止未发，不取消用户任务。TTL15min、有限待办与恢复合并摘要、source重放floor及去重退役接OBS-04；目标长期不在线不无限排队，通知失败不递归报警。

## Executable acceptance

已实现`packages/box-runtime/test/ops-notification-outbox.test.ts`（含真实source/packed CLI、子进程强杀）和`packages/runtime-kernel/test/ops-routing.test.ts`；组合`bun scripts/verify-runtime-rebuild.mjs ops-notification`。固定结果与依赖范围见[本片回执](../reports/2026-09-18-notification-outbox.md)。

HTTP验证实际实现为`packages/box-runtime/test/ops-native-notification.test.ts`与`test/ops-native-notification-cli.test.ts`，含独立Node传输子进程，不另建同义空文件。组合`bun scripts/verify-runtime-rebuild.mjs native-notification`122 pass；全仓不重叠分组2612 pass/20 skip/0 fail。管理服务的自动worker已有源码/隔离验证；实际原生TLS/接收者回合、collector安装和native对账仍待资格，不能把loopback HTTP算native产品已收到。

临时真实DB/HTTP＋Fake原生Bot，注入prepare/manifest/commit/reserve/POST后崩溃，证明游标/证据不丢，未知不会重复创建工作或唤醒。多进程争领、错误binding/旧revision/预算耗尽/同Bot多alias、禁用、断网、过期恢复、恶意payload均有断言；网络实际bytes通过OBS-03投影。

固定native通知回执与Bot report引用，提醒不执行diagnostic/GitHub/control，无回应不再唤醒。原生模型消耗无法硬限制时明确notProven，不以本地请求数冒充token上限。

## Forbidden / Non-goals / Exit

不sendPrompt代Webhook、不要求Bot常驻poll、不复活旧未知动作、不在SQLite事务内网络/模型。实际目标/消息链看[LIVE-OPS-ROUTINES](LIVE-integration-validation.md#live-ops-routines)和[OBSERVER-LIFETIME](LIVE-integration-validation.md#live-ops-observer-lifetime)；本地callback returned不是交付资格。
