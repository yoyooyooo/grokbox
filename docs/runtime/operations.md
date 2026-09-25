# 原生 Bot 运维、故障证据与有界存储

本页拥有通知、incident/证据、存储和后续受托运维的合同。当前字段/默认/版本以 [配置源码](../../packages/runtime-kernel/src/internal/config/schema.ts)和 [storage policy](../../packages/runtime-kernel/src/internal/config/storage-policy.ts)为准；运行时参数由 registry/help 拥有。本页不复制一份当前完成表，具体差额归 [OBS/ops tickets](../tickets/README.md#incident-evidence)，现场状态归 [LIVE](../tickets/LIVE-integration-validation.md)。

## 范围与能力现状

`ops.observation.enabled` 独立控制 Host 的只读兼容性观察，默认 `true`；它不从 `runtime.desiredMode`、`ops.enabled` 或用户通知模式推导。安装所有者通过原 `system config` 的 ops 域修改，配置提交不等于运行采用。Server 向 Host-health 的 `observationEnabled` 端口按轮读取当前配置；读取失败不回退到默认启用。这个字段不参与接收者投递指纹，关闭观察不会伪造撤销、重新配对或新的发送授权。生产者端的动态控制由 HOST-01/AH-188 提供，实际运行验证仍归原 LIVE。

三条行为链分开：自动通知默认只提醒并结束；用户明确委托后，原生 Bot 可在任务范围内自主取证、操作和核验；独立预授权维护还需对应能力/预算/原生安全门。通知模式不是所有 Bot 的永久只读 persona，也不是诊断/重启/公开授权。

源码提供 incident/evidence、管理 Server 所属 collector/sender、Routine 管理/provision、私有配对、接收者预检、显式发送和持续通知授权。collector/sender 已复用原实现移入管理 Server Scope，旧 daemon 不再启动二者；采集状态由 `system service get server`、通知安全状态由 `notification status` 读取，具体接线与证据范围见 [CLI-05](../tickets/CLI-05-implementation-follow-through.md)。已安装的诊断 writer 共享写前容量接纳；执行历史、compact 和 provision 由原 owner 压缩已结算明细并保留拒绝旧操作的标记。`runtime services`只对已证明可用且启用 linger 的 systemd 用户管理器注册精确 daemon/modeld 单元，预览/状态不安装，确认也不修改原生 Host。目标机器的启动管理器、当前制品采用、实际原生提醒与 unknown 对账需各自资格，不能由源码存在或已注册单元推导整条无人值守交付。

首发默认提醒不等待高级 routing、自动诊断/Host 维护、完整连续性或支持发布；但若宣称长期无人值守和全安装有界，必须完成对应服务/容量门。自动 Issue、默认询问是否建单、内置 REST publisher 和自动公开 grant 已退出当前范围。后续用户决定公开时仅复用已有可用 gh 身份，不自动登录、换身份或补发旧事故。

## 对象与权威

SourceFact 由实际 Host/modeld/controller/原生 adapter 捕获；Incident 是 occurrence 或 condition；Assessment 保存版本、basis 和推断；EvidenceSnapshot 固定 revision/manifest；NotificationWork 属于一个发生周期及阶段；DiagnosisTask 源于用户任务或独立授权；MaintenancePlan 由原 controller 执行；RetentionPlan 由对应存储 owner 批准。

installation/scope、Bot、dispatch/TURN/STEP/native request、failure/tray、Host/service generation 分开。无 STEP 可以建 incident，不能虚构 STEP。关系只来自显式原生字段、同调用上下文或核验回执，保存 edge basis；名字、时间相邻和文本相似只能形成检索候选，不能 join 成执行许可。

自由错误文本、日志、模型输出不能决定命令、路径、接收目标、severity 或授权。通知命令从可信 registry 和验证参数构造，仍只是取证入口。相同 UID 任意 shell 不是沙箱；缺原生工具隔离时不得宣称自动诊断/维护已安全。

## 发现、固定现场与投递

原 writer 在关键边界输出有界事件，失败/背压影响观察质量而非改写业务结果。执行安全持久化失败则由原执行 owner 拒绝不能安全记录的新副作用。collector 复用安装 scope、受管目标和有限来源读取；目录事件仅加速，有界轮询兜底，准入需求优先，不每个 Bot/页面/token 建 collector。

本地 drain、远端采样、过期检查、存储维护各有有界子任务；慢 Server 读取不能阻塞本地故障发现。单 SQLite writer 短事务提交 evidence、incident/revision、分类依据与通知准备工作，消费 cursor 同步；网络和模型不在事务内。跨文件/DB 用稳定引用、staging/manifest 与恢复协议，不假称分布式事务。

intake 接受已知错误、独立原生未知错误、无 STEP 拒绝、队列失败、组件故障和观察自身 gap。未知 schema 只保留安全形状/计数/coverage，不原样保存 payload，也不静默丢弃后报健康。stalled/suspected 与实际死锁分开；正常长任务、审批和源失联有不同含义，迟到事件不复活终态。

先固定最低证据再通知；证据不齐可生成 partial 和明确缺口，不无限等待工具收束或 LLM。事故时 loaded 状态与事后当前查询分栏。真实项目错误、未分类异常和归属丢失可通知；纯上游正常行为的项目 bug 分类不得吞掉 CONT 用户保护影响。severity、是否修复和是否有自主权限不是同一维度。

默认 Bot 只转述安全现象、ID、一条主取证命令和必要补充，然后结束；不读整份 JSON、不自动诊断、询问 Issue、派 Bot 或循环催问。用户随后委托才开启同 incident 的独立任务。

<a id="maintenance-task-delivery"></a>
## 维护分析任务投递

AH-143 的最小维护用途复用上面的事件、原配对和 outbox，不是新增修复执行器。普通用户提醒仍为 `brief-notice/notify_then_end`；专用维护目标使用 `diagnose-or-report/claim_analyze_report`。只有 AH-188 原 producer 的固定 `sourceChange` 分类可驱动后者；snapshot/no-intersection 不派工，related-same-shape/structural-change/unknown 保留分析任务，旧证据缺字段不补造分类。生产者合入 v2 后的实际贯通必须另验，符合合同的自有样例不代签真实 producer。

配置通过安装所有者的原 `system config apply` ops 域入口维护：

```json
{
  "observation": { "enabled": true },
  "notifications": { "mode": "off" },
  "maintainer": { "enabled": true, "target": "maintainer", "maxAutomaticWakeupsPerDay": 2 },
  "diagnostics": { "mode": "automatic-bounded" },
  "maintenance": { "mode": "off" },
  "routing": { "enabled": false, "defaultTarget": "maintainer" },
  "targets": {
    "maintainer": {
      "agentId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "routineKey": "maintenance-analysis",
      "allowedIntents": ["diagnose-or-report"],
      "dataPolicy": "safe-summary"
    }
  }
}
```

这是替换占位 Agent ID 后提交的意图示例，不是启用授权；`notifications.mode=off` 仅演示普通 Bot 提醒与维护用途独立。沿原受管 disabled Routine→配对→verify→enable 流程，分析 enable 另须 `--confirm-analysis`，固定当前 binding/model revision、request UUID 和 `--confirm`。旧提醒的授权、preset 或告警严重性不能升级为分析许可。配置提交不会唤醒 Bot、启用 Routine、改模型或采用新 Host。

接收 Bot 还需明确委派的本安装管理凭据，principal 为 `notification-receiver:<bindingId>`、capability 为 `notifications.tasks`；凭据由原访问管理 owner 提供，不进入 Webhook payload，也不由本接口自报 Agent ID 获得。缺凭据、实际工具或安全边界必须在真实窗口暴露并阻断，不能用配置存在冒称维护任务可用。

`POST /v1/notification-task-claims` 以原 database/work/attempt/taskDigest/request UUID 原子认领；`GET /v1/notification-tasks/:databaseId/:workId` 查原回执，后缀 `/evidence` 仅按有效原认领取任务未过期的固定 revision 公开摘要；`POST /v1/notification-task-results` 增加原 claimId、有限结论和报告 digest。结论只有 no-action-proposed、repair-proposed、inconclusive、blocked，不能签“修复/采用已完成”。字段与资格细则见 [T55](../tickets/T55-custom-receiver-delivery.md)。

原 attempt 内分别保存 HTTP 结果和 `source=receiver-credential` 的 claim/result。`nativeTurnObserved=false` 与用户展示未观察保持明确；认领/报告不会把 HTTP unknown 改为 accepted。重启能查询及补报同一已领取任务，重复同 request 幂等；尚未投递的旧 backlog / 不明预留仍受原恢复围栏保护，完整自动冷启动接续未交付。新接口不授私有 Host 源码、本地诊断明细、模型工具、修复或采用权限；AH-189/AH-190 分别承接后续职责。

**当前默认出口缺口：**最小只读原生能力核实尚未得到可用于本路径的任意用户告警写接口。没有维护 Bot 的普通用户仍缺已资格化的默认可达出口；本地页面、文件、日志或 HTTP200 都不能代签用户已看到。结构风险需要用户提醒，这项不会被维护分析任务替代。待验统一回 [LIVE 的 AH-143 段](../tickets/LIVE-integration-validation.md#ah-143-delivery-gap)，整票不能仅凭合入 Done。

## 配对、接收者与自动授权

配对的配置意图、私有 binding、原生 Routine、当前模型/能力、发送授权和用户收到通知是不同事实。bind 先验证安装/scope、受管且 disabled 的 exact Routine/revision，确认后持久占位，至多一次原生凭据请求，再复核后原子发布 capsule。enrolling/unknown 阻止换 operation 绕过；晚到凭据不能复活已解绑 revision。

capsule 是单一受保护凭据/元数据 owner，不把 secret 拆成可能错配的独立普通配置；输出只有白名单 metadata。既有 owner 丢失/损坏不当首次初始化。unbind 移除本地引用/授权，不声称原生 key 已撤销、在途任务已取消或介质擦除。

blueprint 按已配置用途提供固定 disabled 提醒或分析定义，verify 只读预检。实际自动任务模型和 loaded capabilities 必须来自同帧原生选择，而非聊天配置猜测；前后 scope/Host/定义/绑定/模型 revision 和最后新鲜度核验。preflight_ready 不是真实 Webhook、工具执行、接收或运行权限。

显式 send 只处理一个既有 work 和私有固定 endpoint；不接受任意 URL/key/body，不启用 Routine、不创建后台 grant。Routine 必须由独立动作启用，且除 enabled 位外与配对定义一致。使用原 outbox 预算/claim/unknown 协议，生产 TLS/origin/无 redirect 约束归 [上游 Webhook 边界](../upstream-integration.md#native-routine-and-notification-webhook-boundary)。

**当前自动发送链：** `notification receiver enable` 在精确绑定、当前模型/来源核验及显式费用确认上记录未来授权，不要求 accepted 测试回执或操作人已读声明；不启动服务/collector、不启用 Routine、不立即发送。`notification status` 通过共享 API 只读 sender 状态。已经运行的管理 Server 监督自动发送程序，只选授权边界之后的新真实 incident work，不补发旧积压。无授权、无新 work、关闭或预算不足时，不为探测可用性请求原生接口。每轮有界处理，完成后等待/退避；停止需中止并等待真实 HTTP 与本地提交结算，不能留下脱离寿命的发送。解绑清授权，模型/身份/定义/Host/scope 变化阻断而非自动重签或切备用。

`notification receiver test` 是独立显式外发；使用单独测试权限、原 outbox/费用限制和固定测试内容，不创建 incident 或授予未来权限。`notification receiver disable/unbind` 与 enable 的历史回执原子保留在原私有 capsule；重放旧 enable 不复活已撤销授权。`notification list/get` 展示 test/incident 及各自 attempt；`operation get --domain receiver|notification-test` 按原数据库和请求查回结果。unknown 测试阻止再次测试，但不能成为启用门槛；测试、Bot 报告、用户已读分别判断。

源码入口：kernel `internal/observation/notification-activation.ts`、`internal/commands/ops-notification.ts`，Box `internal/roots/ops-activation.runtime.ts`、`ops-automatic-notification.runtime.ts`，Server `notification-management.ts` 与管理 Scope 组合。原生当前资格和独立 review 仍由 [ops/T45](../tickets/T45-template-webhook-delivery.md)、[ops/T50](../tickets/T50-template-ops-release-proof.md)及 LIVE 记录。

## 投递状态、成本与撤销

work 的准备/ready/完成/过期/替代/阻断，attempt 的 reserved/attempting/native-accepted/definitely-not-accepted/unknown，Bot report 的 observed/not-observed 和 incident 的 open/resolved/ack/snooze 分开。HTTP accepted 不证明 Bot 完成或用户已读；用户接收声明与程序证据也分开。

发送前短事务预留 attempt 和费用，最终 policy/binding 检查沿既有配置锁完成，网络在所有本地锁之外。原自动授权链仅对 `definitely-not-accepted/native_rejected` 开放有限重试：同一 work 最多三次，前两次明确拒绝后的间隔分别为 30 秒、120 秒，不延长原到期。绑定/模型/策略身份须与第一次完全一致；显式 send、独立 test、撤销/过期/策略拒绝及 unknown 均不自动重开。只读回执提供 `retry` 和有限 `attemptHistory`，单次程序本身不循环发送。持久 attempting 崩溃后先 unknown，对账不能换目标广播。费用按安装用途/真实接收 Bot/发生周期共同计数，同一真实 Bot 跨 alias/用途不扩目标额度；原生 token 花费不是本地请求数硬限。

精确配额、TTL、backoff 和状态 schema 由 source policy 拥有。无变化不产生周期 LLM 摘要。过期积压不逐条补送，有限合并必须保存 supersedes/未知投递和原发生周期限制。sender 故障形成有界本地健康状态，不递归制造无限通知。

默认一个明确 primary/default，routing disabled 不等于通知 off。高级首匹配、备用、集中报告和跨 Bot 一层诊断交接是后续范围；unknown 不 fan-out，供应商/数据/模型变更需重新核验授权，不能为了可达自动换脑。官方与自定义接收者可能共用故障中的 Host/Box，不保证跨故障域高可用。

备份恢复不能复活 binding/grant/claim，需安装身份复核和新 effect fence。通知关闭不取消业务、卸载 Host 或停止必要 GC；配置 intent/effective 与运行采用不同，损坏配置不重建默认来恢复外发能力。

## 最低证据与视图

| Requirement | 最低可诊断边界 |
| --- | --- |
| E01 | dispatch/TURN/STEP/代次/purpose 关系及 basis；时间邻近不是同执行 |
| E02 | 事故时实际 loaded 制品、选择和 revision；当前磁盘不是事故事实 |
| E03 | Provider/SDK/stream 阶段、有限结构、finish/tools/retry/cancel/预算 |
| E04 | generated → validated/released → native-started → returned → result-accepted；不能跳过实际副作用边界 |
| E05 | context operation/root、append/checkpoint/readback/unknown 与后续阻断 |
| E06 | 父运行、子任务、队列、审批、终结和 App 展示各自观察 |
| E07 | 原生告警的 create/update/publish/remove/suppress 与来源能力；消失不等于恢复/已读 |
| E08 | writer/source/collector、窗口、retention/版本/读取缺口和真实存储压力 |

字段是 observed、derived 或 hypothesis，缺失区别 not_instrumented、not_checked、not_observed_in_window、expired、truncated、redacted、unavailable、unsupported、not_applicable、conflicting。已知失败不因别处 gap 消失，未知副作用不填零。

EvidenceSnapshot 固定 sourceWindow、identities/edges、事故制品、当前观察、facts/assessments、按 requirement 的 coverage、分段引用、view policy、retention 和 digest。revision 不可变；补证新建 revision，旧通知仍指原版。查询不捕获、不建库、不联网、不 GC/续租；过期返回 summary/gap，不返回无事故空成功。

local-diagnostic 保留必要结构/身份，无默认正文；bot-notice 仅最小摘要/ID/取证入口；bot-diagnostic 需委托和数据/供应商范围；public-summary 需用户主动决定，使用报告内一致别名/公开枚举。未知工具名/字段不天然公开，参数只投影安全类型/长度/关系。低熵 hash 不是匿名化，TTL 不是安全擦除。

raw-sensitive 默认不采集，额外用途/对象/字节/期限授权仍不能把原文先发模型再脱敏。拒绝未知键、访问器、原型污染、过深/大数组和自由 Markdown 链接。输入正文/凭据/真实身份变化不应改变公共结构性结论，脱敏仍须保留故障和工具关系可诊断性。

<a id="storage"></a>
## 存储、轮转与安全退役

三个容量域独立：诊断池、执行/恢复安全状态、制品/用户数据。诊断池包括日志、SQLite 主文件/索引/辅助页、证据、通知状态和受管暂存；safety/CONT 原生恢复不因占空间被诊断 TTL 删除。用户 export、Memory、原生会话、共享文件不归观测 GC。

target 是平时回收水位，max 是新诊断数据接纳边界，reserve 计入 max。已安装范围的 monitor、journal、过程日志在原域锁之前取得共同接纳门，计入实际文件/allocated 块并预留主文件增长、DELETE rollback journal和迁移备份；计量不完整或范围丢失时不恢复更大的默认池。尚未采用的新旧 writer、用户导出、执行/恢复及制品不因此变成一个OS quota，`installationBudgetEnforced=false`保留范围限制。精确预算/版本只看[configuration](../configuration.md)和原owner策略。

process/debug 日志由真正写入 owner 分段，关闭段才回收；持有 fd 时仅 rename 不会切 writer，不用 copytruncate 假装无损。modeld 取得 listener 后才持有结构化生命周期 sink，borrower 不抢 writer；退出先结算日志/维护再关 listener。raw stdout/stderr、Job 协议输出和普通诊断有不同契约，旧 raw 文件只计量，不擅删。

journal 活动段、segment ID/inode、共享锁、游标/gap 和轮转意图共同核验；普通换段不是故障，实际缺损不能掩盖。J13 原 append owner 保留，watchdog 不重写受管活动 inode。新锁 owner-token/进程身份可恢复确证失主，旧 PID-only、未知/撕裂锁和 LevelDB LOCK 不用超时擅清。

SQLite 回收同时量 logical/live/free/file/auxiliary bytes，不以 DELETE 行数证明磁盘回落。压缩、临时文件和 compaction 需最坏空间预算；满盘不盲 VACUUM、不直接删 SST。迁移前已超额可降级分批回收，不能删除保护数据制造合规。

按明细→核心→摘要→退役治理，长期 open/ack/snooze 不永久 pin 全部明细。租约显式申请、先预留字节、有限时长/累计额度，GET 不续租；空间不足拒绝新 pin/大采集并保留摘要和最后可靠点。已发送通知说明材料有效期和缺口，回收不改变过去通知事实。

服务维护以有界批次/游标组合各 owner，无模型、全盘扫描、每 GET vacuum 或通用 path 删除器。计划时间限额不是物理 commit 完成 SLA；实际不可中断写入需结算。墙钟回拨不复活权限/通知，大幅前跳不误删承诺证据。超过预算时诊断写可丢弃并计数，执行安全账本不能因此假提交。

**先失效旧请求，再收缩明细。** 原 LevelDB writer 在同一串行队列内，仅回收已关闭/撤销 TURN 下的已结算 STEP，保留实际准入会读取的 TURN 拒绝标记；活动子项仍保护。新服务代际沿原协议拒绝旧 captured 请求。已被新操作取代的 settled compact 回执可压缩成 `detailsRetired`，旧操作返回 `operation_retired`，不再次生成摘要；unknown checkpoint不压缩成可重试。Routine provision 的已结算旧操作仅在不再被当前binding引用时，以同一SQLite事务压缩成精确fingerprint tombstone；旧ID直接返回retired，不再访问原生接口。其私有schema升级使旧writer拒绝不认识的退役状态。

这些owner保持明确物理增长门，容量不足拒绝不能可靠记账的新effect，不以累计STEP次数停服，也不删除unknown腾空间。它们不承诺无限寿命、常量空间且任意旧ID永久可重放；同样不宣称没有外部单调锚点时能识别任意整机回滚。自动通知已有worker启动边界及同生命周期数据库恢复guard；显式用户操作、全盘备份恢复仍必须按来源与未知副作用对账。当前/回退制品、迁移和CONT闭包由原owner保留，Trash仍计占用。

### OBS / CONT 接口

[continuity-contract](../../packages/runtime-kernel/src/internal/observation/continuity-contract.ts)的 ProtectedStorageRef 只接受 recovery/safety owner 与不透明 ref/revision，不传路径。measure/changeReference/maintain 由显式注入的 CONT owner 执行并结算，未接入是 unavailable/unmeasured，未知不是零。物理共享对象按 identity 去重，不把逻辑引用累加成安装物理用量。

CONT 先提交自身操作，再以稳定 eventId/source/generation/sequence 与 cursor 进入 monitor 事务；没有跨 store 原子事务。gap/unsupported 不伪造旧入站为零。通知回执、诊断 TTL、恢复保护、CONT 终结和 Bot 可删独立；事件桥不会自己导入、克隆或重投 unknown。J1 合同测试与真实恢复/原生投递的 J2 资格分别记录。

## Routine 与后续自主维护

通用 Routine 程序由 kernel 定义、CLI native adapter/Box facade 装配，直连与 daemon 共用。管理 list/show/enable/disable/delete 和单份 disabled apply、provision outcome/reconcile 已存在；批量组合、create/update --routines-from、通用 invoke/native outcome 不由此推导。provision 的独立有界 safety ledger 先 claim 后网络，unknown 按 agent/key 阻止新操作；reconcile 读精确原生定义再结算本地，不重发 create，不冒称原生 CAS。

模板只带小型 Skill 入口，不带真实 identity、secret、endpoint、历史/grant 或已启用业务任务。duplicate 实际可能复制启用 Routine，与本域新 provision 默认 disabled 不矛盾；分别披露，不能暗称复制即安静替身。

后续自主诊断复用原生 Agent loop 和已有 doctor/models/agents/context；后续 Host 自动维护只调用原 controller。计划固定实际 source/profile/切片闭包、scope、权限、影响、预算/到期/退路和 config revision。真实原生 admission fence/排空须覆盖父子任务、审批、工具、流、compact 和未结操作；一次 idle 不够。发起维护的 Bot 先交接并结束，不等待自己的 Host 重启。

cancel/timeout/换代按原 operation 对账，不重复 signal/spawn；不能自动清 circuit、改 Server harness/updater、执行保留源码或删原生数据。CONT 替换由其领域 owner 批准，通知与诊断 JSON 不签恢复权。

## 证明与失效

首发旅程是安装/实际服务→配对/资格→真实异常→固定现场→Webhook→Bot只提醒→相同 revision 可读；受托操作是独立旅程。Routine 单独验证 disabled 创建/读回、启用、实际 POST/运行/报告、更新版本、禁用和任务收尾清理。模板 endpoint/secret 隔离、通知 off 而 GC 继续、unknown 不重投都需反例。

存储必须覆盖正常/高基数故障/重复/未答通知/租约、重启、GC 中断、满盘、只读目录及多轮实际物理容量平台期，不只一次删行。source/fake、Node packed、原生隔离、独立 review 和实际账号/App/长期运行分别取证。原生事件/身份/定义、schema/分类/关系、脱敏、GC/时钟、供应商/数据或授权变化使相应资格失效；源码合入不授权现役切换。
