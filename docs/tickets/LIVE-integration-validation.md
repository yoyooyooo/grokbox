# LIVE — 现场集成验收唯一索引

**长期保持 open；逐项验收，不整票关闭。** 本页唯一维护各维度的现场验证进度、剩余缺口、阻断、下一步和证据入口。只看本页即可判断还缺什么；执行时再打开对应合同、操作手册或历史回执。

默认集成线：**`feat/box-runtime-v2`**。最近现场增量为 **2026-09-17 UTC 的 CTX-V8 窗口**：已实际完成config3/wire8/custom Host采用与一次modeld replacement；端点503和显式备用200、Bot选择保存与真实消息执行分别取证。后续5f2afdb不确定提交保护已通过集成v2 `6e88991`的非强制Host restart与modeld replacement采用，新preload指纹已读回。原Bot消息与compact/checkpoint验收仍因工具拦截缺证，不能把ready等同于全部通过。[新窗口回执](#window-context-v8-20260917)与[W17历史](#window-20260917)分开；表中已证仅对指定制品/对象/窗口成立，不是实时健康保证。

## 阅读与维护边界

| 信息 | 唯一维护位置 |
|---|---|
| 当前各维度已验/未验、阻断、下一步、回执索引 | **本页下方总表**；其他文档回链对应稳定 ID，不复制当前状态表 |
| 功能语义、成功/失败判据、实现、离线测试、独立 review | 来源 Spec/Ticket；本页只摘录阻断及责任链接，不把未实现代码或 review 改称 live 待办 |
| 具体命令、前置检查、授权/预算、停止与恢复方法 | 对应 maintainer runbook；共用流程见 [release runbook](../maintainers/release.md#live-window-procedure) |
| 某次运行的固定制品、源提交映射、逐用例证据、影响和清理 | 日期化 report；本页登记窗口链接，report 不维护后续当前进度 |

**现场进度与验收状态分开。** “部分已证”不等于全部 `passed`；“本条范围内已证、review 阻断”也不等于还要重做迁移。`blocked` 的具体原因在最后一列，不让一个状态词遮住实际缺口。A/B 仅指 [W17-A / W17-B 制品](#window-20260917)，不是 Provider 或模型编号。A 的结果不能写成 B 上重新运行过；涉及 B 的对应能力仍须核对覆盖关系。

## 当前验收总表

保留既有稳定ID与历史回执；本轮新增已接受的OBS证据/存储/安全退役及原生自主任务维度，均先登记实现/资格前置，不代表已经执行或只剩live。延期的Issue条目保留锚点但不计首发阻断，不重新开启历史事故。

### 配置与成套加载

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-config-cutover"></a>**LIVE-CONFIG-CUTOVER**<br>配置迁移 | **既往迁移已证，schema4候选尚未合入/采用。** W17旧writer阻断/停写、计划到retired、aliases及models字节保护保持原范围。2026-09-18只读确认现役schema3、modeld wire8可达且采样activeSteps=0；不是持续idle或Host匹配证明。T51候选在`docs/incident-bot-observability-plan`，本轮初始提交9b6201c，全仓2344 pass/15 skip/0 fail、专项88 pass。 | 新增3→4精确迁移、旧可执行制品/配置备份与退路、旧writer停写及匹配消费者成套加载；storage全安装预留/journal采用与统一applied仍有源码缺口，不能用配置成功签完成。 | `blocked`：[T51](T51-ops-capability-presets.md)/[OBS-04](OBS-04-bounded-observation-storage.md)候选继续在独立worktree，review无有效回执。先保护原CLI/服务制品，协调schema4代码合入与实际采用，避免只更新可能被源码shim引用的v2造成配置失配；不无目的重跑W17。沿用[T60](T60-config-ops-integration-proof.md)与[配置合同](../configuration.md#one-way-migration-and-recovery)。[W17 §4](../reports/2026-09-17-live-integration-window.md#4-迁移与消费者) |
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

### 故障证据与有界存储

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-obs-evidence"></a>**LIVE-OBS-EVIDENCE**<br>原生故障→固定证据→提醒后取证 | **本轮未运行真实链。** 本地unknown tray/无STEP intake、固定revision/安全摘要、跨源段回收后的同revision读取及打包Node归档取证已有离线证明；不是原生Bot送达或新Host已加载证明。 | 未知tray/queue failed/无STEP实际进入incident；真实工具/checkpoint关联和缺口；告警引用同revision在后续输入/轮转后仍可查；Bot默认只提醒，实际网络数据符合视图。 | `blocked`：先完成[OBS-00](OBS-00-evidence-contracts.md)至[OBS-03](OBS-03-evidence-privacy-views.md)、T45/T46与独立review；由[OBS-06](OBS-06-integration-and-soak-proof.md)/T50冻结候选、对象与费用，复用ROUTINES窗口。不改原App、不复演旧STEP。 |
| <a id="live-obs-storage"></a>**LIVE-OBS-STORAGE**<br>长期容量与物理空间回收 | **本轮未切换现役。** schema4候选新增modeld listener所属维护子Scope，无collector/通知off仍回收既有证据；闲置关闭日志段、固定回执、真实Node强杀/无晚写和有界物理计量已离线验证。专项63 pass，全仓2381 pass/15 skip/0 fail；类型/构建/隐私与上轮rebase已收口，不再保留旧工具拦截为本轮测试阻断。 | 匹配Host/preload/modeld与schema4成套采用；实际30秒维护周期、重启/文件系统稳态和Box自启；全安装跨owner物理预留、其他owner和执行/CONT安全退役。计量只是部分诊断命名空间，不授权删除或签全配额。 | `blocked`：[T51](T51-ops-capability-presets.md)/[OBS-04](OBS-04-bounded-observation-storage.md)/[OBS-06](OBS-06-integration-and-soak-proof.md)候选仍在`docs/incident-bot-observability-plan`，独立review未取得。先与[CONFIG-CUTOVER](#live-config-cutover)固定旧制品退路、完成相应源码/资格再成套集成采用，不只更新源码shim。固定回执：`docs/reports/2026-09-18-modeld-storage-lifetime.md`；既往轮转证据见[分段回执](../reports/2026-09-18-structured-journal-rotation.md)。 |
| <a id="live-obs-safe-retirement"></a>**LIVE-OBS-SAFE-RETIREMENT**<br>执行身份与恢复引用退役 | 本轮未运行；现有incarnation隔离不证明同代安全GC已完成。 | 真实延迟请求在GC/重启/恢复后不再执行；commit_unknown最小阻断保持；当前/回退制品及CONT私有manifest闭包不被清；物理回收而非累计STEP上限。 | `blocked`：先完成[OBS-05](OBS-05-safe-state-retirement.md)的协议退役/入口覆盖与独立review，再选明确授权原生操作和安全存储窗口。复用CTX/CONT相关回执但独立签本条，不删ledger造空环境。 |

### 单盒状态塑造、并行替身交接与退役

| 维度 / 稳定 ID | 现场进度与已验证范围 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-ownership-continuity"></a>**LIVE-OWNERSHIP-CONTINUITY**<br>北极星全链入口 | **完整现场链未运行。** 仅历史原生边界探针/空身份创建的原范围；本轮更新完整规划，不形成live回执。 | 从确认接管到best-effort新Box接活，机械/旧Bot辅助交接并观察旧DM/群聊收敛、条件式退役；下列各维度需有串联证据。 | `blocked`：按[S13全阶段](../roadmap/box-runtime-impl-spec.md#continuity-delivery)/[CONT-05](CONT-05-continuity-acceptance.md)完成来源实现、资格及review，固定v2候选和授权对象/预算；不能只验首个clone就关闭。单盒、无多session。 |
| <a id="live-ownership-loss-protection"></a>**LIVE-OWNERSHIP-LOSS-PROTECTION**<br>感知、默认暂停与通知 | 本轮未运行；不借OBS局部取证或modeld ready作替代。 | 真实归属变化/首次不符、读取gap、默认暂停到真实管理端及pause=false、保留enabled意图/在途fire；事件到用户接收的延迟。 | `blocked`：[CONT-01](CONT-01-ownership-loss-notification.md)/[CONT-11](CONT-11-policy-and-operation-contract.md)、T53及ops投递前置；长驻另见[MONITOR-PERSISTENCE](#live-monitor-persistence)。通知独立交付不等clone。 |
| <a id="live-continuity-material"></a>**LIVE-CONTINUITY-MATERIAL**<br>分档保全与重建 | 本轮未运行；CTX已证窗口不替代恢复包完整性。 | 同ID不同root内容、原生最近提交/完整快照/安全续接点、四档/空间不足、source Temporal增量、语义缺口报告、源删除后的目标资源独立性。 | `blocked`：[CONT-02](CONT-02-continuity-snapshots.md)/CONT-00源资格及存储reader；与OBS容量/安全引用条目协调，不能用诊断JSON充恢复状态。 |
| <a id="live-continuity-primitives"></a>**LIVE-CONTINUITY-PRIMITIVES**<br>duplicate与状态clone | 本轮未运行；空Bot confirmed_box不证明导入。 | 官方duplicate实际语义/unknown、不抢当前聊天的创建；新Box人设/Memory/历史/当前状态导入、第一轮实际request、关闭重开第二轮沿目标最新状态继续。 | `blocked`：[CONT-06](CONT-06-native-duplicate-cli.md)/[CONT-03](CONT-03-native-box-clone.md)/[CONT-07](CONT-07-current-context-control.md)及资格；source/packed后用有限对象，源不被直接改归属。 |
| <a id="live-current-context"></a>**LIVE-CURRENT-CONTEXT**<br>唯一当前状态控制 | 本轮未运行；现有compact不等于reset/initialize/recover。 | 原生reset后旧摘要/prepend/pin/salvage不复活、Memory保留；self-request不死锁、queued/late状态不串revision；Host强杀/更新/领养读回，App显示与模型窗口分开。 | `blocked`：[CONT-07](CONT-07-current-context-control.md)和CONT-02保全、原生输入边界资格；不实现sessions产品，恢复不回滚真实文件/外部任务。 |
| <a id="live-continuity-spawn"></a>**LIVE-CONTINUITY-SPAWN**<br>受管指令与临时启动 | 本轮未运行；原生kickstart不是通用startup。 | 初始化前零模型请求、第一次指定模型/指令、无伪Human任务、startup幂等、compact/重启后指令持续、结果交付和临时清理。 | `blocked`：[CONT-08](CONT-08-instructed-spawn.md)/CONT-07及创建/启动资格；不借hidden send过关，未结任务不按TTL直接删。此独立消费者不阻断合格替身主线。 |
| <a id="live-continuity-handover"></a>**LIVE-CONTINUITY-HANDOVER**<br>新旧并行逐职责交接 | 本轮未运行。 | 新Bot已接A而旧B结果unknown/C群未迁；实际群公告/成员、DM去重、Routine/回调、旧Bot指路及旧入站处置；handoff k=v/侧栏投影与权限/预算。 | `blocked`：[CONT-04](CONT-04-automatic-replacement.md)/[CONT-09](CONT-09-relationship-handover.md)及正式消息/关系适配；不以旧端全局idle作新端全部上线门，不伪造sender。 |
| <a id="live-continuity-retirement"></a>**LIVE-CONTINUITY-RETIREMENT**<br>收敛、退役与多代恢复 | 本轮未运行；短时无活动不是退役证明。 | 健康覆盖/旧新事件分类、gap不计quiet、未结依赖/新入站阻断、删除前竞态与正式删除读回、新资源完整、多代继任解析/创建限额。 | `blocked`：[CONT-10](CONT-10-inbound-convergence-retirement.md)/CONT-04/09及删除前资格；无可靠覆盖/屏障保留并通知，不能拿计时器假设安全。 |

### 待闭合资格：CTX已有现场子项，运维仍按来源前置推进

Template Ops与OBS已有局部实现和离线证明，尚无本轮现役采用/原生通知回执；Issue支路延期，不作为首发前置。CTX的源码、打包和原生隔离证明见[离线报告](../reports/2026-09-17-context-maintenance-offline.md)，本轮新增的成套采用、真实503/备用端点与modeld换代见[CTX-V8回执](../reports/2026-09-17-context-v8-live-window.md)。用户已明确接受503与备用模型的有限测试窗口；这不把Astra的503或备用review超时改成独立审核通过，亦不签正式发布。实际Bot消息被工具安全检查拦截，现有阻断已不只是review通道不可用。

| 维度 / 稳定 ID | 当前现场进度 | 还没验证什么 | 验收状态、阻断与下一步 / 详情 |
|---|---|---|---|
| <a id="live-ops-routines"></a>**LIVE-OPS-ROUTINES**<br>原生 Routine / Payload / 模板隔离 | **本轮未写现役Routine或发Webhook。** 候选已实现list/show/enable/disable/delete及按需Skill；local/daemon/打包Node以合成HTTP边界验证，专项80 pass，全仓2405 pass/19 skip/0 fail。另显式运行固定源函数探针4 pass；不是原生HTTP或Bot送达证明。 | disabled provision/apply与持久回执仍有源码前置；随后真实创建→启用→POST→run/Payload/报告→更新→禁用/清理，认证/重复/大小与双模板隔离需分别验。启停不宣称取消在途任务。 | `blocked`：[T43](T43-native-webhook-contract.md)/[T46](T46-template-ops-pairing.md)/[T53](T53-agent-routines-cli.md)其余前置、独立review与成套候选未闭合；本轮review请求503无结论，上游事实Current Home同步被工具拦截仍待办。先补provision/配对/投递，不以manual run或mock替代Webhook。候选回执：`docs/reports/2026-09-18-native-routine-management.md`。 |
| <a id="live-ops-receivers"></a>**LIVE-OPS-RECEIVERS**<br>custom 接收者与有限路由 | 未运行；`blocked`。 | Webhook 回合真实模型/供应商/工具/数据同意；单目标、intent 分流、一层交接、备用/集中报告和改配置需重绑；ACK unknown 不广播，总预算不放大。 | [T45](T45-template-webhook-delivery.md)/[T47](T47-bounded-ops-diagnosis.md)/[T54](T54-ops-targets-and-routing.md)/[T55](T55-custom-receiver-delivery.md) 实现前置，依赖 ROUTINES。普通聊天选模成功不算本项。 |
| <a id="live-ops-observer-lifetime"></a>**LIVE-OPS-OBSERVER-LIFETIME**<br>无人值守运维提醒 | 未运行；`blocked`。挂起RPC时本地failed仍入库/ready、取消结算与6000条积压不放大RPC已离线验证；尚无持久服务/原生投递回执。 | 调用Bot/网页结束后持续采集，慢上游不阻本地故障；固定现场后发ID/命令，Bot只提醒，无自动诊断/Issue询问；重启/断网/撤销后的游标、过期合并、去重、预算和unknown；关闭通知不停止必要GC。 | [T44](T44-host-ops-continuous-sensing.md)/[T45](T45-template-webhook-delivery.md)/[T46](T46-template-ops-pairing.md)/[T50](T50-template-ops-release-proof.md)实现/安装前置，依赖CONSUMERS/ROUTINES及OBS证据/容量合同。collector另验MONITOR-PERSISTENCE，不能用本地callback返回代用户交付。 |
| <a id="live-ops-autonomy"></a>**LIVE-OPS-AUTONOMY**<br>原生Bot受托自主排障与换模 | 未运行；独立后续A，不阻塞默认提醒首发。 | 用户委托后同incident自主多步取证/选择工具/执行与核验，不逐条询问常规读；只排查不擅自重启/换模/公开，明确换模只改指定Bot并验下一TURN采用；提醒模板不永久限只读。 | `blocked`：[T47](T47-bounded-ops-diagnosis.md)与证据/租约/授权实现、离线和原生能力review前置；之后固定用户任务、对象、模型预算与原生交互窗口。单次工具mock不证明用户旅程。 |
| <a id="live-ops-issue-publishing"></a>**LIVE-OPS-ISSUE-PUBLISHING**<br>用户决定后的公开支持 | **Deferred；未运行，不计首发阻断。** | 将来用户明确要求公开时才验确切稿件/目标/作者同意、已有gh身份、无认证跳过、unknown对账；当前不验自动Issue或发布grant。 | [T52](T52-consented-support-issues.md)/[T56](T56-scripted-issue-publishing.md)已延期。未来启动需先实现与独立review，再取得测试仓库/合成公开内容授权；不为消除本行状态而提前建单。 |
| <a id="live-ops-maintenance"></a>**LIVE-OPS-MAINTENANCE**<br>自动维护屏障与交接 | 未运行；`blocked`。 | 原生 admission fence/排空、提出者及子任务终结后唯一 controller 执行；busy/审批/新任务/撤销/换代拒绝；一次对齐/安全退出及未知退路。 | [T47](T47-bounded-ops-diagnosis.md)/[T48](T48-low-risk-host-qualification.md)/[T49](T49-policy-host-maintenance.md)/[T50](T50-template-ops-release-proof.md) 实现与 review 前置。W17 人工 force 不证明自动维护屏障；idle 采样不替代 fence。 |
| <a id="live-ctx-adoption"></a>**LIVE-CTX-ADOPTION**<br>默认本地维护策略真正加载 | **成套采用与modeld换代子项已证，含5f2afdb新修复。** CTX-V8使用已合入v2的 `6fb4b48`：config2→3到retired、前次manifest/模型字节保留、精确profile、custom Host和wire8/expected8 ready；普通retry off；原desktop偏好恢复，测试Bot清理后models回到原始字节。 | 真正主请求对本地策略的captured使用、运行中的root维护调用、原版App以及完整独立review；CLI↔modeld兼容不自动证明每个Host执行路径或native存储事务。 | `blocked`：加载本身不再待做，不为消除状态重复迁移/重启。真实send与context查询被工具安全检查拦截，后续原故障Bot只读核对仍受阻；补丁5f2afdb已有64+11项组合证明和2256/0全库，随后从集成v2 `6e88991`正式采用；新Host marker=77dcf653…、modeld新epoch/ready/active0、models原字节不变。已验加载不再重跑，真实Bot查询仍被拦截，保留review缺口。[补丁采用§9](../reports/2026-09-17-context-v8-live-window.md#9-后续补丁采用5f2afdb-原生不确定提交保护)。后续使用正常可用的已授权消息/状态入口，保留review缺口。[CTX-04](CTX-04-context-entrypoints-and-proof.md) · [CTX-V8 §5–7](../reports/2026-09-17-context-v8-live-window.md#5-实际迁移与成套加载) |
| <a id="live-ctx-next-input"></a>**LIVE-CTX-NEXT-INPUT**<br>已失败长会话下一条普通输入 | **真实旅程未闭合；非部署问题。** CTX-V8测试Bot创建confirmed_box，主模型和Grok/high的下一TURN配置均保存/读回，但send被工具拦截、无accepted回执，outcome为unknown/无echo。新增真实SDK/Unix离线用例已证明摘要503与主请求503后显式换模型的新消息能继续，旧失败回执保留、无隐藏切换。 | 原业务长会话的新输入、真正native compact/checkpoint及随后主请求、原App输入/活动/Working/交付；端点200、配置保存或离线fixture不能代替。 | `blocked`：等待正常可用且获授权的消息执行/原App观察入口，不绕过工具拦截，不复用本次nonce或重放旧事故STEP。测试Bot已删除；后续固定新窗口/对象及费用。独立review仍单列。[CTX-04](CTX-04-context-entrypoints-and-proof.md) · [CTX-V8 §4/6](../reports/2026-09-17-context-v8-live-window.md#6-备用选择发送拦截与资源清理) |
| <a id="live-ctx-durability"></a>**LIVE-CTX-DURABILITY**<br>新维护 checkpoint 的重启与退路 | **真实v8 modeld replacement已证，native compact checkpoint未证。** CTX-V8用正式expect-epoch/confirm命令换代，新服务ready/active0、旧请求不重放、Host未被该replacement重启。原有十轮/新进程临时store和原生方法隔离证明保持各自范围。 | 先有一次真实成功compact，才能验证其archive/carrier/checkpoint被新Host读回；还缺实际ACK丢失/取消提交对账、后续工具/Memory/App与官方退路。新修复5f2afdb的manual facade/Unix/SDK六分支及checkpoint清理等待已离线通过，补丁已实际加载；仍无真实成功compact及其原生存储故障回执。 | `blocked`：依赖[NEXT-INPUT](#live-ctx-next-input)的消息入口与真实compact，不是再任意重启一次即可关闭。保留原schema退路和全部unknown，不删ledger/原历史。[CTX-02](CTX-02-host-context-maintenance.md) · [CTX-04](CTX-04-context-entrypoints-and-proof.md) · [CTX-V8 §7](../reports/2026-09-17-context-v8-live-window.md#7-真实modeld重启与证明上限) |

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

<a id="window-context-v8-20260917"></a>
## CTX-V8 增量窗口 · 2026-09-17 UTC

固定runtime `6fb4b48`，profile/制品、显式config3迁移、custom Host/wire8采用、一次正式v8 modeld replacement、真实端点503与备用200、单测试Bot配置及清理见[日期回执](../reports/2026-09-17-context-v8-live-window.md)。新增测试 `b77ceb0` 和测试稳定性 `3ec15c3` 不改变该已加载runtime；后续文档/测试提交不要求无意义重启。模型和config非schema字段最终恢复原值；旧Bot未改、未重放。

本窗口没有accepted的真实Bot消息，send/context工具被安全检查拦截；后端直接端点调用不算原生Host旅程。[补充失败/控制链证据](../reports/2026-09-17-context-provider-failure-evidence.md)保存后续5f2afdb修复、真实manual边界测试、所有工具阻断及全库结果；5f2afdb在后续独立采用中已从v2加载，见[补丁窗口§9](../reports/2026-09-17-context-v8-live-window.md#9-后续补丁采用5f2afdb-原生不确定提交保护)；不倒写覆盖原6fb4b48阶段回执。review 503/备用review timeout仍未闭合。原App与native checkpoint/restart范围保持not-observed，不能把部分现场子项写成整条passed。现役状态不保证持续不变，下一窗口先重新读取身份。

<a id="window-20260917"></a>
## W17 历史窗口与证据索引

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
