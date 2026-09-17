# LIVE — 现场集成验收唯一索引

**长期保持 open；逐项验收，不整票关闭。** 本页唯一维护各维度的现场验证进度、剩余缺口、阻断、下一步和证据入口。只看本页即可判断还缺什么；执行时再打开对应合同、操作手册或历史回执。

默认集成线：**`feat/box-runtime-v2`**。索引整理基线为 `6c94b8b`，最近完成的现场证据仍为 **2026-09-17 的 W17 窗口**。CTX 后续源码/离线资格已推进，但尚未执行新的现场切换；其具体前置与剩余门见 CTX 三行。表中“已证”只对所列制品、对象和窗口成立，不是实时健康声明。

## 阅读与维护边界

| 信息 | 唯一维护位置 |
|---|---|
| 当前各维度已验/未验、阻断、下一步、回执索引 | **本页下方总表**；其他文档回链对应稳定 ID，不复制当前状态表 |
| 功能语义、成功/失败判据、实现、离线测试、独立 review | 来源 Spec/Ticket；本页只摘录阻断及责任链接，不把未实现代码或 review 改称 live 待办 |
| 具体命令、前置检查、授权/预算、停止与恢复方法 | 对应 maintainer runbook；共用流程见 [release runbook](../maintainers/release.md#live-window-procedure) |
| 某次运行的固定制品、源提交映射、逐用例证据、影响和清理 | 日期化 report；本页登记窗口链接，report 不维护后续当前进度 |

**现场进度与验收状态分开。** “部分已证”不等于全部 `passed`；“本条范围内已证、review 阻断”也不等于还要重做迁移。`blocked` 的具体原因在最后一列，不让一个状态词遮住实际缺口。A/B 仅指 [W17-A / W17-B 制品](#window-20260917)，不是 Provider 或模型编号。A 的结果不能写成 B 上重新运行过；涉及 B 的对应能力仍须核对覆盖关系。

## 当前验收总表

覆盖原有 23 个稳定条目，以及本轮从既有 T24–T41/Provider 合同补入的 6 个未闭合维度。原有 ID 与锚点保留；新增行是需求归档，不代表本次执行、重新开启已关闭事故或新增产品范围。未来能力不自动进入本表。

### 配置与成套加载

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-config-cutover"></a>**LIVE-CONFIG-CUTOVER**<br>配置迁移 | **本次迁移范围已证。** A：旧 writer 阻断→停写→精确计划迁移到 retired；canonical/home aliases 正确，general migration 保留 models 原字节；随后独立迁移模型 schema。 | 本次迁移步骤无新增现场缺口；持续采用、其他凭据和平台重置分别见下面两行，不在这里重复验收。 | `blocked`：仅保留 [T60](T60-config-ops-integration-proof.md) 的独立 review 门。先完成复审并判断是否影响原回执；不为消除 blocked 重跑生产迁移。[配置合同](../configuration.md#one-way-migration-and-recovery) · [W17 §4](../reports/2026-09-17-live-integration-window.md#4-迁移与消费者) |
| <a id="live-config-consumers"></a>**LIVE-CONFIG-CONSUMERS**<br>消费者、重启与模型路径 | **所选消费者范围已证。** A：desktop committed→applied、原值恢复、模型域不变。B：daemon 换代后 PID/start/domain revision 相符；所选 Provider 凭据在新链路可用。 | 未选模型/凭据、其他消费者未作资格证明；不能从 desktop applied 推导 ops worker 已运行。扩大支持范围时才补对应消费者/凭据。 | `blocked`：来源 review 未完成；扩展范围需先固定 consumer、字段、模型和预算，不自动全目录探测。[T58](T58-config-command-single-writer.md) · [T60](T60-config-ops-integration-proof.md) · [W17 §4](../reports/2026-09-17-live-integration-window.md#4-迁移与消费者) |
| <a id="live-config-home-reset"></a>**LIVE-CONFIG-HOME-RESET**<br>真实平台 Reset | **未运行。** 迁移和普通进程重启不算 Reset。 | durable config/models/secrets、home aliases、installation identity、bootstrap 不覆盖编辑、原 off/预算及模型/客户端凭据分别存续。 | `blocked`：缺可丢弃 Box、平台权限、备份与单独 Reset 授权。禁止删除生产 home 模拟。[T59](T59-config-migration-cutover.md) · [T60](T60-config-ops-integration-proof.md) |
| <a id="live-modeld-cutover"></a>**LIVE-MODELD-CUTOVER**<br>Host/profile/preload/modeld 加载 | **加载子项已证。** A 从 wire v5 切至 v7；B 最终 Host/modeld 终态同 source digest，doctor custom/ready；源码、磁盘和进程证据分开。 | 完整 NATIVE 前置仍未齐；旧 peer 的只读诊断不能代替真实旧 peer 执行拒绝资格。不能从 CLI↔modeld 相符推导任意 Host 组合都相符。 | `blocked`：依赖 [NATIVE](#live-modeld-native) 与 [T49 review](T49-modeld-qualification-and-release.md)。成套加载本身不需无目的重启；只补缺失前置/受影响组合。[T40](T40-persistent-release-and-rollback.md) · [W17 §3](../reports/2026-09-17-live-integration-window.md#3-两组固定制品与失效边界) |
| <a id="live-reasoning-cutover"></a>**LIVE-REASONING-CUTOVER**<br>models schema v2 / wire v7 及降级退路 | **部分已证。** A/B schema 与协议协调加载；原 catalog、其他 Bot/main assignment 与凭据引用保持；重启后新请求可用。 | 匹配旧制品与受保护旧 schema 的实际恢复；旧 peer 拒绝新执行的现场组合。不得删除 effort 字段冒充无损降级。 | `blocked`：复审及旧 schema 恢复窗口未齐。与 [RESTART](#live-modeld-restart) 共用一次退路计划，但分别记结果。[reasoning 票](FEAT-model-reasoning-policy.md) · [配置指南](../configuration.md#model-reasoning-schema-and-general-config-migration) · [W17 §6](../reports/2026-09-17-live-integration-window.md#6-重启回退及现场修复) |

### 原生执行、权限、工具与用户入口

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-modeld-native"></a>**LIVE-MODELD-NATIVE**<br>原生接点与三路对照 | **部分已证。** A/B native-source 各 28/0；A patched official / managed 有真实回执；stock 区间有无 preload 启动和不变原生 SHA 观察。native-source 是前置证据，不等于已加载。 | stock 缺桥时的独立身份/强关联；三路 per-Agent/per-TURN 授权覆盖；passthrough 普遍不新增 managed List/Provider/工具副作用；本地失效与旧 Host local-only 能力拒绝。 | `blocked`：缺完整原生对照/观察点与 review。先准备不依赖已卸桥的身份读法，优先隔离原生验证。[边界审查](../maintainers/modeld-authority-boundaries.md) · [T49](T49-modeld-qualification-and-release.md) · [W17 C01/C11](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-modeld-authority"></a>**LIVE-MODELD-AUTHORITY**<br>真实取证恢复与取消 | **部分已证。** A：真实 List、各检查点与重新取证可关联；已观察 STEP 各一次模型调用，五秒原始年龄未放宽。 | 首次慢读后的有界恢复、累计期限、native pause、scope/Host 换代、共享等待者取消、已终止 TURN 不复活，以及不合作 source 的实际结算。 | `blocked`：缺安全的逐对象延迟/失效注入与 review。与 AUTH-NATIVE 共用受控窗口；不改整机网络或业务归属。[T45](T45-modeld-evidence-lifetime.md) · [T47](T47-modeld-authority-state-machine.md) · [W17 §5](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-auth-availability-native"></a>**LIVE-AUTH-AVAILABILITY-NATIVE**<br>同 STEP 复用与 freshness 策略 | **部分已证。** A 真实 source/STEP/cache 区分；A/B 加载 strict-observation-v2；正常路径不更新原始证据年龄。 | 2.5–4 秒慢读跨检查点复用；新 STEP 不借超过 2 秒的 cache；原始年龄不超过 5 秒；慢首次读在原 10 秒累计预算内恢复；持续超龄拒绝、失效/取消不复活。 | `blocked`：与 AUTHORITY 共用注入，但本策略判据单独签；来源 review/历史离线异常留 [AUTH 票](AUTH-ownership-evidence-availability.md)。[策略合同](../roadmap/box-runtime-impl-spec.md#modeld-effect-core) · [W17 §5](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-modeld-tools"></a>**LIVE-MODELD-TOOLS**<br>原生工具实际消费 | **部分已证。** A/C03：真实 shell 写入/读取唯一临时标记，独立文件读回、投递和 Memory 终态一致。 | 正常审批、跨证据窗口的长审批、等待中暂停/取消/换代后的最后执行门；失效后零新增执行、重复 STEP 无第二次副作用，结果入库与投递分层。 | `blocked`：缺审批操作者、受控工具/失效入口及 review。**sleep 不代替审批，材料释放不代替执行。** [T47](T47-modeld-authority-state-machine.md) · [Host 主链](../maintainers/host-inbound-agent-loop.md) · [W17 C03](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-auth-availability-tools"></a>**LIVE-AUTH-AVAILABILITY-TOOLS**<br>长审批后的权限复核 | **部分已证。** 复用 C03 的正常消费证据，不另算一次通过。 | 审批跨 5 秒窗口后重新核对权限；审批中撤权/取消/换代后不执行；同 STEP/关闭 TURN 无重放；模型→材料→审批→执行→入库→投递各段可关联。 | `blocked`：依赖 AUTH-NATIVE 与 TOOLS，缺最后消费门证据。共享一次测试仍按本条判据留证。[AUTH 票](AUTH-ownership-evidence-availability.md) · [权限边界](../maintainers/modeld-authority-boundaries.md) |
| <a id="live-modeld-app"></a>**LIVE-MODELD-APP**<br>原版 App、发送与 Working | **后端/投递部分已证；App 未观察。** W17 有真实模型/终态/投递和上游错误分类，不是 App 验收。 | 原 App 发出的消息与同 session/run/代关联；详情 echo/副本/发送队列、等待/取消/失败/完成、侧栏子任务、重连与迟到事件；不能把服务端回复当详情已显示。 | `blocked`：缺未修改原版 App 的实际输入与视图证据。纳入 T26/T36/T39 旅程；不重发历史失败气泡、不改 App/清缓存造绿。[T36](T36-composer-working-activity.md) · [App 判据](../maintainers/composer-working-status.md) · [T39](T39-native-model-roundtrip.md) |
| <a id="live-auth-availability-app"></a>**LIVE-AUTH-AVAILABILITY-APP**<br>权限等待、拒绝与指引 | **App 未观察。** 正常权限进度与上游 503 分类有 W17 后端证据，但不是 stale/拒绝提示的原 App 回执。 | stale/read_elapsed、后续证据/permit 过期、预算耗尽、temporal/访问拒绝的实际提示；控制帧不进模型正文；不误报失权、零调用或建议自动重放。 | `blocked`：依赖受控权限场景和原 App。与 MODELD-APP 共享视图，按错误来源单独核对文案与动作。[AUTH 票](AUTH-ownership-evidence-availability.md) · [观测手册](../maintainers/run-outcome-observation.md) |
| <a id="live-reasoning-provider"></a>**LIVE-REASONING-PROVIDER**<br>同通道 effort 与上游回报 | **成功与失败并存。** A/C06–C08：一个固定通道 high/xhigh/default 均 HTTP 200、emitted 对应；C04/C05 的另一固定通道均 503，无自动重试/降级。 | Provider 明确执行档位仍 unknown；503 通道的可用性未恢复证明。成功通道不覆盖失败通道；token/耗时/标题不能确认内部档位。 | `blocked`：缺合格 Provider 回报解码/网关转换证据、失败通道资格及 review。后续固定 exact endpoint/API/model/key-reference 与预算；不切通道冒充原通道通过。[reasoning 票](FEAT-model-reasoning-policy.md) · [W17 C04–C08](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-reasoning-host-app"></a>**LIVE-REASONING-HOST-APP**<br>下一 TURN 改档与原生往返 | **Host 子项已证，App/compact 未证。** A/C06–C09：在途改 xhigh 后旧 TURN 仍 high，下一 TURN 才改；default/official 清 e/m，用户标题与历史工具标记保留。 | 原 App 标题/输入/详情/状态；含原生 compact checkpoint 的同 modelId 改档与回官方；不能仅凭配置查询判当前 TURN。A 证据未作为 B 的全量重跑。 | `blocked`：依赖 PROVIDER、App、原生持久状态与 review。与 SESSION-ROUNDTRIP 合并安排长会话，不停掉工具/Memory/compact 规避判据。[reasoning 票](FEAT-model-reasoning-policy.md) · [W17 C06–C09](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-provider-minimax"></a>**LIVE-PROVIDER-MINIMAX**<br>MiniMax 多步工具与原生记录 | **W17 普通链路已证。** A/C02–C03、B/C12 覆盖主回合、工具、inline continuation/空辅助结果、Memory、投递；不把有限 canary 当永久兼容保证。 | 当前候选的 batch/long-value Provider 专项覆盖映射；原生 disabled automation 的创建、真实日程/启用字段、跨重启读回与清理。历史专项回执需先核对，W17 没跑 Routine。 | `blocked`：先按 [Provider 手册](../maintainers/chat-provider-compatibility.md#regression-and-live-acceptance)核对历史回执/候选映射，再安排缺失子项及额度。该原生工具验收不依赖未来 Routine CLI 实现；不启用测试定时任务。[W17 §5](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| <a id="live-session-roundtrip"></a>**LIVE-SESSION-ROUNDTRIP**<br>官方→模型 A→模型 B→官方→A | **部分已证。** W17 有多模型、工具/Memory及同会话标记回官方/重启恢复；不是完整规定序列与原生 checkpoint 资格。 | 固定合格双模型的完整旅程；custom 原生持久 checkpoint 被新进程/官方消费者读回，summary/tool/Memory 保真；小窗口切换、冷/热缓存正确性和原 App 同源。 | `blocked`：来源原生持久消费者/完整 proof 尚有前置，现场模型与窗口未新选。缺代码/隔离资格仍归 [T39](T39-native-model-roundtrip.md)，不能借现场短 Bot 替代。[连续性判据](../maintainers/managed-context-continuity.md) |
| <a id="live-context-native-continuity"></a>**LIVE-CONTEXT-NATIVE-CONTINUITY**<br>既有 compact、pending 与恢复 | **完整链路未证。** W17 native-source 覆盖部分接点；没有现场 compact/checkpoint 回执。 | 首请求 overflow、已有 pending external/self/background 协调、摘要接受/迟到取消、同绑定一次 resume/attempt1、唯一终态、恢复后工具/Memory/episode/checkpoint；非恢复错误不放大 retry。 | `blocked`：先完成 [T32](T32-runtime-confirmed-compact.md)/[T35](T35-host-compact-wait-point.md) 的实现及原生隔离前置，再跑受控现场。新默认维护另见 CTX 三行；不以大 pad 冲撞 Provider或沿用旧 GATE 授权。[原生 seam](T32-host-compact-seam.md) · [连续性](../maintainers/managed-context-continuity.md) |
| <a id="live-ownership-alignment"></a>**LIVE-OWNERSHIP-ALIGNMENT**<br>身份 writer 退场与冲突对象 | **新建干净 Bot 子项已证；历史冲突未重验。** W17 两只测试 Bot confirmed_box，不等于旧冲突已修复。 | 普通更新不写 ownership 的现场证据；原生启动同步对既有冲突的影响；冲突对象原生可恢复保全、按单独决定保留/校准及读回，实际迁移后零越权新动作。 | `blocked`：需当前原生资格、可恢复资料及逐对象影响/授权；不按历史 test2 名称自动校准，不把保留样本无限阻塞干净对象。[T37](T37-server-ownership-admission.md) · [T38](T38-identity-write-alignment.md) · [harness 手册](../maintainers/transcript-harness-box-vs-server.md) |

### 重启、回退、持久运行与观测

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-modeld-restart"></a>**LIVE-MODELD-RESTART**<br>代际隔离与完整退路 | **部分已证，发现的 reapply 缺陷已修复并现场复验。** A 正式 idle replace、旧 epoch 拒绝、新请求通过；B 同制品 stop→start→already_started、最终 canary 通过。 | 原版 App/原生 compact checkpoint 的完整退路；stock 缺桥期间独立 identity 与强关联；旧制品/旧 schema 真正恢复；在途/未知副作用结算不能仅靠重启判定。 | `blocked`：缺完整退路与 review；不再把同制品 reapply 列为待修。先固定所需退路和受影响对象。[修复票](FIX-host-lifecycle-reapply.md) · [T40](T40-persistent-release-and-rollback.md) · [回退判据](../maintainers/official-rollback-acceptance.md) · [W17 §6](../reports/2026-09-17-live-integration-window.md#6-重启回退及现场修复) |
| <a id="live-runtime-persistence"></a>**LIVE-RUNTIME-PERSISTENCE**<br>安装、自启与长期服务 owner | **进程级重启已证；持久安装未证。** W17 Host/modeld/daemon 换代、配置/所选凭据与新请求正常；detach/父 PID 不是自启证据。 | 支持的持久服务 owner、干净启动/父 shell 退出、安装幂等、官方 Host 自行重建后的补丁采用、开机/环境重建恢复及单实例；正常配置不依赖临时环境变量或故障注入。 | `blocked`：安装/boot-hook 实现与目标平台资格仍归 [T40](T40-persistent-release-and-rollback.md)，不是再做一次 restart 就能关闭。真实高影响重建另开窗口；平台 Reset 另记 CONFIG-HOME-RESET。 |
| <a id="live-monitor-persistence"></a>**LIVE-MONITOR-PERSISTENCE**<br>现有本地 collector / SQLite / incident | **现役 collector 未安装验收。** W17 的 daemon/desktop applied 不替代 monitor 长驻。本地/source/packed 测试保留原范围。 | 无网页/CLI 退出仍采集、与准入共享读取有界；真实 scope/代/失联 gap；重启保留 incident/ack/snooze/cursor；受控 DB 异常不影响执行；local-only 与实际通知接收分开。 | `blocked`：先由 [T41](T41-continuous-observation-and-alerting.md)/[T40](T40-persistent-release-and-rollback.md)关闭调度/安装前置，明确服务 owner、测试存储与窗口。不要等待未来 Webhook 运维全部实现，也不把未来外部离线监控拖进本项。[观测手册](../maintainers/continuous-observation.md) |

### 待现场资格：区分已实现 CTX 与尚未实现的运维

以下八条均无新的现场回执。五条 Template Ops 的实现仍未记录；CTX 已有功能提交 `883e224` 与读回修复 `269f1e2`，源码/Node 制品及原生隔离资格见[离线收口报告](../reports/2026-09-17-context-maintenance-offline.md)。独立 reviewer 本次返回 503，尚无复审结论，**不能把 review 缺口改称只差 live**。用户已授权本功能完成前置后 rebase v2、成套切换及 modeld 重启；此授权不代替前置通过、逐对象预算或原版 App 证据。

| 维度 / 稳定 ID | 当前现场进度 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-ops-routines"></a>**LIVE-OPS-ROUTINES**<br>原生 Routine / Payload / 模板隔离 | 未运行；`blocked`。 | disabled 创建→读回→enable→真实 POST→原生 run/Payload/报告关联→更新再 POST→disable/清理；认证、大小/编码/禁用语义及双模板 endpoint/secret 不继承。 | [T43](T43-native-webhook-contract.md)/[T46](T46-template-ops-pairing.md)/[T53](T53-agent-routines-cli.md) 实现前置。之后固定 Bot、请求/费用与清理；sendPrompt/mock 不替代 Webhook，unknown 不重复创建。 |
| <a id="live-ops-receivers"></a>**LIVE-OPS-RECEIVERS**<br>custom 接收者与有限路由 | 未运行；`blocked`。 | Webhook 回合真实模型/供应商/工具/数据同意；单目标、intent 分流、一层交接、备用/集中报告和改配置需重绑；ACK unknown 不广播，总预算不放大。 | [T45](T45-template-webhook-delivery.md)/[T47](T47-bounded-ops-diagnosis.md)/[T54](T54-ops-targets-and-routing.md)/[T55](T55-custom-receiver-delivery.md) 实现前置，依赖 ROUTINES。普通聊天选模成功不算本项。 |
| <a id="live-ops-observer-lifetime"></a>**LIVE-OPS-OBSERVER-LIFETIME**<br>无人值守运维提醒 | 未运行；`blocked`。 | 启动 Bot 回合与网页结束后持续感知；无变化零唤醒、需处理才一次提醒；重启/断网/endpoint 撤销/存储故障后的 cursor、欠账、去重、预算和 degraded；真实投递不等于 outbox accepted。 | [T44](T44-host-ops-continuous-sensing.md)/[T45](T45-template-webhook-delivery.md)/[T46](T46-template-ops-pairing.md)/[T50](T50-template-ops-release-proof.md) 实现与安装前置，依赖 CONSUMERS/ROUTINES。本地 collector 验收另见 MONITOR-PERSISTENCE。 |
| <a id="live-ops-issue-publishing"></a>**LIVE-OPS-ISSUE-PUBLISHING**<br>受信同意与真实 GitHub 提交 | 未运行；`blocked`。 | 原生用户确认区别于自动事件；exact 内容/仓库/作者同意→提交并读回；有限 grant 有效期/额度/撤销、跨 Bot 去重、ACK unknown 对账；仅批准范围清理。 | [T52](T52-consented-support-issues.md)/[T56](T56-scripted-issue-publishing.md) 实现前置；另缺专用仓库与公开合成内容授权。人工关闭历史 issue 不算此功能资格。 |
| <a id="live-ops-maintenance"></a>**LIVE-OPS-MAINTENANCE**<br>自动维护屏障与交接 | 未运行；`blocked`。 | 原生 admission fence/排空、提出者及子任务终结后唯一 controller 执行；busy/审批/新任务/撤销/换代拒绝；一次对齐/安全退出及未知退路。 | [T47](T47-bounded-ops-diagnosis.md)/[T48](T48-low-risk-host-qualification.md)/[T49](T49-policy-host-maintenance.md)/[T50](T50-template-ops-release-proof.md) 实现与 review 前置。W17 人工 force 不证明自动维护屏障；idle 采样不替代 fence。 |
| <a id="live-ctx-adoption"></a>**LIVE-CTX-ADOPTION**<br>默认本地维护策略真正加载 | **尚未切换；`blocked`。** 已实现 config v3 / wire v8 / 默认本地 128K；Node20 制品、真实 SDK/Unix 与固定原生方法隔离测试已执行，不是加载证据。 | 现役 config2→3 迁移、旧制品退路、实际 Host/modeld/policy/root capability 同代；configured/captured、默认 auto/注入 off、其他 Bot/official 不变。 | [CTX-00](CTX-00-pi-compaction-reuse.md)–[CTX-04](CTX-04-context-entrypoints-and-proof.md) 已有实现；[离线报告](../reports/2026-09-17-context-maintenance-offline.md)保留实际证明和 reviewer 503。先取得固定提交独立 review、映射当时 v2 并完成受影响回归，再按已授权范围和[窗口流程](../maintainers/release.md#live-window-procedure)操作。不得以旧 gate 或 W17 wire7 回执代替新能力。 |
| <a id="live-ctx-next-input"></a>**LIVE-CTX-NEXT-INPUT**<br>已失败长会话下一条普通输入 | **真实用户旅程未运行；`blocked`。** 合成旧失败 root、单条新输入、主 HTTP 前维护、十轮压缩与新进程续聊已在实际制品/本地 HTTP 链通过。 | 原 App 新输入的 nonce/文本/附件、真实已失败长会话上的有限摘要与 native accept/checkpoint；旧 STEP/工具不重放，后一条短输入不无谓 compact，活动/交付真实。 | 依赖 [ADOPTION](#live-ctx-adoption) 及 [CTX-04](CTX-04-context-entrypoints-and-proof.md) 固定 review。使用已授权故障排查对象时先确认当前 session/归属/安全窗口，固定新输入与模型预算；不重发历史失败 STEP。没有原版 App 操作/观察接口时保留该子项 not-observed，CLI 发送不能冒充 App 通过。 |
| <a id="live-ctx-durability"></a>**LIVE-CTX-DURABILITY**<br>新维护 checkpoint 的重启与退路 | **真实服务重启未运行；`blocked`。** 已有受控原生方法/临时持久 root 的新进程回读、取消和错 source/material revision 的 commit_unknown 反例。 | 实际原生 archive/carrier/checkpoint 由新 Host 读回；ACK 丢失与取消的实际提交状态对账、后续工具/Memory/App 及官方退路，不能把临时 store 说成完整原生存储事务。 | 依赖 [NEXT-INPUT](#live-ctx-next-input) 与 [CTX-02](CTX-02-host-context-maintenance.md)/[CTX-04](CTX-04-context-entrypoints-and-proof.md)。重启已获本功能范围授权，仍先满足 review/集成与当前在途对象保护；故障注入无安全点仅阻断对应向量。保持所有 unknown 和用户新编辑，不为回退删 ledger/历史。 |

## 现场之外的共同阻断

下表只路由前置责任，不在本页维护源码任务清单或 review 结果副本。

| 阻断 | 去哪里处理 | 对本索引的影响 |
|---|---|---|
| 独立固定提交 review；reviewer 503 不算报告 | [T49 modeld](T49-modeld-qualification-and-release.md)、[T60 config](T60-config-ops-integration-proof.md)、[AUTH](AUTH-ownership-evidence-availability.md)、[reasoning](FEAT-model-reasoning-policy.md)、[Host reapply 修复](FIX-host-lifecycle-reapply.md) | 现场子项已证也不能自动签整体验收；复审引发相关改动再标 needs-revalidation |
| 原生隔离消费者、完整源码/packed proof 或安装代码未齐 | [T32](T32-runtime-confirmed-compact.md)、[T35](T35-host-compact-wait-point.md)、[T38](T38-identity-write-alignment.md)、[T39](T39-native-model-roundtrip.md)、[T40](T40-persistent-release-and-rollback.md)、[T41](T41-continuous-observation-and-alerting.md) | 先补来源前置，再执行对应已索引的现场部分；不把缺代码改名为缺环境 |
| Template Ops 实现与 CTX 复审/集成前置 | [运维 Spec](../roadmap/template-ops-automation-spec.md)仍有待实现功能；[CTX Spec S12](../roadmap/box-runtime-impl-spec.md#context-maintenance)已有 Pi 受控提取、调用边界和原生接线，[CTX-04](CTX-04-context-entrypoints-and-proof.md)记录未完成独立 review。PI-AI-01 独立非阻断 | 分别按来源票完成；CTX 不再被记为只有规划，也不能因离线通过而自动通过 live。重启旧实现不改变新功能进度 |
| npm 发布、历史隐私扫描等非现场发布门 | [release runbook](../maintainers/release.md)、[隐私门](../maintainers/publication-privacy.md) | 单独满足，不用 live 通过数抵消，也不放入现场缺口计数 |

## 后续窗口怎么选

先解除对应来源前置，再按所需对象选窗口，不按“所有 blocked 一起重跑”。权限慢源/取消与长审批共享受控对象，但最后工具执行门单独留证；原版 App 可合并普通/权限提示/改档/会话往返；旧 schema/stock/原生 checkpoint 回退共用明确退路；安装/collector/平台 Reset 各需自己的生命周期条件。所有逐项缺口以总表为准。

执行前依 [共用窗口流程](../maintainers/release.md#live-window-procedure)固定候选、源码映射、实际制品、对象/预算、停止与回滚。不从本索引、历史“继续”、合分支或构建结果推导新授权；不为验收切未合入分支，不重放旧消息，不更改官方归属或清账本制造成功。

<a id="window-20260917"></a>
## 窗口与证据索引

| 窗口 | 固定范围 | 已记录结果与详情 |
|---|---|---|
| **W17-A · 2026-09-17** | `7994b92`；`15a0594`/`02a6d81` 仅文档；source digest `82aaf3e4…` | 配置迁移、消费者应用、Provider/工具/Memory、effort/在途 TURN、逐 Bot 官方回程、modeld replace、stock 尝试；C01–C11。[固定身份/映射](../reports/2026-09-17-live-integration-window.md#3-两组固定制品与失效边界) · [逐消息回执](../reports/2026-09-17-live-integration-window.md#5-消息与执行证据) |
| **W17-B · 2026-09-17** | 修复 `338cf83`、pin `fe05442`，集成 `dc03066`；source digest `f2226ccb…` | 同制品再启停和最终 C12、daemon 换代；[修复与回退事实](../reports/2026-09-17-live-integration-window.md#6-重启回退及现场修复) · [离线/review 回执](../reports/2026-09-17-live-integration-window.md#7-离线复验和复审缺口) |

W17 结束时记录 config schema v2 / models schema v2 / wire v7 / strict-observation-v2；B 最终 Host/modeld 终态同源码摘要，doctor custom/ready/next=none。这是该时点快照，不是本次文档整理重新确认的现役状态。

整窗两只测试 Bot、12 条新消息：9 条关联预期结果，2 条上游 503，1 条 stock 持久回复可读但 strong correlation unknown。modeld 关联 19 次 HTTP（17 成功、2 失败），不含官方请求或 reviewer，不推算费用。两个 Bot 已导出、撤销 assignment 并删除；审计标记/备份保留。Host force 曾涉及既存活动对象，不能声称业务零中断。[授权、消耗与影响](../reports/2026-09-17-live-integration-window.md#2-授权边界与实际消耗) · [清理事实](../reports/2026-09-17-live-integration-window.md#8-清理与尚未完成)。

## 更新规则与条目模板

新增需求直接在总表所属维度下登记；已有 ID 不改名、不复用、不删除锚点。来源票和维护页只回链对应行；日期报告保留原始结果，不随新窗口重写历史。一次窗口由一个维护者更新总表；并行合并保留双方来源/证据，不以整段覆盖丢回执。

每行至少包含：**稳定 ID、现场进度/证据范围、具体未验项、状态与阻断、下一步、来源和回执链接**。没有回执写未运行；只有历史证据写明年份/制品与待重验；出现失败保留失败对象/范围，不以另一通道成功覆盖。不在索引堆命令脚本、原始日志、长 source 映射或过时“当前 PID”。

```markdown
| <a id="live-feature-case"></a>**LIVE-FEATURE-CASE**<br>维度 | 未运行；或已证的窗口/制品/子项 | 尚缺的具体判据 | `awaiting-integration` / `blocked` 等；阻断、下一步；[来源票](...) · [日期回执](...) |
```

| 验收状态 | 含义 |
|---|---|
| `awaiting-integration` | 尚未建立 source→固定 v2 候选映射或未选共同制品 |
| `ready` | 来源代码/离线/独立复审、固定映射、依赖及本轮对象/预算/授权均满足 |
| `running` | 已授权窗口正在执行，必须能关联本轮身份/回执；失联不是完成 |
| `passed` | 本条全部判据和必要前置在指定制品/原生版本/策略下满足，不能扩展到其他对象 |
| `failed` | 观察到违反判据；保留失败证据，代码问题回来源票 |
| `blocked` | 缺实现前置、review、对象、权限、受控输入或安全窗口；最后一列写明具体阻断 |
| `needs-revalidation` | 相关制品、原生 Host/App、schema/wire、策略、接点或能力变化使旧覆盖不足；保留旧回执并列出需重验子项 |
| `superseded` | 需求明确被替代/取消，注明替代 ID/来源决定；不是验收成功 |

完成后只更新受影响行与窗口链接；发现缺陷先停止该范围、回来源修复并重新冻结候选。默认不因 docs-only 变更撤销现场证据，也不把源码 digest 相同当作原生/App/实际加载身份相同。未知、缺证与未实现始终可见，长期索引不因一次部署关闭。
