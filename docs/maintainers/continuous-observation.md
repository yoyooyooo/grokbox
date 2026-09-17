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

## 命令

```bash
# 既有观测域，显式创建或迁移；普通查询不会做这些操作。
grokbox runtime monitor init --confirm --json

# collector 为显式前台进程。GROKBOX_RUN_ROOT 选中要索引的 Host journal。
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

Schema v2 用固定 `sqlite3@6.0.1` 的 Node-API 磁盘 SQLite。发布最低 Node 为 **20.17.0**；Host/preload 不导入 SQLite、SDK 或 Effect。`sql.js` 仅留在开发依赖中生成独立 v1 迁移夹具，退役的全库镜像 runtime companion 不再打包。

这里刻意使用 **DELETE rollback-journal** 的增量页事务，而非 WAL：短事务串行写，严格只读连接不创建 WAL/SHM sidecar。不是每次加载、导出、替换整个 JS 数据库镜像。磁盘引擎缺失/文件坏时明确失败，禁止回退内存或创建空库报健康。

`init --confirm` 才迁移 v1：核对 root/schema/private file，持有 SQLite 事务及旧 writer lock，保全独占备份，再事务升级；旧 writer 在下次加载时拒绝 v2。活的、身份不明的旧 collector 不被抢占。迁移或旧文件锁恢复只在明确 PID 已不存在并且锁文件身份未变时进行；不存在“锁太旧就删掉”。跨平台不能证明 PID 身份时保持 recovery-required。

新的 collector 所有权记录使用 PID、启动身份和 boot 身份摘要；并发启动被数据库事务拒绝。正常退出释放；硬崩溃后显式 run 可在证实旧进程已退出后建立新 collector epoch，恢复 SQLite 自身事务。旧 callback/cursor 不得继续写新代。初始化先私有 staging 再独占发布，失败不留下一个被误当成有效库的空文件。

采集 cursor、证据、incident 和通知决定同一事务提交。提交后回执丢失为 unknown；相同 source cursor/batch 或 management request 的重试会对账，不重复开事故。数据库迁移与 collector 更替会使不适用的旧分页 cursor 失效；不会在普通 GET 中进行隐式迁移或恢复写。

## 长期运行与维护

没有累计16MiB/50000事件后拒绝新观察的旧限额。保留期限与数量目标用于自动维护和压力披露，不是服务寿命：

- journal cursor 每批有界前进；半行不确认，轮转、改写、坏 UTF-8、超长行和截断明确报告。
- ownership RPC 按独立退避时钟采样；本地 journal 追赶每次让出执行时间，不把积压变成高频 Server 轮询。
- collector 周期执行小批 retention 和增量空闲页回收；不等待一次全库重写。
- 活跃条件、ack/snooze/management request 不能仅为达到数量目标而删除；历史高频证据可以过期，查询披露 retention floor。已管理的 occurrence 保留受限诊断摘要，不需要永久保存 Alert 对象或全文。
- DB/collector 退化不参与模型准入，不取消正常业务。观测缺口不能证明没有失败；Alert 消失也不能证明恢复。

## 资格边界

源码测试包含实际磁盘、Node 打包、旧库迁移/回滚、事务提交前后强制退出、cursor 原子性、超过旧限额、只读无 sidecar、事件冲突与乱序、共享父事故和独立通知周期。原生最小切片有独立 synthetic Host fixture 行为对照；它不等于现役私有 bundle 与 App 的资格证明。新源码/preload 必须走现有 profile/re-adopt 流程后才有现场覆盖，不能因构建或单测通过就声称已上线。
