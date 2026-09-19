# 持续观测、原生警告与本地 incident

本页拥有命令、存储与诊断语义；产品合同见 [Spec S0.1.4](../roadmap/box-runtime-impl-spec.md#continuous-observation)，实现/离线/review 见 [T41](../tickets/T41-continuous-observation-and-alerting.md)。当前服务安装/长驻/通知的已验范围、未验项与下一步只看 [LIVE-MONITOR-PERSISTENCE](../tickets/LIVE-integration-validation.md#live-monitor-persistence)及其关联条目。本页不维护当前现场结果；代码存在不等于 collector 已安装或用户已看到警告。

## 权威分开，投影共用

- 原生 Host 是 Tray 的唯一 writer。`alerts list` 读取当前 Host 内存快照，关闭、清除、去重与重启都可能改变它。
- runtime journal 保存执行事实和提醒生命周期证据；监控只收集安全投影，不执行模型、不改 ownership/配置、不重发工具。
- `runtime-kernel/alerts` 的纯分类、执行身份关联和 trace 同时被 CLI 与 monitor 使用。旧文案解析标为 `legacy_text_derived`；它不会升级成直接执行身份。
- 现有 `observability/observations.sqlite` 保存索引、incident、ack/snooze、采集 cursor 及本地通知管理事实。没有 `alerts.db`，也不使用 modeld 执行去重库来保存 UI 状态。
- 执行失败、原生 Tray 变化、通知管理、App 呈现是不同事实。Dismiss 不等于 ack，ack 不等于修复，snooze 不改变准入，服务恢复不将旧失败 STEP 改写为成功。

## Provider 路由条件与 observer 范围

`upstream_route_failure` 是现有 monitor 的通知条件，不是新的执行闸门。按该观测库作用域内的实际路由摘要区分 endpoint/API/模型/凭据引用命名空间，不用同名模型合并不同通道。`provider-route-v1` 在五分钟窗口内至少两份不同执行的 HTTP 5xx 失败证据后建立条件；每个失败 STEP 仍单独保留并关联父条件。两个晚于最后失败的完整成功 STEP 才构成恢复正证据，单次 HTTP 200、日志过期、红框关闭都不构成恢复。失败源窗口过期不使 open 条件自动恢复；迟到记录归属它已知的原周期，不能污染新周期。新周期不继承旧 ack。

样本最多保留 512 份用于规则判断，这是通知的有界证据窗口，不是模型请求额度；查询披露 `bounded_route_window`。恢复中已成功的逻辑 STEP 不会被父 incident 改成失败；具体 attempt 的失败、等待和 request ID 可从 `runtimeRecovery`/`model_recovery_progress` 查看。monitor 绝不根据父条件修改模型准入、强制排队、触发恢复、切模型或 dismiss 原生 Tray。

原生 Alert observer 延后到精确目标 Host compile 通过时才初始化，继承 NODE_OPTIONS 的无关子进程不会仅因 require preload 就伪造 observer_started。默认 `alerts trace` 只展示直接关联/已挂接的来源；都不存在时，保留每个 Host generation 的一个真实覆盖样本，并报告总数/省略数，不能凭样本冒称所有采集点已安装。`--include-unrelated-observers` 显式展开同代完整来源。来源列表不授予执行身份或当前活性。

## daemon 所属的持续采集

当前源码提供一个明确的服务配置入口，复用统一config4和现有daemon，不要求终端一直运行。先预览，再把返回的配置revision连同本次operation ID用于确认：

```bash
grokbox runtime monitor install --run-root <owned-host-run-root> --agents <uuid1,uuid2> --json
grokbox runtime monitor install --run-root <owned-host-run-root> --agents <uuid1,uuid2> --expect-revision <config-revision> --operation-id <new-id> --confirm --json
grokbox runtime monitor service --json
```

确认会初始化/迁移观测域并保存`daemon.observation.runRoot/agentIds`，不会启动daemon或更改通知授权。已运行的匹配daemon会随后采用；重复同一operation核对原指纹，不重建丢失的证据库。实际服务同时消费Host/control journal，各有游标和健康；配置改变时先结算旧collector再替换。缺源、读取成功、原生源活性和采集器存活是不同事实。

`service`只读既有daemon，缺服务直接拒绝，不用GET创建环境。`ops.monitor.enabled=false`或移除`daemon.observation`会停止相应collector；只关闭通知不关闭采集或必要维护。该入口不是操作系统开机注册，状态保留`bootInstalled=false`。Linux已注册daemon socket可在确证原owner死亡、准确inode及连接拒绝时恢复；未知旧socket、损坏owner或未完成首次绑定不自动清理。实际Node/文件/SQLite证明与限制见[固定回执](../reports/2026-09-19-pre-e2e-observation.md#collector-lifetime)。

## 命令

```bash
# 既有观测域，显式创建或迁移；普通查询不会做这些操作。
grokbox runtime monitor init --confirm --json

# 单独手动运行仍是前台进程；不要与同根已配置daemon collector并行争抢。
# GROKBOX_RUN_ROOT仅供这次显式运行，不代替daemon的canonical配置。
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" \
  grokbox runtime monitor run --agents <uuid1,uuid2> --interval-ms 30000 --confirm --json

# 一轮有界采集；有积压时披露 hasMore，下一轮从已提交 cursor 继续。
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" \
  grokbox runtime monitor run --agents <uuid> --once --confirm --json

grokbox runtime monitor snapshot --json
grokbox runtime monitor events --after <cursor> --limit 100 --json
grokbox runtime monitor incidents --limit 100 --json
grokbox runtime monitor ack <incident-id> --request-id <uuid> --expected-revision <n> --json
grokbox runtime monitor snooze <incident-id> --request-id <uuid> --expected-revision <n> --until-ms <epoch-ms> --json

# 当前原生警告；不是永久历史。
grokbox alerts list --agent <agent-id> --json

# 明确 Tray 身份。不同 Host observer 实例不混算。
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" grokbox alerts trace <tray-id> --from journal --json
grokbox alerts trace <tray-id> --from monitor --source-instance <id> --json

# 无 Gateway、无 Tray 也能诊断 STEP；monitor 查询不会启动采集。
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" grokbox runtime incident <step-id> --agent <agent-id> --json
grokbox runtime incident <step-id> --agent <agent-id> --from monitor --json
```

`--agents` 是 ownership 批量观察目标；显式 `GROKBOX_RUN_ROOT` 是本地执行/提醒 journal 的来源。未提供 run root 时 collector 披露 `journal.state=not_configured`，不把 ownership 采样冒充 Alert 采集。当前最多32个目标是原生 ownership 单批协议范围，不是累计运行次数配额。

## 固定 incident 证据（首个 OBS 实施切片）

当前源码已实现以下本地入口；[固定源码与离线回执](../reports/2026-09-18-observation-evidence-first-slice.md)说明实际范围。它们不是自动 Bot 推送已经上线的承诺。

```text
grokbox runtime monitor incident <incident-id> --evidence-revision <n> --json
grokbox runtime monitor incident <incident-id> --view public-summary --json
grokbox runtime monitor capture --incident <incident-id> --confirm --json
grokbox runtime monitor capture --step <step-id> --agent <agent-id> --confirm --json
grokbox runtime monitor capture --tray <tray-id> --confirm --json
grokbox runtime monitor evidence lease <incident-id> --revision <n> --duration-ms <n> --confirm --json
```

新 `incident` 参数是 monitor 的 incident UUID；旧 `runtime incident` 仍接 STEP。默认读取已保存修订，不运行 Gateway、采集、GC 或续租。capture 是显式本地写入，只使用已经索引的证据；缺失或多义关联不能按时间猜测。快照共享事实并校验 digest，补取产生新修订，不改写已经发出的引用。

未知 error tray 和无 STEP 的原生任务 failed 现在可进入 incident，而非只存 evidence。`notification_work` 仅记录本地待通知意图，生成的 brief-notice 含实际命令、期限和缺口；仍没有真实 Webhook 投递。Bot 默认只提醒的范围、后续受托自主与配对权限继续归专项 Spec。

公共视图仅保留安全结构与报告内别名，不含真实身份、原始正文或私有摘要；普通本地输出不可整包视为公共材料。E01–E08 逐项披露来源和缺口，不以字段存在或空 diagnostic 冒充全链路完备。ack/snooze 与明细保留解耦；明细被回收时报告 expired/summary，而不是空成功。全安装容量池、完整物理回收、后台活性与安全账本退役尚待 OBS 后续票，不把本切片当成长期存储已验收。

## 原生提醒链路

`host_alert_observation` 带 `eventId/sourceInstanceId/sourceSequence`、Host generation、发生与观察时间，以及已知的源码/preload 指纹。没有字段时保持未观测。

| 事件 | 证明什么 | 不证明什么 |
| --- | --- | --- |
| `observer_started` | 观测对象已创建 | 原生 hooks 已全部安装或 App 在线 |
| `manager_attached` | 已挂接经过限定的原生 TrayManager 实例 | 所有原生拒绝分支均已插桩 |
| `decision` | main 错误分支 emit/stale suppression，或 automation 背景/节流 suppression；`decisionBasis` 区分直接分支与仅观察到 mutation 的结果 | 没有 Tray 就一定被 suppress |
| `tray_created/updated/removed` | 原生状态已经发生对应变化 | 模型/工具完成、用户已读 |
| `channel_published` | 对应这一次原生 emitter 调用成功返回/完成，`publicationBoundary=native_emitter_returned` | Gateway 远端送达、App 接收或渲染 |
| `tray_snapshot` | attach 时已存在该 Tray | 它刚刚创建或此前曾发布 |

当前直接 decision 覆盖 main-turn error 与 automation 的已限定分支；其他产生的 Tray 仍可由 manager mutation 观察，不能据此猜出未插桩的抑制原因。Host 原生 pending/current-epoch、dedupe、cap、dismiss、clear 的行为均保持不变。

本地 managed Error 通过 WeakMap/cause 链传递受限 failureId/Agent/STEP。它与执行拒绝记录相连，不读取凭据、完整异常正文或动作 URL。没有可信链接时保留 nativeRequestId 或明确的 legacy 文本提取，不将 native request、展示 post、TURN 与 STEP 相互替代。

同一 Tray 可报告多个失败；同一失败也可有多种提醒。身份关联依赖直接引用，而非时间接近、Bot 显示名或相同英文文案。旧代变化只终止当前性证明，不伪造逐条 `dismissed` 或用户阅读回执。

## 索引、诊断和降噪

Journal 与 monitor trace 调用同一纯投影，给出原始提醒决策、当前诊断版本、执行事实、来源完整性和 App 未观测边界。重复稳定 event ID 幂等；不同载荷或重复 sourceSequence 产生 integrity conflict，不覆盖原事件。乱序到达补齐 sequence hole 后收回临时缺口，不能把一次乱序永久计作丢失。

持久 incident 分为：

- `ownership_*` / `observation_unavailable`：既有持续条件。归属采样失败的 condition diagnosis 可保存 `source=monitor_ownership_read`、采样结束时间、有限 failure 与 `readObservation`（原生子错误码、读取阶段、耗时/预算及有限 RPC code）。先保留实际读取失败，不因该失败连带 scope 不稳定而改写成另一种根因。摘要在同一采样事务内更新，冷读仍可查；下一次未插桩失败不继承上一次子码，恢复后保留最后失败的原时间，不把它当成当前仍故障。旧 condition 无摘要则保持缺失。监控读取失败不是模型 STEP 失败，也不是取消权限的证据；不新增采样频率、通知通道或执行权限。
- `execution_failure`：具体 STEP 的历史发生记录，状态 `recorded`，不是等待被改写成成功的运行。
- `pre_step_failure`：有原生 operation/dispatch/事件引用但尚无 STEP 的明确拒绝；不编造 STEP。
- `shared_runtime_failure`：由同 service epoch 的结构化 admission/capacity 或 ledger_unavailable 证据建立的共享条件。每个失败请求仍保留子记录。后续同服务、更晚、明确成功且存储可用的执行可以结束这个条件周期；旧失败不被解决。再次发生创建新周期，不继承旧周期 ack。

`notification_decided` 在 incident 事务中保存固定规则版本、deliveryKey 和 emit/suppress 原因。共享父事故汇总、ack、有效 snooze 可抑制 monitor 的重复提醒，不 dismiss 原生 Tray，也不改变执行。跨批晚到的父证据不会改写之前已经作出的通知决策。

当前唯一配置渠道是 `local_only`。collector callback 返回/抛错分别记录 `notification_exported` / `notification_export_unknown`；这是本地出口证据，不是远端通知回执。输出失败后不自动重发模型、工具或用户任务。外部通知渠道尚未配置，App received/rendered 保持 `not_observed`，userRead 保持 `not_proven`。

## 磁盘事务与迁移

当前源码的 monitor schema v3 用固定 `sqlite3@6.0.1` 的 Node-API 磁盘 SQLite，增加固定证据修订、共享引用、限时租约与本地待通知记录；它与通用配置 schema 是不同版本域。发布最低 Node 为 **20.17.0**；Host/preload 不导入 SQLite、SDK 或 Effect。`sql.js` 仅留在开发依赖中生成独立 v1 迁移夹具，退役的全库镜像 runtime companion 不再打包。

这里刻意使用 **DELETE rollback-journal** 的增量页事务，而非 WAL：短事务串行写，严格只读连接不创建 WAL/SHM sidecar。不是每次加载、导出、替换整个 JS 数据库镜像。磁盘引擎缺失/文件坏时明确失败，禁止回退内存或创建空库报健康。

`init --confirm` 才迁移 v1/v2：核对 root/schema/private file，持有 SQLite 事务并检查相应旧 writer/collector owner，保全独占备份，再事务升级；旧 writer 在下次加载时拒绝 v3。迁移不为历史事故补造快照或自动排队通知。活的、身份不明的旧 collector 不被抢占。迁移或旧文件锁恢复只在明确 PID 已不存在并且锁文件身份未变时进行；不存在“锁太旧就删掉”。跨平台不能证明 PID 身份时保持 recovery-required。

新的 collector 所有权记录使用 PID、启动身份和 boot 身份摘要；并发启动被数据库事务拒绝。正常退出释放；硬崩溃后显式 run 可在证实旧进程已退出后建立新 collector epoch，恢复 SQLite 自身事务。旧 callback/cursor 不得继续写新代。初始化先私有 staging 再独占发布，失败不留下一个被误当成有效库的空文件。

采集 cursor、证据、incident 和通知决定同一事务提交。提交后回执丢失为 unknown；相同 source cursor/batch 或 management request 的重试会对账，不重复开事故。数据库迁移与 collector 更替会使不适用的旧分页 cursor 失效；不会在普通 GET 中进行隐式迁移或恢复写。

## 当前SQLite容量与修订护栏

`grokbox runtime storage status --json`已在源码入口提供严格只读的monitor存储报告：主文件bytes、页/空闲页、rollback journal/WAL/SHM辅助文件、压力丢弃计数和回收能力。当前scope为`monitor_database_only`、`installationBudgetEnforced=false`；不能用它估算整机/全安装已受控。缺数据库时返回未初始化，不创建文件。全局CLI需采用相应制品后才有此入口。

当前每writer连接对SQLite主文件设置128MiB增长护栏，并为压力记录留出余量；旧超额文件不被强制截断。达到护栏时诊断批次可被丢弃，但消费游标与storage_pressure/gap/计数同事务落盘，重复同批不加倍，回收后可接纳新证据，不是累计请求寿命配额。辅助文件已单独测量但尚无跨owner总量预留；不得宣称全安装512MiB策略已生效。

同incident默认最多3份可读修订；有效通知或证据租约保护的版本不被计数淘汰，全部受保护时新capture拒绝。退役水位保证revision不复用，已回收版本返回snapshot_revision_retired，不改读最新版。lease是同revision共享的保护槽而非任意caller授权；受安装活动槽/总期限限制，读取不续期。未知投递仍保留对账约束，不因回收明细变成可盲重试。

## 长期运行与维护

没有累计16MiB/50000事件后拒绝新观察的旧限额。保留期限与数量目标用于自动维护和压力披露，不是服务寿命：

- journal cursor 每批有界前进；半行不确认，轮转、改写、坏 UTF-8、超长行和截断明确报告。
- ownership RPC、本地journal drain和维护在同一Effect宿主内各有有界子任务；网络不持本地writer许可，挂起的ownership RPC不阻止本地failed事件入库。drain按单调时钟让出执行时间，积压不加速Server轮询，取消时各任务结算后才关闭collector。
- collector运行期间按独立周期执行小批retention和增量空闲页回收；不等待一次全库重写。候选modeld现已在listener所属Scope内启动独立必要维护，因此没有collector或通知关闭时也会回收既有过期证据；不会自动建库/迁移或启动采集。process/journal轮转已实现，跨全部owner配额和Box重启自启仍未完成。
- 活跃条件、ack/snooze/management request 不能仅为达到数量目标而删除；历史高频证据可以过期，查询披露 retention floor。已管理的 occurrence 保留受限诊断摘要，不需要永久保存 Alert 对象或全文。
- DB/collector 退化不参与模型准入，不取消正常业务。观测缺口不能证明没有失败；Alert 消失也不能证明恢复。

## modeld 必要维护与占用状态

候选modeld成功拥有listener后执行有限维护，完成后等待30秒再运行；借用服务的CLI不启动它。数据库事务结算后才做文件回收，忙锁跳过；过程日志仅由持有writer回收过期关闭段，活动fd不动。退出时先结算维护再关闭日志/listener；回收或回执故障不关闭modeld。配置损坏不启动默认GC，缺库不自动初始化；这不是原生事件collector或Bot通知器。

`runtime storage status`的maintenance分区显示最近周期、完整成功时间、回收量和running/stopped/interrupted/stale/unavailable，固定回执与暂存各16KiB。footprint在最多2048目录项/深度4内读取受管诊断命名空间的元数据，分开文件长度和allocated块，计入备份/暂存/SQLite辅助文件并按inode去重；不读取正文、不输出文件名、不沿符号链接。扫描缺口与未覆盖owner可见，budgetComparison不是全安装硬预留或删除许可，installationBudgetEnforced仍false。

只读命令不执行维护、恢复或服务安装。必要维护已由真实Node owner离线验证，Box重启自启和成套现役采用另见LIVE。[实现与证明](../reports/2026-09-18-modeld-storage-lifetime.md)。

## 结构化 journal 分段与游标

源码已接通原writer的字节轮转与配置采用：活动路径仍是`log/events.ndjson`，默认8MiB段/每root128MiB受管数据，受canonical配置覆盖。已知配置源在首次写入登记，未绑定的小型旧日志保持单文件；索引/暂存索引另有32KiB单文件上限。成功append/fsync后才记录writerPolicy，查询比较最后成功写入revision与请求值，currentWriterLiveness仍not_checked，不签整安装或现役Host已采用。配置被删除/损坏不恢复更大的默认上限。

现有`runtime incident`、`alerts trace`和monitor采集读取同一分段来源，不要求用户记住归档文件名。旧v1游标按inode续读，新v2游标绑定段ID和字节锚点；正常轮转的短暂过渡显示rotation_in_progress且不新建故障，旧段实际淘汰才返回retired_segment。关闭段半行显示sealed_partial_line，不能拼成新JSON。固定incident revision不随源段删除而改变。

普通GET不恢复轮转、不GC；writer在原锁内继续已登记意图，watchdog对分段只作同协议维护，不重新改写活动inode。目录锁v2仅按PID/UID/启动身份的缺失或变化回收对应唯一token；真实硬崩和竞争回收已验证，不用文件年龄。旧PID-only锁、无完整身份的有限准备槽及损坏/撕裂索引仍保留明确阻断，不清目录造绿。journals分区附带只读lockMetadata占用和owner状态，不输出PID/start/token或进行恢复。collector现有维护子Scope处理两个显式root的登记分段，锁忙立即跳过，通知off不停止维护；安装/自启未由这条接线证明。全安装额度、持久安装、原生采用和独立review仍见[OBS-04](../tickets/OBS-04-bounded-observation-storage.md)及[LIVE](../tickets/LIVE-integration-validation.md#live-obs-storage)。原分段证明见[分段回执](../reports/2026-09-18-structured-journal-rotation.md)，后续配置/锁/维护的原子性和未证边界见[增量回执](../reports/2026-09-18-journal-policy-and-lock-recovery.md)。

## 资格边界

源码测试包含实际磁盘、Node 打包、旧库迁移/回滚、事务提交前后强制退出、cursor 原子性、超过旧限额、只读无 sidecar、事件冲突与乱序、共享父事故和独立通知周期。原生最小切片有独立 synthetic Host fixture 行为对照；它不等于现役私有 bundle 与 App 的资格证明。新源码/preload 必须走现有 profile/re-adopt 流程后才有现场覆盖，不能因构建或单测通过就声称已上线。
