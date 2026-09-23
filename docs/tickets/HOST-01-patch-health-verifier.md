# HOST-01 · Host 补丁健康识别与 Rust/Oxc 验证内核

**状态：实施中。** 核心配方、有限原生 ABI、实际编译回执、原引用及 managed 主流 lease 机会已进入原管理/故障链。当前接纳元组以源码 `native-checkpoint-pair.ts` 为准；每次实际验证的输入、结果和限制保存在日期报告，不把报告中的“当前”外推到以后。核心交付不代签全部能力覆盖、现役加载、App 或真实采用；独立告警出口仍由原责任票推进。

## 目标、已定架构与最终边界

面向重建中的管理Server，准确区分磁盘配方、静态语义、实际加载、原函数引用、真实调用机会、观察链与投递链。不把一次parse、固定fixture或profile保存当成完整健康。

唯一设计指向[健康方案](../roadmap/host-patch-health-proposal.md)和其[协议/包布局](../roadmap/host-patch-health-proposal.md#package-layout)；[跨会话交接](../roadmap/host-patch-health-integration-handoff.md)保留原始整合背景。TS的`applyPatchProfile`仍是唯一变换，Rust/Oxc通过已确认的Node受管stdio/只读FD分析有限快照；Rust不控制Host、不读写业务库、不调用模型。沿原provenance、OBS incident/outbox、共享client/CLI/Web推进，不另建parser回退、profile writer、controller或监控数据库。

**最终新版仅保留现行实现与合同。** 旧入口/双writer/旧格式实时兼容/拒绝型旧executor残骸要在必需行为迁移后退出，不能为了历史测试恢复旧路径。资料、未决外部效果与原操作记录仍须保全，不自动清空或重解释成当前成功；保全不要求实时合同继续接受旧版本。此用户要求也记录在[Agent入口](../../AGENTS.md)。

## 当前实现与资格

| 层 | 已实现范围 | 不能由此推导 |
| --- | --- | --- |
| 当前作者配方 | [单一HOST_RECIPE](../../packages/box-runtime/src/internal/host/source-recipes.ts)，39+3+19片完整有序apply；默认作者、能力升级、envelope及诊断共用 | 自动审核、任意新源码资格、实际采用 |
| Rust静态 | `session.main-binding@2`、`retry.turn-guard@2`、`context.checkpoint-await@2`、`context.lease-finally@1`；实际symbol/有限CFG/原生角色与同步资源helper ABI | 一般跨函数/heap别名、任意动态registry、所有外部异步工作已结束 |
| 跨语言制品 | 原Node→只读FD→正式Rust binary；严格schema/attempt/digest/有界输出与实际child close；lock/toolchain/schema/源码进入build身份 | parse或报告到达等于资源已释放、运行时联网下载资格 |
| 有限原生ABI | [当前唯一元组](../../packages/box-runtime/src/internal/host/native-checkpoint-pair.ts)，原schema/AgentStore/worker事务、完整图、prepare/marker/GC屏障、重启/B2、startup/duplicate/disposal隔离验证 | 主Host整入口、真实账号/Provider/App或完整恢复已经验收 |
| 运行编译 | 原Module._compile正负结果，准确PID/start/UID/exe/argv/root/target；磁盘与加载分代 | 编译成功就是挂接/调用成功；源恢复可以修复旧运行代 |
| 原引用与机会 | 赋值点固定原函数/方法；真实challenge前后核运行代；managed主流入口从原compact registry直接查lease；同代有界累计保留首次missing | 所有consumer都用了hook、没有记录就是bypass、同代后续成功可以抹去已知失败 |
| 管理与监控 | Server Scope采样/分析/入库分离；dirty+hash backstop；原provenance序列/持久OBS/幂等condition/outbox；`system host health`、`/host-health` | 页面关闭停止采集、未知来源自动健康、投递自动授权 |

实时健康只接受host-health-v2和witness v2，持久analysis同时核对现行完整id/revision集合。旧合同或不匹配记录保留原字节但拒绝充当新证据；不会减少必需项或自动迁移成成功。旧Host元组和按SHA挑选历史配方的分支已退出，未知Host不回退。正式非受管Bot的原生passthrough是现行产品行为，不是旧grokbox兼容路径。

## 核心接缝交付合同

本节是A1交付R/D/E/F等消费者的核心调用合同，不增加第二套类型、writer或运行路径。维护模块在`packages/box-runtime/src/internal/host/`；以同一构建、精确Host/worker/candidate及完整有序recipe作为来源身份。下表Symbol均带`grokbox.box-runtime.`前缀，`v1`指现有Symbol/RPC协议版本，不能单凭版本号跨来源接纳；固定摘要与可执行观察见[核心ABI窗口](../reports/2026-09-22-current-host-core-abi.md)。

| 接缝 / 现行模块 | 当前合同、身份与结算 |
| --- | --- |
| 主session：`live-slices.ts` / `profile.ts`，`route-session.v1` | 先构建原session，再同步交给hook：`{originalSession, sessionOptions, agentId, onRequestId}`。返回`undefined`才decline至原session。原主调用提供`agentId=host.getConversationId()`、`invocationId=inferenceRequestId`、`clientNonce=options2.clientNonce`，保留原model/executor选择；不是从全局“最后一个Bot”推导身份。 |
| 工具：`live-slices.ts` / `run-observation.ts` | 原`executeToolCall`以`ctx.get(requestIdKey)`、当前`invocationId`和`callId`建立观察，再在原Promise成功/失败路径调用`finish(true/false)`。观察器异常不得替换原结果或原错误对象，也不能证明未观察的工具已被拦截。 |
| 辅助：`live-slices.ts` / `profile.ts`，`host-aux.v1` | 仅实际`extractMemories`与`summarizeEpisode`调用点给出`memory-extraction`或`episode`，传原executor、turnId及ctx；受管session绑定已完成父STEP的选择。hook不存在或decline保留原executor；不伪造主session身份，不把空输出当作模型资格。 |
| Compact：`live-slices.ts` / `context-slices.ts`，`host-compact.v1` | 原STEP开始provider请求前注册原root/ctx/stateHandler、invocation/turn/agent及工具/固定消息回调。lease是同步`Symbol.dispose`资源，preflight需await；原STEP finally负责关闭。`contextCheckpoint`先await原`computeNewStructure(ctx)`，再await原`onStateUpdate(ctx, structure)`；不能用持久marker替代await链。 |
| Checkpoint / worker：`native-current-state-owner.ts`、`native-checkpoint-worker-hook.ts`、`native-checkpoint-worker.ts` | `native-current-state.v1`注册原store/metadata/ctx/rootId/source及存活条件；`checkpoint(agentId, original, store)`核同一store和prepared屏障，await原writer后记录revision，失败仍释放in-flight计数。worker协议1仅接受`capture/compose/prepare/apply/observe/release`及版本1的回包；Host/worker准确配对，原事务、receipt、GC fence与reopen/readback维持各自职责。 |
| 身份/权限：`ownership-read.ts` / `native-current-state-rpc.ts` | `ownership-read.v1`只从原凭据owner取得有限Server/local/scope事实，scope只输出摘要。`grokboxCurrentStateControl`为认证Gateway上的有限RPC；变更必须confirm、同scope/expected head及实时managed Box归属复核；caller的保护策略controller仍拥有授权，不由transport代签。读取、静态分析和prepare不是startup许可。 |
| 错误/读回：`profile.ts` / `native-current-state-owner.ts` / `native-checkpoint.ts` | managed failure保留原错误且在内外retry边界终止；未受管原生retry/passthrough保留。持久root、原store内存、完整引用图、worker应用receipt与原操作身份必须分别核对。写后失联或revision回执失败为`commit_unknown`，清理失败为`cleanup_unknown`，不得重解释为无写入或可任意重派。 |

材料/Project原生writer扩展、退役删除接缝不由本合同宣布已交付。单个Symbol存在、原函数可调用、四项静态规则通过或checkpoint读回，均不补全`uncoveredSlices`、真实工具权限或外部效果证明。消费者在Q合入同一v2候选后复验自己的依赖；Linear的A1/A2/A3关系是排程权威。

## 持续来源演进与资格窗口

Host/worker 的持续更新是开发期狗粮输入，不是外部异常，也不要求上游停更。区分**已验证的固定候选**与**此刻观察到的安装来源**：合流/Issue签收绑定实际验证的源码、依赖、完整recipe/candidate和有限ABI；新的磁盘SHA只使旧证据不能代表新来源，不抹去旧窗口、不自动重开已完成的无关实现。

**AH-159 的窗口归原入口所有。** `scripts/qualify-host-health.ts` 与 `verify-host-health.mjs` 通过 `host-source-window.node.mjs` 共用有界私有副本；安装级读取与副本捕获共用 `stable-source-set.node.mjs`，不复制第二套稳定性判定。每次捕获核对完整SHA和文件身份，读取中替换或同size改写拒绝该窗口；成功捕获后的安装来源变化则仅更新 `freshness`，不撤销未被篡改的固定输入结果。副本键绑定source/worker/profile与依赖、recipe、候选选择、测试计划；最终静态资格键继续绑定实际candidate、checker build及schema。原生组内全部子进程继承同一窗口和预期键，独立原生SHA门不变；生产Host路径常量与加载保护不重定向。

副本父目录0700、文件0400，最多4个原子占用槽，主Host/worker各64MiB、profile 1MiB、manifest 16KiB；正常结束、失败或可结算取消释放本窗口及其测试临时目录。异常退出留下的占用不自动抢删，容量不足明确拒绝；人工核对原owner已退出后才清理。UUID及inode核对防止旧清理动作删除复用槽的新任务。此上限约束输入副本，不声称子测试的所有工作目录、进程内存或历史证据无限保留。公开回执只有摘要/有限字段；原路径只在私有manifest中，副本不成为已安装、已加载或已审核profile。

`runtime-kernel/host-source-evolution.ts` 是分类唯一合同。source hash变化、完整有序recipe失配（准确slice/code）、静态语义检查（id/revision/code）、显式原生ABI检查及未覆盖slice分别表达；未执行为 `not-run`，未评估覆盖为 `not-evaluated`。完整维护配方匹配不等于所选profile被审核；完整维护配方失配也不自动伪装成无关已选profile的故障。`source-change-needs-abi-proof` 不是功能回归，四项静态通过不关闭未覆盖项。静态producer不得携带原生ABI通过声明；显式原生组另报选定范围结果，退出/SIGKILL/skip本身不证明ABI退化。手动 `--reference-host-sha` / `--reference-worker-sha` 必须同时提供完整摘要，仅定义比较基线，不更改任何原生pin。

安装级producer继续采用一项运行、一项可替换待跑任务，取消过期排队而不抢占已运行的固定分析。完成缓存键包含source/worker/profile集合、完整recipe、checker build及必需检查版本；有界64项报告可从原provenance恢复，刷新只发现依赖变化，不清空同一完成结果。淘汰后重新检查是有界保留的代价，不承诺永久全局exactly-once；未完成的检测器失败保留原有有界退避。迟到完成进入原journal/OBS的 `sourceState=snapshot`，不更新当前 `latest`，不打开或解除当前condition；A→B→A重新发布当前观察但可复用A的固定分析。未引入第二套collector、监控数据库、parser fallback、profile writer或自动pin/adopt。

**问题回流仍由原Owner与Linear完成，不是运行时新建工单服务。** 先用source pair、recipe、slice/checker/ABI及实际失败范围定位；同一故障先查已有Issue并更新原回执，只有能复现且影响该消费者的缺口才新增修复/Blocks。单纯SHA变化、fixture误用、资源退出或未执行检查不冒充上游功能回归。已签收固定窗口保持Done，新来源的准确后续由对应Owner推进；A2评估可达风险，E1消费原健康/观察事件，Q采用门仍核对实际准备采用的版本与权限，不形成全局停更锁。该接口不自动授权外部Webhook、收费模型或用户Bot变更。

固定窗口实现与确定性/真实来源只读证据见[AH-159来源窗口回执](../reports/2026-09-23-host-source-windows.md)。固定证据另见[最初A1核心ABI](../reports/2026-09-22-current-host-core-abi.md)、[68fab3核心配对复验](../reports/2026-09-23-native-core-pair-requalification.md)、[日志测试原写入结算](../reports/2026-09-23-provider-fixture-journal-settlement.md)和[消息原生与来源演进窗口](../reports/2026-09-23-native-message-source-evolution.md)。历史失败/成功保留各自输入；不将来源哈希变化、配方匹配、仅注册原函数或fixture通过混称当前完整健康。材料writer缺口仍归DATA-01/A3，不借核心窗口复活已退出的Memory RPC。

## 后续实施顺序

A1核心来源合同之后，A2在原owner中继续补齐所声明必要能力的语义与变换后行为、更多独立调用机会，以及真实采用后同代证据；A3的新原生材料/退役接缝按各自依赖推进。`uncoveredSlices`必须真实列明；机会覆盖只到managed主流lease，不能凭函数名或注册表关闭全部能力。场景反例需合法JS且重新固定candidate hash，不得全靠unknown-sha或语法错捕获。

旧controller/inject拒绝型stub及专属测试/spy已经退出，安装preload也不再借用旧副本或回退TypeScript，见[控制入口退出](../reports/2026-09-21-controller-entry-retirement.md)。Tailscale/Serve的显式兼容路径、bootstrap旧writer/选项和JSON/schema占位也已经退出，见[NET-01](NET-01-box-local-network-boundary.md)。手动 compact 已接入同一管理 Server、原 Host/modeld 与 CONT 操作记录，明确 approval 字段进入当前原生 RPC/wire；旧 CLI 直连入口同步退出，见[当前管理切片](../reports/2026-09-21-compaction-management.md)。相关原生配方变化须重新验证，不借用旧 candidate 摘要。handover 控制也已进入管理 Server、原 CONT 职责与入站/退役 owner；旧 CLI 直连/适配别名和直接 attestation writer 退出，见[管理交接阶段](../reports/2026-09-21-handover-management.md)。退役对账没有 native port，不因一个新观察重新派发删除；原生资源独立性和删除屏障仍保持真实缺口。接续收束剩余 daemon 能力与全能力/调用机会资格，不重开已闭合的 Compact 或 handover 控制迁移。优先当前功能owner和准确依赖，不重做已完成的current-state、通知、材料管理等阶段，不另起平行工程。现行Acorn作者探索与Rust健康验证不是自动互相回退；是否仍需作者能力及其退出随原HCR迁移核实，不能仅删依赖而丢必需行为。

长期观察继续核对容量、源重启/变化、迟到结果、检测器退出和独立投递。当前通知显示local-only；接收Host处于同故障域时，不能为了投递放宽ownership/profile/model门，独立出口与凭据须明确授权。已有合法modeld执行不能被健康服务故障或Server关闭带倒。

最后随CLI-05形成完整候选，完成独立审查、正式安装宿主与生命周期、已授权原生/Provider/App验证。首个纵切或静态+ABI窗口不是完整交付上限。

## 责任与依赖

| Owner | 责任 |
| --- | --- |
| HOST-01 | Rust/Oxc、有限语义规则、当前合同及跨语言/制品一致性 |
| [HCR](README.md#host-capability-recovery)/[HCR-04](HCR-04-capability-profile-upgrade.md)/[CONT-07](CONT-07-current-context-control.md) | profile作者/实际加载/相关原生资格，保留唯一writer |
| [T44](T44-host-ops-continuous-sensing.md) | Server所属安装级producer、加载与检测器健康 |
| [T41](T41-continuous-observation-and-alerting.md)/[OBS-01](OBS-01-incident-intake-and-detection.md)/[OBS-04](OBS-04-bounded-observation-storage.md) | 原库intake、condition、证据、容量、去重与恢复 |
| [T45](T45-template-webhook-delivery.md)/[T55](T55-custom-receiver-delivery.md) | 原投递/接收者资格/同故障域与独立出口 |
| [T40](T40-persistent-release-and-rollback.md)/[T50](T50-template-ops-release-proof.md) | Rust与Node成套发布、正式宿主/退出/重启资格 |
| [CLI-05](CLI-05-implementation-follow-through.md) | W3依赖排序、共享入口、无旧兼容最终交付和W4候选冻结 |

无关纯HTTP/权限/回执/页面与材料迁移可以并行；compact/startup/原生恢复先核对应当前来源，不要求先完成全仓无关checker。采用或真实调用另核目标/授权；自动新profile派生、自动adopt和通用升级平台不是本票默认范围。并行VOICE规划是独立后续，不插队本阶段。

## 验证入口与完成边界

使用声明Bun1.3.14运行`node scripts/verify-host-health.mjs core`和`integration`。显式隔离原生测试使用`GROKBOX_TEST_NATIVE_CONTINUITY=1 GROKBOX_TEST_NATIVE_NODE=<native-node> node scripts/verify-host-health.mjs native-pair`；不再接受旧original/candidate选择器。只读磁盘资格通过`scripts/qualify-host-health.ts`的明确source/worker/binary-directory与candidate-recipe；它不发布profile或执行Host。`native-pair`现包含完整当前候选的Node/FD/Rust正反例及原生依赖摘要，拒绝skip充当通过；`GROKBOX_TEST_NATIVE_HOST=1 bun run test:native-host`复验核心原声明行为和只读副本，两个入口都不启动真实Bot。`native-host` 保留原28项用例与30秒单用例时限，按原文件分成六个顺序子进程，共享一份固定源；`core-risk` / `core-observation` 同样进入窗口owner，保留A2/E1原清单、授权及拒skip门。

R1原生运行消费者另以 `native-runtime` 组验证，要求同时显式Host与continuity opt-in以及原生Node。包含原summarizer/archive、AgentStore/原worker SQLite与独立新进程读回及模型选择/SDK继续执行；原配对检查不被此组替代，也不把各自外部隔离能力写成真实账号/模型/App事实。

公开测试独立于私人源；原生资格只在明确环境读取/隔离执行指定声明和自有worker存储。正常、缺口、合法语义破坏、source/loaded分代、同代原引用被换、首次采样前明细丢失、retain→intake中断、重启不重发、正证据恢复和child结算都须覆盖。现场验收只进入[LIVE](LIVE-integration-validation.md)对应Host/context/monitor/install等场景，不把报告存在写成ready。

关闭本票要求：必需检查无未声明缺口、必要负事件可进原故障出口、原生/静态/运行/投递事实不混、正式制品和消费者一致、Server/分析失败不干扰合法执行，且旧平行实现与实时兼容已退出。当前整体qualified=false，未授权的采用、模型费用或外部通知不随源码完成自动发生。
