# 原生 Bot 运维、故障证据与有界存储实施规格

**Accepted target · 2026-09-18 · 证据/本地容量护栏已部分实现，原生通知与整安装治理未完成。** [首个切片](../reports/2026-09-18-observation-evidence-first-slice.md)与[存储/调度增量](../reports/2026-09-18-observation-storage-followup.md)保存限定证明；不是现役已采用声明。当前施工主线是「发现异常 → 固定关键现场 → 给配置目标 Bot 发送简短告警、ID 和可用取证命令 → 默认只提醒」。长期终点是原生 Grok Bot 在用户任务或独立预授权范围内，自主完成排障、Bot 运维、模型管理和 grokbox 使用；不是另建 Agent loop，也不是把命令交回用户手工完成。**自动 Issue 已退出本阶段，默认不询问是否建单。**

本页是本专项唯一实施合同；[主 Spec](box-runtime-impl-spec.md#template-ops-automation)拥有总运行时/执行权，[配置 Spec](configuration-rebuild-spec.md)拥有配置 writer/迁移，[S13](box-runtime-impl-spec.md#ownership-continuity)拥有恢复快照/新身份连续性，[HSO](host-seam-ops-recognition.md)拥有来源与 profile 资格。新的 [OBS-00–06](../tickets/README.md#incident-evidence)补齐证据与存储；既有 T43–T56 的未实现运维票按本页收口，不重开已完成的 modeld 同号票。

[本轮决策](../decisions/2026-09-18-observable-native-bot-ops.md) · [施工索引](../tickets/README.md#template-ops-automation) · [操作入口](../maintainers/template-ops-automation.md) · [唯一 LIVE 索引](../tickets/LIVE-integration-validation.md)

<a id="scope"></a>
## 1. 用户结果、交付边界与非目标

### 1.1 三条独立行为链

| 入口 | 默认行为与授权 | 验收结果 |
|---|---|---|
| 自动异常通知 | 正常服务启用后本地观察/维护开启；目标独立配对并告知数据/成本。Bot只转述可信安全摘要、关联ID、取证命令，然后结束 | 用户有可用现场入口；没有自动诊断、维修、Issue询问、公开或持续催问 |
| 用户委托 | 用户明确要求排查、运维、换指定模型或使用grokbox；Bot按需加载Skill，自主选择工具、执行和核验，不逐条请求重复批准 | 实际操作回执与用户目标对应；新增中断、花费、数据去向或公开范围才需补充决定 |
| 独立预授权自动化 | 后续T47–T49在具体动作类、对象、期限、预算、原生能力和当前证据交集内执行 | 无越权副作用、未知结果先对账、控制程序核验而非Bot口头自证 |

默认brief-notice是一次任务的策略，不是通用Bot永久只读限制。收件Bot不必来自模板；一个Bot即可作为完整入口。专用`grokbox-ledger`模板侧重提醒/跟进，通用`grokbox`模板负责全部已有能力，两者共用Skill、证据和控制程序。

文档、代码或离线测试本身不授权创建Bot/Routine、改模型/生产配置、发Webhook、安装服务、重启Host/modeld、清理用户数据、提Issue或发布市场模板。实际操作仍需用户明确范围；现场切换与验收按LIVE索引进行。代码/配置存在、已配对、具备权限、已资格化、真实交付分别表示。

首发不以高级路由、自动诊断、自动维护、Issue或完整连续性恢复为前置。全链路可观测指关键边界可证且缺口可见，不承诺永久全量日志、精确恢复外部副作用、全类型上游告警或本机报告整盒断电。

<a id="baseline"></a>
## 2. 源码基线与实际缺口

下表是规划时基线`8139339`（前一实现基线`7d93399`之上增加S13规划），不再作为新切片的当前实现清单。新增代码/限定证明见本页首段报告与来源票；现役只看LIVE。继续实施前对照v2，已新增能力按证据吸收，不重复施工。

| 现有基础 | 当前局限 / 对应施工 |
|---|---|
| `commands/outcome.ts`的STEP离线incident，`outcome.ts`的共同投影 | STEP ID不是monitor incident ID；离线不读Gateway/transcript；coverage/lookup/retention接线不全；OBS-02 |
| journal多层流、SDK/schema/tool关系、HTTP/recovery/authority字段 | 容量/时序/工具释放不证明实际执行、checkpoint或App接收；OBS-00 |
| `host/run-observation.ts`和`host/alert-observation.ts` | 有队列failed与error tray事实；`monitor-occurrence.node.ts`并未将所有这类事实转incident，tray观察也不等于全通知类型；OBS-01 |
| `observability/observations.sqlite`中的evidence/incidents/events/cursors/management | 已有持续索引和规则派生；不是按需猜测，也不是所有故障的完整账本；OBS-01/04 |
| `monitor.runtime.ts`显式run、约1秒本地追日志与独立上游采样策略 | 依赖显式runRoot接线；已有循环中慢源可拖累本地处理；当前出口`local_only`，回调返回不是远端回执；T44/45/50 |
| context maintenance的operation/root/checkpoint回执 | 专项能力存在，不应说全无checkpoint；缺统一报告与事件关联；OBS-00/02 |
| journal保留选择器8MiB/128事故组/7天 | 作用于compact，不是append硬上限；scheduler/滚动与消费进度需闭合；OBS-04 |
| SQLite约7天/50,000 evidence软目标、增量删除/vacuum | 已管理/父子关联可长期pin明细，行数不是总磁盘上限；OBS-04 |
| `execution-history.node.ts`LevelDB、service incarnation退役 | 同代安全遗忘及跨重启maintenance未知记录退役未统一；compaction不删除有效业务状态；OBS-05 |
| Jobs256终态/24h、输出上限；Host bundles16/契约5代 | 数量不等于安装总字节；process日志追加、Trash、备份/孤儿与恢复引用需各owner治理；OBS-04/05 |
| config schema3、统一ConfigChange、ops目标偏好已实现 | support旧默认仍在schema；不能把保存成功当通知worker已运行；T51/54 |
| template pack/stage/publish/import已有，recipe routines为空 | Routine CRUD/配对/Webhook与只提醒模板尚待资格/实现；T43/46/53 |
| S13 / CONT-00–05 | 恢复快照和自动新身份接替是独立合同；8个原生隔离探针不等于完整恢复链已实现 |

源码入口均在[§9](#layout)。历史对话中的测试数量不当作本候选复验。当前安装/真实消息/回执的进度只写LIVE。

<a id="authority"></a>
## 3. 对象、权威与安全边界

| 对象 / writer | 定义与权限 |
|---|---|
| SourceFact / 原Host、modeld、controller、原生读取adapter | 原边界实际观察；不改变原执行控制流。至少有schema/source instance/sequence或明确缺失、发生与采集时间、可用scope/代次身份 |
| Incident / observation writer | 明确发生记录`occurrence`或持续条件`condition`。关联证据与版本化规则；不代表根因已证或执行授权 |
| Assessment / 纯classifier | 分离observed facts、规则推导、Bot推断。保存classifierVersion、basisRefs、修订；重分类不改原事实、不产生新发生周期 |
| EvidenceSnapshot / evidence writer | 不可变revision和manifest，固定选择范围、来源、质量、公开策略；不是执行账本，也不伪装原生恢复快照 |
| NotificationWork / outbox writer | 同incident发生周期/通知阶段的一次工作；携带冻结目标与证据引用；不批准诊断、模型切换或公开 |
| DiagnosisTask / 用户意图或独立策略 | 复用原生Bot执行体系；有对象/工具/成本/数据范围。Webhook不能自造用户意图 |
| MaintenancePlan / 唯一controller | 所有实际Host动作依原controller、当前grant、资格、排空屏障；观察DB不写activation |
| RetentionPlan / 对应存储owner | 回收权限按对象归属；普通GC不删执行安全状态或原生用户数据，不跨存储代替owner裁决 |

身份至少区分installation/scope、Agent、dispatch、TURN、STEP、native request、failure、tray、Host generation、service incarnation。缺身份可建立无STEP的incident，不能虚构STEP。关系只由原生显式字段/同调用上下文/已验证回执建立；每条edge标注basis。时间邻近、名字相同、文本相似只能用于候选检索，不能自动join或赋权。跨进程仅用同源序号和显式关系判断因果；单调时间只用于本进程期限，墙钟异常需显式处理。

凭据、Webhook地址、原始prompt/transcript/Memory、私有源码、工具参数/返回正文不进入默认观测流。自由文本/日志/模型输出是数据，不能决定命令、路径、收件目标、授权或severity。通知中的命令为受信registry生成的只读描述，不是执行许可。

同UID任意shell不是硬沙箱。目标绑定允许接收安全摘要，不默认赋予机器控制权限。自动诊断/维护若无法证明原生工具能力边界则blocked；只提醒可以采用固定安全正文、不授予本地执行能力，并如实披露目标自身能力与费用边界。

<a id="chain"></a>
## 4. 持续发现与主动触发主链

1. 原有writer在关键边界输出有界安全事件。观察队列/写入有背压与丢弃健康计数，不等待Bot；失败不能变成模型业务失败。执行安全持久化仍由原owner严格处理。
2. 服务owner从canonical运行清单定位scope、durableRoot/runRoot。目录事件仅唤醒，有界轮询兜底；共享上游读取保留准入优先和原始证据年龄。新Bot目标集合由已管理registry维护，新增/移除/漏覆盖可见，不要求用户永远手填静态名单。
3. 本地journal drain、上游采样、过期检查和GC为同宿主中各自有界子任务；不因慢所有权RPC阻塞本地错误发现。单SQLite事务writer串行，网络/模型不持写事务；不为每Bot、每UI或每token启动collector。
4. intake接受版本化已知错误、独立原生未知error、队列失败、无STEP拒绝、组件故障和观测自身gap。未支持schema保留安全形状/来源/计数及coverage告警，不原样保存未知payload，不静默discard后报健康。
5. `evidence + incident/revision + classification basis + 通知准备工作`同事务提交；游标与消费事实一致。跨journal/SQLite/blob/controller不宣称分布式事务，采用稳定eventRef、staging/manifest及恢复程序。只记录后进行通知，GET不造incident。
6. 通知准备worker先固定最小快照/关键证据，再将工作置为ready；不足也可产出partial并说明原因。不能无限等完整现场、正常工具收束或模型分析。昂贵补采另需权限；事故后查询到的当前状态与事发状态分栏。
7. 纯规则分类、聚合、选择目标与预算。确认的项目错误和真实但未分类异常可通知；不要求已证用户损失或先修复失败。明确纯上游/正常取消/预期配置拒绝默认本地归档；上游触发但本地收束/重试/展示错误仍通知本地缺陷。恢复了的真实bug不被抹除，severity与处置自主性独立。
8. 发送worker冻结binding、dataPolicy、schema、evidence revision和费用范围；网络事务外发送原生Webhook，保存真实边界回执。只有明确未接收才能按有限策略重试；unknown先对账。
9. Bot只提醒，保留ID/一条主取证命令与必要的一条补充，然后结束。不自动执行所附命令、读完整JSON、派Bot、询问Issue或循环催问。
10. 用户明确委托后，原生Bot以同incident继续取证、计划、获准操作和验收；使用原控制/模型/原生Routine owners。后续独立预授权工作不借默认通知扩大范围。

### 4.1 没有error也可能需要检测

维护有界open-execution索引：实际start、最后进度、等待原因、期限、cancel/terminal/交接。规则区别正常长任务、待人工审批、source失联、疑似停滞和已证违反收束契约；时间阈值只形成suspected，不伪造deadlock。closed task的迟到事件不复活它。身份或覆盖不足只报告observation gap。

OBS-01固定可执行初始规则集合及required source contract；没有证据证明自动化失败一定意味着完整用户任务失败。CONT-01的所有权变化是一个source adapter，复用此入口；原生执行门发现撤权仍立即独立保护，不等通知落盘。

### 4.2 延迟、预算与故障域

测量`occurred→observed→committed→snapshot-ready→attempted→native-accepted→report-observed`，每段缺失单独标记。健康、无积压的本地owned-fixture目标：事件追加至通知ready的p95≤5秒；不把它当远端SLA。所有权观察遵循自身采样周期，报告变化区间而非精确接管时刻。验证慢上游源、DB繁忙和本地突发的隔离。

普通自动唤醒沿用每安装滚动24h 2次、critical独立保留1次作为首发保守默认；首次配对告知，可显式调整。每周期一次，重复只计数，合并超额工作并显示suppressed/delayed，不能声称预算耗尽仍每条实时送达。无变化不产生周期性LLM摘要。whole Box离线只保留外部观察边界，不引入外部服务。

<a id="evidence"></a>
## 5. 证据合同、读取与数据视图

### 5.1 按故障类型定义最低证据，而非一个完整度百分比

| Requirement ID / 场景 | 最低可诊断事实 | 不能推论 |
|---|---|---|
| E01 执行关联 | 输入/dispatch/TURN/STEP/代次关系及basis，main/aux/subtask用途 | 同Bot/邻近时间不是同执行 |
| E02 制品与选择 | 事发loaded Host/preload/modeld/wire/adapter、捕获model/config revision；当前查询值另列 | 磁盘最新版本不代表事故使用它 |
| E03 Provider/SDK/stream | HTTP阶段/状态、有限schema路径与类型、工具/finish关系、retry/取消与限额 | 503不自动排除本地bug；输出长度不是执行成功 |
| E04 工具副作用 | generated→validated/released→native-started→returned→result-accepted，明确最后可证边界 | released或返回success不证明外部业务事务完成 |
| E05 上下文与提交 | operation/root revision、维护用途、append/checkpoint/读回/commit_unknown和后续阻断 | 专项checkpoint成功不证明所有工具/整回合完成 |
| E06 任务/Working | 父dispatch、子任务、队列、审批/等待、终结与显示层分别取证 | 父回合结束不代表子任务结束，native emit不代表App已渲染 |
| E07 告警生命周期 | decision/create/update/publish/remove/suppress及来源/捕获能力 | tray消失不代表恢复/已读；未知tray必须有incident入口 |
| E08 健康与存储 | writer/source/collector状态、采样窗口、保留/读取/版本缺口、实际存储压力 | 无事件不代表没失败；snapshot绿色不授权执行 |

OBS-00拥有逐场景字段清单、optional/required与来源覆盖矩阵；每字段只能称observed、derived或hypothesis。未接线和未检查分开；字段缺失状态固定为`not_instrumented/not_checked/not_observed_in_window/expired/truncated/redacted/unavailable/unsupported/not_applicable/conflicting`。正证据与缺口共存：已知失败不因其他来源缺失而消失，未知副作用不填零。

### 5.2 IncidentEvidence v1

在既有安全投影之上新增版本化manifest，不把`history outcome`完整输出当安全报告。manifest至少包含：

```text
schemaVersion, incidentId, occurrenceId, evidenceRevision, capturedAt,
sourceWindow, identities + relationEdges(basis), incidentTimeArtifacts,
currentObservations, facts[], assessments(classifierVersion,basisRefs),
coverageByRequirement/status/reason/sourceRefs, sections[],
viewPolicyVersion, redactionSummary, logicalBytes,
retention(tier,expiresAt,reservedUntil,evictedReasons), digest
```

默认一份有界JSON；可重用同一证据存储而不复制events/runtimeTrace/presentation多份正文。较大sections仅以manifest引用并可分页；不会因单个来源失败而整体丢报告。revision不可变；新增终结或补证生成revision，旧通知仍指向原revision。读取不会生成新快照、初始化DB、网络补采、GC或续租。

journal与monitor读取复用同一身份闭包与投影；eventRef/sourceSequence冲突显式展示，不按到达顺序覆盖。legacy关联保持legacy。必须接回已有coverage/lookup/retention/readFailure/writerHealth，不能把null当完整。源不在保留窗口也返回可用summary和gap。

<a id="privacy"></a>
### 5.3 源头最小化与分层视图

| 视图 | 可以带什么 | 禁止/条件 |
|---|---|---|
| local-diagnostic | 必要真实ID、已登记契约名、结构/关系、受限路径引用 | 默认无prompt/Memory/工具正文/secret；不是全盘dump |
| bot-notice | 最小现象、时间/范围、incident与所需Agent/STEP/tray、取证命令、保留/缺口 | 精确ID只向明确绑定目标披露；无完整JSON、地址、自由错误正文或任意执行指令 |
| bot-diagnostic | 受托或已授权后按dataPolicy领取必要结构化证据 | 供应商/工具权限/用途复核；不能先发原文再让Bot脱敏 |
| public-summary | 已审核公开软件事实、契约枚举、计数和报告内一致别名 | 仅用户主动导出/决定公开；不发真实账户/机器/业务身份、自由文本/正文/原始hash |

内置公开工具名及字段可用版本化catalog白名单，如`SendToAgent`/`target_id`；用户自定义工具/字段不是天然安全。参数值改为类型/缺失/长度范围/关系。ID在报告内一致映射为agent-1/step-1，跨报告默认不使用稳定用户标识；同报告修订保留映射。输入低熵时普通hash可被枚举，不作为匿名化保证；去重优先采用公开错误码/契约/阶段，不对用户正文造公开签名。

Raw-sensitive采集默认关闭，只有明确用途/对象/字节/期限授权才可临时读取；其bytes不进入默认journal、Bot或公共报告，不为模型语义bug伪造无正文复现。redactionSummary只记字段类别/原因/计数，不回显被删内容。安全投影拒绝未知字段、访问器、原型污染、深/大数组及任意Markdown链接；秘密不进入错误cause、publisher stderr或审计日志。

同一诊断逻辑换正文/凭据/真实身份，公共结构性结果应保持不变；脱敏后仍能判断工具匹配/失败阶段/副作用边界。LLM推断必须带evidence refs且标hypothesis，不能生成授权、替代缺失事实或把自由文本直接通过公共投影。TTL/压缩不等于安全擦除；默认从源头不收秘密。

<a id="payload"></a>
### 5.4 通知载荷与原生资格

`NotificationEnvelope v1`是grokbox内部合同，不是已验证上游API DTO。最大8KiB，包含workId/deliveryId/routeDecisionId、incident/occurrence/evidenceRevision、target/bindingRevision、intent=`brief-notice`、createdAt/expiresAt、safeSummary、scope描述与取证命令描述。命令保存`commandId + validated arguments + requires=box-local + readOnly=true`，展示时按可信registry安全引用；自由文本不能指定shell/URL/root。主命令一条、必要补充一条。

默认正文已经足以提醒，不要求接收Bot先读完整JSON。至少128-bit随机delivery reference仅为引用，不是执行bearer。若原生支持受信claim，则只领取已授权安全摘要并去重；不能用自报agentId证明身份。无可信caller能力时采用已固定最小载荷，不能据此开放诊断或维护。

T43验证实际routine create/read/disable、认证、payload编码/大小、原生运行关联、导入隔离与接受边界。只使用受保护secretRef和经资格化的原生endpoint；不猜HMAC/重试/幂等，不借其他产品Webhook合同。目标不可用不强修Host、不自动创建Bot、不广播；发给不同供应商是新的数据去向。

<a id="support-issue"></a>
### 5.5 默认只提醒，Issue是用户任务支路

默认Bot告知异常和现场入口后结束，不调用取证、不自动分析、不给Issue选择题、不等待用户回答。用户随后要求排障时进入T47，不把历史通知当新授权；用户要求整理/公开Issue时才进入后续支持流程。诊断可自主推进，公开动作仍单独按确切目标/内容/作者范围确认。

<a id="issue-automation"></a>
### 5.6 延期的支持发布范围

T52/T56状态为Deferred，不属于首发依赖。未来用户决定提单时，只复用已有可用`gh`身份；没有gh/有效认证/目标权限则本地保存并跳过，不安装、不登录、不提取token、不切账号、不建设GitHub App/接收服务，不自动追补历史。

若实施，唯一GhIssuePublisher负责版本能力探测、运行环境中的实际host/作者核对、固定repo、stdin正文、无交互/无HTTP调试日志、实际结果回读。不能仅以`auth status`退出码或最新参数推断旧版本登录状态。unknown创建先对账，不能换工具重复提交。无自动Issue、有限发布grant、自动附件/评论/关闭；今后扩大范围需新的明确决策，不从旧ADR恢复。

<a id="policy"></a>
## 6. 目标、配置与自主性

<a id="capability-tiers"></a>
### 6.1 权限与成本不是一个开关

notify、diagnose、model-change、Host-maintain、continuity-replace、public-publish是不同能力。severity、maintainer preset、绑定Bot或廉价模型不能扩大权限。默认诊断on-request、维护off；用户任务按任务范围授权，不逐条询问只读工具。额外模型探针、跨供应商、共享Host中断或公开需补充决定。

确定性采样/分类/GC零模型调用；原生Webhook唤醒可能收费，本地请求预算不冒充原生token硬上限。自动任务有安装/真实native Bot/incident阶段共同预算，多alias不放大；用户交互任务预算与自动首醒分开。诊断首版自动策略待单独启用：最多2轮×8个只读操作、120s；受托任务由用户目标和批准预算确定，不拿自动首醒限制把正常工作做残缺。

<a id="configuration"></a>
### 6.2 唯一配置与目标schema切换

本基线config3已实现，不修改当前生产文件。本专项采用**下一次不兼容配置版本**新增顶级`storage`、收口`ops`旧support意图；具体版本号在T51实现时与当时最新schema单次分配，不并行抢占固定数字。源码reader/writer严格拒绝未知版本，迁移必须复用现有ConfigChange/CAS/备份/alias程序，不双读双写。

目标字段（下列为叶级合同，不是可直接apply到当前CLI的完整JSON）：

| 路径 | 默认 / 作用 |
|---|---|
| ops.enabled / monitor.enabled | true；控制专项新观察/自动工作，GET不装服务 |
| ops.notifications.mode / channel | actionable-user / bot-webhook；off关闭新投递，不关存储维护 |
| ops.notifications.maxAutomaticWakeupsPerDay / criticalReservePerDay | 2 / 1；滚动24h，重试和可能唤醒计入 |
| ops.diagnostics.mode / maintenance.mode | on-request / off；自动能力另有grant/资格，不由字段自授 |
| ops.targets / routing.defaultTarget | 一个default或用户指定别名；显式Agent/Routine偏好与私有binding分开 |
| ops.routing.enabled | false；未开规则也向default投递，不表示通知关闭 |
| storage.policyRevision | 1；与ops开关无关，服务存续期间必要GC继续 |
| storage.diagnostics.targetBytes / maxBytes / reserveBytes | 256MiB / 512MiB / 64MiB，reserve包含在max内；§8拥有语义 |
| storage.diagnostics.detailDays / summaryDays | 7 / 30；受容量上限约束，不是无限流量保留SLA |
| storage.retention各类别覆盖 | 仅已登记类别、TTL/数量/字节合法值；不能把safety-store按日志TTL配置 |

旧`ops.support`发布/offer意图显式退役；迁移预览记录其停用，不转成通知配对、执行grant或恢复旧积压。旧off/显式预算/目标数据选择保持；移除字段和改变preset不自动提高成本。已存在配置损坏时外发fail closed，不重建默认来复活能力。config/model/user数据无关修改不失效捕获中的执行选择；各consumer独立domain revision。

`storage`顶级放置是跨诊断/执行/制品owner的共同预算入口，不是第二执行账本。偏好仍归统一config；实测bytes、pin、GC游标、储存保留租约归机器状态。支持范围变化时显示requested/effective/valueSource/blockedReason，不假称保存配置即已常驻。

<a id="bot-routing"></a>
### 6.3 默认一个目标，高级分流后置

复用`ops.targets`与`routing.defaultTarget`。targets bind核对installation/scope、exact agent/routine/revision、secretRef、实际模型/数据/工具能力与费用，写受保护`state/ops-bindings.json`；不改模型/persona/其他Routine。当前没有可用目标时local-only/blocked-unpaired可见，不猜最近Bot。模型仍归models/native selection owner。

高级路由T54/T55在后续开放：枚举字段AND/字段数组OR，有序首匹配，最多8目标/32规则/每规则2备用；未命中default，不广播。route decision不可变；禁用/改绑定只阻止未发工作，已attempted先对账。未知字段/重复规则/引用不存在/循环拒绝。fallback只在确定未接收/未开始处理时使用，unknown不扇出。模型供应商/数据级别改变重新配对，不能为了通知可达自动换模。

<a id="receiver-resilience"></a>
### 6.4 状态、重试与故障隔离

```text
work: preparing → ready → completed | expired | superseded | blocked
attempt: reserved → attempting → native-accepted | definitely-not-accepted | unknown
bot-report: not-observed → observed | unknown
incident: occurrence=recorded; condition=open/resolved; ack/snooze独立
```

发送前短事务预留attempt/费用；网络在事务外；进程在attempting崩溃先unknown。原生接受不证明Bot完成或用户已读，报告必须以相关原生发送回执证明，无App证据则not_observed。默认不自动重投unknown；显式允许重复提醒也必须独立预算，不能重放诊断/维护。定界重试只处理明确未接收，30s/120s退避、最多3次且服从总额度。

通知TTL默认15分钟，未配对/长期不可达不无限排队。恢复后只从仍有效incident形成一次合并摘要，不逐条重放旧告警；新work必须保存supersedes/旧投递不确定性并继续受发生周期限制。同库保留有限dedupe tombstone与source replay floor，不能靠换ID绕過。发布器自身失败形成本地健康状态，禁止告警→通知错误→告警的无限递归。

自定义模型Bot可能依赖故障中的modeld/provider；官方模型也可能共用Host/Box。默认只有一个primary，不承诺跨故障域高可用。后续跨Bot诊断交接至多一层，经本地策略验证，用结构化结论和evidence refs，不转发整段对话；默认首醒禁止自行升级。

<a id="configuration-operations"></a>
### 6.5 变更、撤销与重入

完整私有backup不能自动复活binding/grant/claim；恢复后核对installation/主体并暂停新副作用，保留旧结果对账。解绑不删除用户原生Routine，停通知不取消业务任务，关闭ops不卸载Host补丁。新增供应商、数据范围、预算、备用和集中报告均需变更预览。

自动维护grant由专用受信owner写`state/ops-grants.json`，config不签署。延迟用户请求复用同incident但创建新task identity；不能从Bot转述、Webhook approve或日志中的命令生成授权。

<a id="execution"></a>
## 7. 自主处理与唯一维护控制程序

T47交付原生Bot「读证据→判断→用户范围内操作→核验」旅程，复用既有doctor/status/models/agents/context命令。正常模型切换检查明确目标、模型资格、保存与下一TURN采用，既有TURN不热换；已存在的能力不重写成ops专用实现。缺证时说明unknown并有界补证，不凭绿色摘要重试历史STEP。

自动Host维护由T48/T49单独实施。动作类保持`observe-reconcile`、`realign-qualified-generation`、`derive-equivalent-profile`、`exit-patch-at-safe-boundary`，逐类资格化。新SHA只有已审核recipe、全部生效切片及依赖闭包、companion、ordered apply/transformed SHA均合格才可派生；锚点不变但语义变的负例必须拒绝。LLM不能签资格。

不可变plan绑定对象/scope、实际installed/loaded组合、动作/影响、qualification/policy revision、到期、预算、回退及expected config。profile唯一publisher与adopt分开；原controller是唯一signals/spawn writer，reconcile不获得变更权。所有操作入口共享最后执行门，不能只在CLI预检。

Host切换须有原生admission fence/排空能力，并复核父回合、原生监听子任务、审批、工具、流、compact和未决操作。一次idle采样不排除竞态；unknown/缺页/未具备屏障拒绝自动中断。提出计划的Bot先持久交接并结束，调度者不把它从busy清单排除；不让它等待自己的Host重启。

默认一安装一在途Host动作、每小时最多一次；plan TTL15min、安全点等待≤10min、动作预算按资格类冻结。超时、取消、换代先恢复operation事实，不重复signal/spawn；实际loaded/readback及功能回执才算verified。不得自动清circuit、修改官方updater/Server harness、执行留存源码或删除原生数据。

S13连续性替换继续由CONT owner判断允许模式、原生快照完整性和新身份写入，不能从普通diagnostic JSON推导resume。接管通知不等于替换许可。

<a id="storage"></a>
## 8. 有界存储：轮转、分层保留与安全GC

### 8.1 三个互不混同的容量域

诊断池：grokbox自动生成的日志/journal/观测SQLite含索引与辅助文件/事故证据/通知状态/管理导出/维护暂存，目标256MiB、硬接纳预算512MiB、其中64MiB保留给元数据和回收暂存。所有安装共用，不按Bot/进程倍增；同物理文件只计一次，软链接不得跨root重复统计或逃逸。默认不保存完整业务正文。

安全状态池：STEP/TURN/context maintenance/controller及CONT恢复manifest等由各执行owner治理，不能挤进诊断池后按TTL删。显示实际bytes、可回收/受保护及阻断原因；不能用无限保护代替安全退役设计，也不能因累计请求数设置业务寿命上限。

制品/用户数据：当前运行/必要回退制品单独预算；用户主动export、原生会话/Memory、共享项目文件不由观测GC管理。CONT私有恢复blob按S13自己的有界manifest策略计量，不复制进Bot通知或诊断报告。

### 8.2 保留类别与唯一策略owner

| 类别 | 机制 / 初值 | 安全约束 |
|---|---|---|
| process/debug日志 | writer-owned分段，单段4MiB、总32MiB、最长72h | 关闭段才压缩；压缩临时空间计入；禁止copytruncate作为无损方案，不依赖systemd/logrotate常驻假设 |
| 结构化journal | 8MiB段、总128MiB、最长72h，age/count/bytes先到者生效 | 新段发布/消费cursor按segment identity，不靠rename猜接续；关键事故先固化；积压超预算允许丢旧段但必须记gap |
| 观测DB普通历史 | 默认7d并受全池约束；按状态变化而非每次相同采样追加 | current/latest与历史分开；逐表索引/游标/source health都有退役策略，不能只清evidence |
| incident明细/摘要 | detail7d、summary30d；同发生周期首个/最近/重要变化样本＋计数 | ack/snooze/open不永久pin全部明细；保留事故摘要不表示原始证据仍在 |
| 通知载荷/回执 | queued15min；终态摘要14d；dedupe至少30d且覆盖可接受重投/恢复窗口 | unknown载荷可缩成禁止盲重投标记，不凭时间改成未发送；先拒绝过期请求/旧source replay，再退役tombstone |
| 自动导出/孤儿临时文件 | 完成即释放；孤儿24h宽限且检查owner/lease/operation | 不按mtime删活动文件、未提交manifest或用户指定输出；GET不延长保留 |
| Jobs | 复用已存在的单任务输出限制/256终态/24h，新增总字节治理 | 先提取需引用的关键诊断，不截断正在消费的控制协议；业务产物不是日志 |
| 制品/自动备份/Trash | 原owner按引用＋数量＋字节GC | 保护running、明确fallback、未完迁移；Trash仍计bytes，只清自己的对象，不清全局回收站 |
| 执行历史/恢复快照 | OBS-05的语义退役＋原存储compaction | 详见8.5；禁止删除旧ID后当新请求执行 |

具体物理预算由storage adapter统一核算：byte quota不是SQL行数；SQLite空闲页/rollback journal或未来WAL、LevelDB临时compaction、压缩临时文件和新段预留均入账。target为平时回收水位，max为新诊断数据接纳边界；迁移前已有超额只降级和分批回收，不暴力删受保护资料来伪造合规。

### 8.3 故障证据保全与租约

先安全project→staging→校验可读blob闭包→提交manifest引用→通知ready。跨文件/DB间隙有recovery；published manifest不得指向半文件。按opaque blob ref共享明细，不为每事件/每Bot/每view复制JSON；导出view按需流式生成。

明细→核心→摘要→退役，各层有expiresAt与原因。长期未解决只保留有界摘要/代表样本，不无限积累。用户或受托诊断显式申请evidence lease，默认30min、累计上限24h，必须预留bytes才声明reservedUntil；任务结束释放，硬崩按租约到期回收。更长保留需用户明确export或提高预算，Bot不能自续无限pin。普通read不写租约。

lease只保护快照一致性/承诺范围，不影响执行权限。不足空间拒绝新pin/大采集并返回summary，不把expiring引用承诺成永远可读；已发送通知显示证据tier/有效期/缺口。回收后的查询返回expired/summary-only，不返回无故障空成功。

### 8.4 调度、背压与物理回收

统一StorageMaintenance port组合各owner计划；实现中不是任意path删除器。小批扫描有游标，单tick最多1000对象或50ms计划预算；DB实际commit/不可中断IO必须结算，不能把50ms说成物理完成硬限。普通GC独立于通知/ops.enabled，由服务宿主Scope持续管理，单writer避免重入；无模型、无全盘扫描、无每query vacuum。

超过target先清孤儿/过期普通日志，再合并重复记录、降级事故明细；max前为新写预留最坏临时字节。无法预留则拒绝非必要诊断write并更新固定容量健康槽，保证Host正常执行不等观察库。观察自身故障不递归制造无界告警；健康槽也写不下时如实degraded。安全账本真实写失败仍须拒绝其不能安全记录的新副作用。

日志轮转必须考虑已打开fd：原process.log子进程持有fd时，仅rename不能切写入。T50/OBS-04选择受管有界stdio sink，由其own writer切段；默认Host raw stdio忽略策略不为了可观测而改成全量收集。长行/慢sink/断管不造成无界内存，诊断流允许有计数的丢弃；Job/协议输出不能混同普通stderr丢弃。

SQLite用对应模式的增量清理/回收，迁移库也验证真实auto_vacuum设置。统计logical/live/free/file/auxiliary bytes，测实际文件回落，不以DELETE行数证明释放磁盘。重型重建要预留空间/另获维护窗口，满盘不盲全量VACUUM。LevelDB compaction由原owner在可接受时机执行，不直接删SST/LOCK。

时间TTL有持久单调下界/墙钟异常检测：回拨不使旧通知/grant重新有效，大幅前跳不批量误删承诺中证据。活跃引用、同scope/代、canonical root、inode/符号链接检查和原子manifest更新均有反例。失效的保留策略/删除不确定性输出plan/result/gap，而不是悄悄修复源状态。

### 8.5 安全遗忘：先让旧请求失效，再回收记录

OBS-05逐owner制定retirement certificate：关闭TURN/operation、旧epoch或会话代不可再接纳、所有迟到请求/恢复入口执行相同拒绝门。可将大量STEP结果收成有限终结/禁止重放标记；只有更高层失效条件覆盖全部旧ID后才能删标记。任意旧ID可无限重投的协议无法同时无限安全去重和常量空间，必须先升级身份有效期/代际准入，不以TTL掩盖。

`commit_unknown`不因时间过去变成failed/safe-to-retry；可以压成小型阻断记录，但解除需要真实原生对账或明确新协议。CONT当前/上一完整manifest、可达blob、未完迁移、原controller plan/grant各有owner roots；诊断GC不得删其恢复依赖。恢复快照的容量不足要停止新增保护并告警，不损坏原Bot checkpoint。

发布体积控制测试同时覆盖长期正常流量、重复错误、高基数独立故障、无限未答通知、ack/snooze、读者pin、重启重放、GC中断/满盘/只读目录。正常与故障负载经多轮维护应进入有界平台期，不仅证明一次删掉几行。

<a id="layout"></a>
## 9. 实施骨架、ports与依赖方向

下列新增路径是施工位置，不是功能已存在声明。保留现有三个workspace/npm边界；按当前Effect pin使用Service/Scope，不顺带换版本。纯分类/投影仍是无IO TypeScript，Host/preload不得import Effect/SQLite/CLI/Webhook/策略文件。

```text
packages/runtime-kernel/src/
  observation.ts                         # OBS窄DTO/投影/用例出口
  ops.ts / routines.ts                   # 通知/任务、通用原生Routine出口
  ports.ts                               # 仅增加下列窄能力；不提供全库SQL/任意shell
  internal/observation/
    evidence-contract.ts                 # E01–08、版本/缺口/关联闭包
    incident-rules.ts                     # 发生周期、纯上游/未知、停滞规则
    evidence-views.ts                     # local/bot/public安全投影
    retention-policy.ts                  # 统一类别/预算/降级/retirement要求
  internal/commands/
    incident-evidence.ts                 # read/capture/lease：分别是查询/显式写入
    ops-notification.ts                  # prepare/reserve/deliver/reconcile/claim
    agent-routines.ts                    # 同一原生CRUD/provision程序
    controller-operation.ts              # 唯一Host变更，后续扩授权provenance
  internal/ops/
    policy.ts / routing.ts               # 单目标规则先行，grants/预算由独立owner
    qualification.ts                     # 后续T48全切片/依赖资格
packages/box-runtime/src/internal/
  host/*observation*.ts / context-*.ts    # 只增加真实边界安全事实，原生仍执行
  io/
    monitor-store.node.ts                # 同一SQLite迁移与短事务；拆内聚子文件不换owner
    incident-evidence.node.ts            # manifest/blob/租约、只读来源组合
    observation-retention.node.ts        # journal/DB/blob/孤儿与容量计量
    monitor-storage.node.ts              # 每writer的SQLite文件护栏、辅助文件计量；非全安装预算
    bounded-process-log.node.ts          # 受管stdio限流与换段
    execution-history.node.ts            # 原安全账本owner的退役/compaction
    ops-bindings.node.ts / ops-grants.node.ts
    native-notification.node.ts          # 固定绑定的native Webhook adapter
  ops/host-seam/watch.ts                  # HSO只读来源adapter，不创建第二collector
  roots/
    monitor.runtime.ts                   # source/drain/detect/notification有界子Scope
    storage-maintenance.runtime.ts       # 服务内维护组合，不新建daemon/Agent loop
    ops.runtime.ts                       # 后续计划调度，只调用原controller
packages/cli/src/
  commands/monitor.ts / outcome.ts        # 原命令与新manifest入口均为薄适配
  commands/ops.ts / commands/routines.ts  # 能力实现后才注册公开命令
  gateway-automation.ts / agent-routines.node.ts
  template-recipe.ts / skills.ts          # 实现后注册主题/蓝图
skills/grokbox/ops.md                     # 提醒接收与受托任务分开；后续实现时打包
scripts/templates/grokbox-ledger.recipe.json # 无身份/secret/活routine的独立模板
```

| Port | 程序调用者与adapter | 明确禁止 |
|---|---|---|
| ObservationSource | collector；原journal/ownership/HSO/CONT安全事实adapter | 发模型、变更原生归属、把读取当原子权限租约 |
| IncidentStore | intake事务writer、只读查询；原SQLite | collector签grant、查询建库/恢复/GC |
| EvidenceStore / EvidenceRead | capture/lease用例；manifest/有界原reader | 随意文件路径、跨盒本地join、越权raw内容 |
| NotificationState / NotificationTransport | notification程序；原库＋fixed native endpoint | 通用HTTP、模型/工具重试、未知时换目标广播 |
| StorageMaintenance | 服务维护组合；各存储owner | 通用递归rm、删除执行库文件、GET触发清理 |
| AgentRoutines | 通用command；CLI native adapter装配 | kernel/box-runtime import CLI、复制原生scheduler |
| ControlResources | 唯一controller；既有真实控制adapter | notification/LLM直接signal、第二reconciler |

同库不等于同权限：incident、outbox、lease、management分别暴露所需事务方法，不把db handle传给Bot。跨blob/DB采用恢复协议，网络事务外。源捕获/真实上游读/脱敏投影/公开输出分别拥有校验，不能因可序列化JSON而略过。

<a id="surface"></a>
## 10. 公开命令与模板旅程

现有可用命令保留：`runtime incident <step-id> --agent <id> [--from journal|monitor]`、`alerts trace <tray-id>`、`history outcome`、`runtime monitor snapshot/events/incidents`。前者始终是STEP，不把monitor incident ID塞入这个位置。新增`monitor incident/capture/evidence lease`已经完成本地及Node制品切片；`runtime storage status`当前仅报告monitor数据库，显式`installationBudgetEnforced=false`。它们不意味着全局shim已采用或真实Bot投递已完成。

以下为**目标命令面**；已实现子集以本节上段、来源票与实际help为准。主通知只引用当时installed CLI支持的命令；未实现不进入真实Skill或README使用示例：

```text
grokbox runtime monitor incident <incident-id> --evidence-revision <n> --json
  # 主要取证：读固定manifest和有界证据；无网络/写入/续租
grokbox runtime monitor capture (--incident <id> | --step <id> --agent <id> | --tray <id>) --confirm --json
  # 显式本地快照写入，不自动远端补采；额外来源需单独权限
grokbox runtime monitor evidence lease <incident-id> --revision <n> --duration-ms <n> --confirm
  # 预留空间和限时保护；与普通read分开
grokbox runtime storage status --json
  # 类别bytes/有效策略/pressure/保护原因/最近GC/gaps，只读
grokbox runtime storage plan --json
grokbox runtime storage apply <plan-id> --expect-digest <sha> --confirm
  # 与定时维护共用owner；不提供任意路径参数
grokbox ops status
grokbox ops targets list|show|bind|disable|unbind|verify
  # bind核对精确身份与数据/成本；verify不隐式POST
grokbox ops claim <delivery-id>
  # 只在有资格的caller通道开放安全摘要，不是命令执行授权
```

事件通知不依赖capture命令被用户调用；collector已经固定现场。无STEP/source不可用时仍生成可读incident/summary/gap。`runtime monitor incident`取代此前拟定但未实现的`ops issue prepare`作为通用取证入口，不为没有Issue需求的用户引入发布概念。

<a id="agent-routines"></a>
### 10.1 通用原生Routine管理

T43冻结真实原生接口映射，T53实现`agents routines list/show/apply/enable/disable/delete/invoke/outcome`，`agents create/update --routines-from`、独立apply与模板配对复用一条程序。默认disabled，Webhook不附带周期schedule；未知原生trigger只读、不猜格式。省略已有Routine不表示删除。

Agent成功而Routine失败保留exact Agent ID、operation/阶段与partial/unknown，不删掉重建；原生无CAS/幂等时前后读回只证明所见，不能伪称挡住App writer。参数/能力预检尽量发生在创建前。invoke为单独授权的真实native Webhook POST，不退化成sendPrompt；超时先对账，不重复create/invoke。

模板保留小型能力加载桩。`grokbox-ledger`不携带真实ID/secret/endpoint/历史/grant，不把生产任务克隆进市场。原生模板无法证明disabled/endpoint隔离时只分发bootstrap说明，配对时经T53创建独立Routine。通用Bot受托后可用全套既有能力，不能在persona永久写“只提醒”。

<a id="routine-e2e"></a>
### 10.2 两条不同的用户验收旅程

N（首发）：装包/服务→单目标配对→真实异常→固定现场→真实Webhook→Bot只提醒→用户随后取得相同revision；无诊断、GitHub、维护、反复催问。包含关闭通知而GC继续、轮转后summary/gap、目标不可达和unknown。

A（后续自主）：用户在原生Bot明确要求排障或换指定模型→按需Skill→读证据与当前状态→执行授权范围内操作→核验保存/下一TURN采用/功能结果→报告。测试普通只读步骤不反复审批，也测试用户只要求排查时不偷偷重启Host/公开现场。

Routine E2E仍须经过发布Node CLI：disabled create→readback→enable→合成真实POST/run/报告→update→新POST验证版本→disable→只清理本次拥有且任务/子任务结束的资源。两份模板endpoint/secret隔离；HTTP接受不等于用户已读。测试对象/费用/清理独立授权，fixture不替代真实原生旅程。

<a id="tickets"></a>
## 11. 里程碑、票据与证明

| 里程碑 | 主票 | 出口 |
|---|---|---|
| M0 合同与切换设计 | OBS-00、T51；T43/T54并行 | E01–08/字段与身份矩阵、严格配置迁移、存储类别和单目标合同；不能只添加JSON字段 |
| M1 可发现且可取证 | OBS-01/02/03；T44；T53复用T43 | 未知/无STEP/停滞不漏入口，固定manifest、三类视图、同源CLI；只读失败可诊断 |
| M2 有界长期存储 | OBS-04/05；T50服务组合 | journal/SQLite/临时/安全状态及引用退役，steady-state容量/GC崩溃证明；不靠重启清历史 |
| M3 单目标默认提醒 | T45/T46；T54最小配对 | 持久outbox、native Webhook、目标模型/数据边界、只提醒模板、README真实说明 |
| M4 首发整体验收 | OBS-06、T50 | source/packed/真实SQLite/受控原生/独立review逐项；现场状态只归LIVE |
| 独立后续A | T47/T55 | 受托自主排障/模型管理与可选高级分流，不改变首醒默认 |
| 独立后续M | T48/T49、CONT各自合同 | 原生安全屏障内的预授权维护/恢复；不阻塞通知首发 |
| Deferred U | T52/T56 | 用户决定后的gh-only支持，不自动发布，不进入首发DAG |

依赖有向无环：OBS-00→OBS-01→OBS-02；OBS-03基于OBS-00可并行定义投影、与OBS-02共同接线；OBS-04基于OBS-00/02与T51合同，OBS-05独立基于现有执行owners及OBS-00，不依赖Bot上线。T43→T53；T51+T43合同→T54；T44与OBS-01接线；T45基于OBS-02/03+T54/T43，fake transport可先行，T46集成T45/T53。OBS-06聚合首发；T50拥有服务/发布与LIVE资格。M2是完整首发门，不要求停止M3的离线并行。T47不反向成为T45依赖。

所有票分清现有回归和待新增测试；测试目标文件落地后才注册verifier。默认CI仅public owned-fixtures/临时真实DB与HTTP/受控子进程，不借私有源码/账号/模型。native-copy只能签原生隔离范围，真实部署/费用/原App另取证。冻结candidate commit/依赖与source digest，独立复核不能用实现者自述替代。

README中英文应在功能可用后醒目说明：默认本地保全及已配对目标告警、默认Bot只提醒、不自动Issue、不发送正文/secret、原生唤醒可能收费、关闭命令和保留边界。本轮只能标接受设计/未实现，不谎称已默认启用。回归验证用户任务自主能力没有被模板的提醒策略禁掉。

新增LIVE维度为证据闭环、容量稳态/物理回收、安全退役；使用现有ROUTINES/RECEIVERS/OBSERVER-LIFETIME/MAINTENANCE条目记录对应范围，ISSUE条目标Deferred而非待立即验收。CONT引用共用行，不复制当前状态。

## 12. 失效与交接规则

变更原生事件/routine/模板复制/调用身份、Host/SDK/wire、字段/分类器/关系算法、脱敏catalog、存储布局/GC/时钟/预算/retirement、目标供应商或授权来源时，复核受影响requirement与对应ticket测试，不沿用旧绿灯。轮转成功不证明事故完整，GC少行不证明空间回收，空trays不证明健康，配置保存不证明常驻，投递accepted不证明Bot完成，Bot说修好不证明业务恢复。

[2026-09-16](../decisions/2026-09-16-template-ops-automation.md)和[9月17日](../decisions/2026-09-17-ops-defaults-support-and-routines.md)决策仅保留历史理由；其默认Issue询问、内置REST/发布grant路径不再是当前实施合同。当前范围由本页、[本轮ADR](../decisions/2026-09-18-observable-native-bot-ops.md)和来源票一致表达。实现前重读最新v2，与CONT/CTX/配置并行改动对齐；不自动合分支、采用live或公开发布。
