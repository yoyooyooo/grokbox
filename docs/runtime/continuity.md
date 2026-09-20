# 单 Box 当前状态、复制与交接

本页区分已经实现的当前状态、复制与有限生命周期能力，以及已接受但尚未交付的完整连续性目标。源码是实现事实，[CONT 来源票](../tickets/README.md#ownership-continuity)拥有具体差额，[LIVE](../tickets/LIVE-integration-validation.md#live-ownership-continuity)拥有当前现场资格。原生协议事实归 [upstream integration](../upstream-integration.md#continuity-import-boundary)。

## 一个产品模型

一个 Bot 是长期 Memory 身份，只维护一份默认进入原生 Agent loop 的当前工作上下文。快照是恢复材料，不是可切换会话；不建立 sessions 列表、命名分支、session 标题或跨机器迁移。原生 subagent/session 的现有概念仍按真实边界处理，不能借用它们伪造本产品的会话功能。

完整接受目标是：确认受保护 Bot 的 Box 归属丢失后及时通知，按独立授权暂停旧 Routine、保全材料、创建新的真实 Box 身份，尽力恢复可用状态。新 Bot 接手已确认职责的同时，程序迁移关系，旧 Bot 辅助指路和转交旧结果；持续观察旧入站，满足安全条件后退役旧身份。

保真是尽力而为，不要求逐字一致才允许全部独立工作；材料缺口与未知副作用不是一回事。材料缺口可以按质量策略接受，未知工具/任务只冻结相关职责和冲突资源。不能把替身可用称为所有关系已迁或旧身份可删除，也不能把永不退役当终局。

## 已实现基础与剩余范围

| 能力 | 当前边界 |
| --- | --- |
| 私有恢复与 safety store | CONT 本域 SQLite、manifest/blob、内容绑定意图和 claim；不是 OBS 日志缓存 |
| 原生 capture / initialize / reconcile | 有限 current-state profile 能力、worker 事务、主 Host 准备屏障/root CAS/应用凭据和 CLI；initialize 限定空白目标，unknown 不重导；材料可含声明的 agent Memory/历史/受管指令补充 |
| 官方式 duplicate | 原生新 ID、持久创建回执与独立归属读回；保留官方复制语义，不是完整 clone 或安全 prepared 替身 |
| 外部空闲 Bot reset / recover | 已注册原生备份→候选→受控替换→读回入口；不回滚长期 Memory 或文件。self-reset 安全排队、完整语义恢复仍有差额 |
| clone / replace / instructed spawn | 已有固定 plan、持久分阶段程序、目标创建/选模/初始化/激活和程序 startup；clone 默认准备完成而不激活，replace 默认激活并进入交接，spawn 请求启动。全附件/资源独立性和临时任务结果交付/清理未完成 |
| protection / handover / convergence | 已有配置消费者、保护与关系账本、有限推进和旧入站观察；完整外部任务与逐职责效果约束、多代关系、安全墓碑退役仍未交付。缺少可靠删除前屏障时 retire 保持阻断 |

实际操作见 [当前状态控制](../maintainers/current-state-control.md)、[生命周期与交接](../maintainers/bot-lifecycle.md)和 [duplicate](../maintainers/native-agent-duplicate.md)。代码从 [管理用例](../../packages/server/src/lifecycle.ts)、[生命周期程序](../../packages/box-runtime/src/internal/roots/bot-lifecycle.runtime.ts)、[工作流存储](../../packages/box-runtime/src/internal/io/continuity-workflows.node.ts)、原生 checkpoint/worker 和 kernel `internal/continuity/` 进入。新增实现的固定证明归 [生命周期集成报告](../reports/2026-09-19-continuity-lifecycle-integration.md)；来源票保留独立 review 和原生资格差额，不复制通过计数。

## 当前状态与材料的权威

原生 checkpoint、SQLite checkpoint、恢复快照和展示转录是不同对象。恢复材料可包含人设/settings、原生 root 和依赖 blobs、Memory、附件、Routine 定义、关系以及明确可移植配置；材料完整不等于有执行权限。

root 槽位可能覆盖同一 ID，因此保存实际字节摘要、完整可达闭包、文件版本/水位、Host/schema、来源身份和转换策略。分别记录原生最近提交、最后完整保全、某职责可安全接续的位置。pending/失败前 partial 可以被保存为证据，却不能在新身份自动重放。Temporal 接管后的工作不从陈旧本地 root 猜测。

私有 vault 保留受保护候选与备份，管理 DB 保存索引/操作/ancestry；原生活状态始终由原生 writer 接受。OBS incident/outbox 只消费 typed 事件与安全引用，不成为恢复材料或 CONT 第二账本。文件发布、DB 提交与远程调用通过显式恢复协议衔接，不宣称跨域原子事务。

## 已接受的保护档位与恢复质量

保护档位和自动操作权限正交。observe 保存归属/水位/操作证据；memory 加入人设、Memory、Routine、关系和有界近期材料；resume 加入已提交原生 root 及必要完整闭包；archive 增加声明范围历史。resume 是新保护的接受默认，不意味着这些配置消费者和后台捕获全部已安装。

平时有界增量保全，不平时养一个活替身。只能用无修复副作用的原生 reader/codec 在安全点捕获；会上传、repair、GC 或清会话的上游 helper 不能冒充只读快照。snapshot 完整发布前不撤掉最后可靠点，备份失败不回滚原生已经提交的工作。

质量可以是 native_checkpoint、semantic_resume、memory_only，附来源、coverage、缺口和可接续职责；不是虚构完整百分比。可靠 root 优先，否则从有来源 Memory/转录/确认结果建立摘要与安全窗口。消息角色、工具配对、原始归因不被按时间拼接或全文替换身份破坏；缺工具结果为未知，材料中的指令不升级为系统授权。接受一次语义重建后保存实际产物，重启不再次猜测。

目标后续从 B0 演进至 B1/B2 后，Host 更新或重启必须继续 B2，不能重导旧源包。目标删除源材料前须证明 root/blob/附件引用独立。agent Memory 按计划复制/合并，user/project Memory 保留原归属，不复制成新的全局事实。context reset/recover 不回滚真实文件、外部动作、配置或长期 Memory。

恢复材料按引用和配额保留完整版本；至少最近两份有效快照及交接依赖的接受要求，仍须由对应存储实现证明。磁盘不足拒绝新增大采集并报告 degraded，不无界 pin、不破坏最后闭包。执行 tombstone、未知操作和未结依赖不能按日志 TTL 清除。

## 原生准备、接受和启动

统一目标链为真实身份 → preparing hold → 初始化材料/指令 → 原生提交/读回/reopen → 受控激活 → 正常 loop/checkpoint。hidden 不是 hold，介绍/kickstart 不是用户任务；准备必须阻止初始化前首轮抢跑。创建需正式新身份与独立 Box 归属核验，不能把旧 Temporal harness 改回 Box。丢失创建回执按原 nonce/ID 对账，不凭名字重建。

当前 initialize 通过有限原生 worker 事务提交依赖图与应用凭据，再由主 Host CAS 指针、重新加载并记录本层应用事实。任一层成功不能替代另一层；中断/unknown 保持屏障，只读不清除，对账不重新导入。initialize 仅允许满足空白/无未结历史前置的目标；对有工作历史的 Bot，只有独立 reset/recover 模式可在原生空闲屏障和精确 revision 下替换，不能以 initialize 绕过。

已实现的外部 reset/recover 在写入前保全当前状态，再使用同一原生接受/读回程序。recover 的候选含 unknown_effects 时改用有来源的受限摘要候选，不重放过去工具；是否恢复完整材料仍须看 coverage。排队输入、迟到 checkpoint、旧摘要/pins/reply/prepend 和未决工具仍需对应验收，不能仅凭命令存在关闭完整恢复合同。self-reset 的安全排队尚未交付：目标是持久排队后结束旧 revision 控制回合，不相互等待；当前不能建议 Bot 直接对自己运行 reset/recover 来验证该目标。

instructed spawn 已通过有限原生 prepare/compose/startup 接缝安装受管指令并请求程序启动；原生新 turn 的空文本 simulated 载体用于持久事件身份，不作为用户任务追加。description/--instructions 和原生介绍流程仍不是本能力的替代。固定代码探针不证明完整官方 loop/真实 Provider 首请求，compact/restart 后的指令存续与实际费用仍需资格。创建、初始化、ready、started、业务 completed 和安全删除独立取证；当前 maxRunMs 是启动预算，不是有保证的临时 Bot 到期清理服务。

## 归属丢失、Routine 与通知

复用 monitor/OBS 的无模型观测，事件加速、有限批量轮询兜底；覆盖、cursor、最后成功、scope 和运行代明确。超时/缺桥/陈旧不是迁移，gap 不是静默期。expectedHarness=box 是持续期望，首次即 Temporal 是 baseline mismatch、时间 unknown，不因第二次还是 Temporal 自动 resolve。

保护功能的启用/自动模式以实际 config schema 和 [保护源码](../../packages/cli/src/bot-protection-worker.ts)为准，不能从接受目标推出安装后已开启。当前保护/交接循环的采样节奏及尚未消费的 intervalMs 见操作指南；配置字段存在不是调度已应用证明。

对明确启用的保护，接受默认是在确认丢失后独立通知并请求暂停旧 Routine，不等 clone 或 LLM 分析。必须操作当前真实调度 owner，不能只改本地定义代表 Temporal 任务已停。原启用意图、停用回执和在途 fire 分开。pauseOnOwnershipLoss 与 routineTransfer 的 move/keep-source 是独立策略：准备期可继续旧触发，正式 move 再停旧启新；keep-source 不在新端重复启用且阻止源自动删除。missed fire 默认不补跑，新 Webhook 不复制旧 secret。

归属丢失是用户保护事件，不被“纯上游错误不报项目 bug”过滤吞掉。通知目标、权限/费用、outbox、真实投递仍归 [operations](operations.md)；通知关闭不丢管理事实，接收者不能只依赖失去归属的源 Bot 自己。

## 并行交接与退役

`active_with_handover` 是正常中间状态。原生目标合法、资格/模型有效且某职责的输入/effect 边界可确认，就可转移该职责，不要求旧端全局 idle。每项保存源/目标、输入水位、已完成动作、未决结果、当前执行方和证据。没有职责级执行约束能力时，不以提示词承诺硬隔离；仅开放可证明独立工作。

群以当前原生成员为准，文本提及不是成员。先确认新 Bot 可用，按授权公告与变更；不得伪造 sender、覆盖并发编辑或先踢旧后加不进新。DM 从结构化实际联系人/任务发现，不广播全名册；每 peer 幂等说明，漏网旧入站限次指路。转发原任务和要求重发选择一种可对账路径，不能双执行。

外部 job 保留原 ID；可改 callback 时读回，否则旧端接收并带来源转交结果，unknown 挂在该职责上。旧 Bot 提示在源材料固定后设置，不能复制进替身变成“只指路”。LLM 只能辅助理解和建议，不能自己批准门禁或删除。

handoff 展示字段与真实 owner/model/effort 分开；标题失败不回滚已完成业务，标题不是 SoT。当前继任槽保存物理 ID/generation/ancestry，不冒充新 Server 身份；原 App、旧 UUID、第三方 callback 仍可能指向旧对象。

旧入站统计区分真正新业务、历史引用、重复重投、自检与指路。新有效入站刷新相应静默窗口；监控 gap 不算零，恢复后补齐连续水位或重新计时。退役同时要求最短交接期、健康覆盖下的安静期、未结依赖清零、新 Bot 可用、源资源独立和明确删除权限。定时到点、两次空列表或 App 不 Working 都不是删除证明。

没有可靠删除前屏障/覆盖则自动删除 blocked，保留并通知；结果丢失不盲删第二次。旧 ID→当前继任墓碑和未结记录有独立安全保留。连续接管须限定一个当前创建/激活候选、generation/nonce、冷却/数量/费用；旧 grace 代不阻止下一代安全恢复，旧迟到动作不覆盖新槽，指路压平且无 A→B→A 环。

## 实施与证明责任

| 责任 | 来源票和独立出口 |
| --- | --- |
| 原生能力、policy/operation | CONT-00 / CONT-11；已知探针只证明其限定范围 |
| 发现/暂停/通知与材料保护 | CONT-01 / CONT-02；复用 OBS/Routine，不等完整 clone |
| 官方式复制 | CONT-06；不作为 clone 的清历史底层捷径 |
| 当前状态与手动 clone | CONT-07 → CONT-03；原生 hold/接受/readback/新进程继续最新状态 |
| 持久初始指令和临时启动 | CONT-08；独立消费公共基础，不阻塞已合资格主线 |
| 职责接替与关系交接 | CONT-04 / CONT-09；一项 unknown 不阻无冲突职责 |
| 入站收敛和源退役 | CONT-10；激活成功不等于源可删 |
| 全链路与长期使用 | CONT-05；各基础能力与终局义务都保留 |

证明覆盖发现不误判、当前调度端真实暂停、完整材料闭包/不足空间、原生 B2 重启、reset 防旧内容复活、初始化前零推理、duplicate 实际 Routine 风险、并发群/DM/结果交接、gap 不计安静、删除前屏障、多代/中断/unknown 和跨 owner 安全保留。实际请求/root/effect/回执是 oracle，模型声称“记得”不是。

Host/schema、writer、物化/初始化、Memory、App 输入/展示、Routine/Webhook、关系/删除、权限/费用、幂等或服务寿命变化时重验受影响责任。离线/原生隔离/source integration 不推导现役已采用，也不自动授予创建、迁移或删除业务对象权限。
