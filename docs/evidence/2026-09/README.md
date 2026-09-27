# 2026-09：固定实验与验证窗口

这里保存各次实验的原始时间与结果范围。跨窗口问题从[主题导航](../topics/README.md)进入，完整目录在本文末；当前现场状态仍以 LIVE 为准。

- [2026-09-23 Provider fixture 日志结算](2026-09-23-provider-fixture-journal-settlement.md)：受控锁反例证明终态文本可见不等于原写入结算；修复测试等待并保留生产 partial 判定，不代签原生消息资格。

- [2026-09-22 self-reset 队列与消费程序验证](2026-09-22-self-reset-queue.md)：C1 的登记、消费阶段、材料引用与 GC 保护；明确 A3-C2 原生 safe-point 接通仍未证明。

- [2026-09-20 旧 Host 补丁健康链审计](2026-09-20-host-patch-health-chain-audit.md)：限定旧逻辑，核对字符串/Golden/AST、watchdog实际入口、来源事件到incident与通知资格；89项隔离检查包含4个缺口反例，不签持续感知接通或现场告警送达。

- [2026-09-20 Grok Bot 上游版本影响](2026-09-20-grok-bot-upstream-impact.md)：App 0.47→0.57.1、磁盘 Host 0382fa8 与当前工作树的接口/切片核对；记录 Memory 回退、idle compaction、旧回放资格失效及 53 项隔离回归，不签当前进程、模型链路或部署。

- [2026-09-19 本机原生来源只读资格](2026-09-19-live-source-qualification.md)：4 次有界元数据请求与目录/stat；记录 ownership 响应缺字段，不签部署、材料写入或模型 E2E。

- [2026-09-19 上下文债审计](2026-09-19-context-debt-audit.md)：反例、删减、代码简化与未证边界；不签整库或当前部署。

固定报告保留各自源码/窗口、失败与未证范围，不维护另一份当前进度。跨窗口的设计和研究解释归[主题证据](../topics/README.md)；需要继续被 LIVE 引用的回执在同一 evidence 根下按日期保存。

- [2026-09-19 网络边界合入 V2 与合入后复验](2026-09-19-network-boundary-v2-integration.md)：线性提交映射、固定 V2 上的网络/CLI/文档/安装包验证与实际退出码；代码已集成不等于现场或独立审查通过。

- [2026-09-19 文档合入 v2 与源码对齐](2026-09-19-documentation-v2-integration.md)：快进集成、保留并行生命周期/LIVE 变更、补齐指南与旧入口收敛，记录联合回归和 CONT-01 单页未落盘边界。

- [2026-09-19 文档收敛切片](2026-09-19-documentation-convergence.md)：合同与按需入口重整、归档及验证；明确保留两处未成功写入、全仓测试超时和同期 v2 继续前进的基线差异，不宣称全部冲突已清零。

- [2026-09-19 连续性候选集成证据](2026-09-19-continuity-lifecycle-integration.md)：生命周期/保护/交接的限定验证、原生启动反例修正、材料引用GC和仍未完成的源码/文档项；不是现场通过或完整产品交付声明。

**当前现场已验/未验、阻断与下一步只看 [LIVE 唯一索引](../../tickets/LIVE-integration-validation.md)。** 本目录报告固定在各自窗口结束时，不随后续推进维护当前状态；报告中的未验清单只说明当时缺口。

- [2026-09-19 官方式duplicate](2026-09-19-native-agent-duplicate.md)：明确预检/确认、持久创建ID、未知不重建、原生语义及独立Node恢复；最新v2上的37项专项、3项原生和136项交叉回归，未操作真实Bot，不是完整clone。

- [2026-09-19 原生当前状态接线](2026-09-19-continuity-native-binding.md)：真实原生worker/SQLite事务、主Host准备与应用记录、有限CLI/RPC、70项基础与22项原生资格；记录分组回归、两项竞态修正与未进行live采用的边界。

- [2026-09-18 原生checkpoint格式](2026-09-18-continuity-native-checkpoint.md)：固定Host/worker的原生引用图与AgentStore、严格全图读回和独立进程；不等于真实业务Bot初始化。

- [2026-09-18 唯一当前状态协调](2026-09-18-continuity-current-state.md)：capture/initialize/显式对账、原始归属证据复核、105项组合与Node强杀/B2不重导；使用真实CONT存储及owned合成原生端，未安装官方Host绑定或验证真实Agent loop。

- [2026-09-18 CONT真实恢复材料与操作安全记录](2026-09-18-continuity-recovery-store.md)：CONT-02/11首个真实持久消费者、J1引用/过期接线、固定Bun/Node20的114项组合与owned进程硬崩；未接原生Bot捕获/导入、配置自动采用或live。

- [2026-09-17 CTX v8 现场窗口](2026-09-17-context-v8-live-window.md)：config3/wire8成套采用、真实503/备用200、测试Bot选择及清理、modeld replacement；保留真实消息入口和原版App未证范围。

- [2026-09-17 CTX 503与控制链补充证据](2026-09-17-context-provider-failure-evidence.md)：显式下一TURN备用、profile recipe修复、manual控制六分支、checkpoint未知/迟到清理与队列阻断修复；不以端点200冒充原生会话通过。

- [2026-09-17 本地上下文维护离线收口](2026-09-17-context-maintenance-offline.md)：Pi受控复用、config3/wire8、旧失败会话输入前维护、Node20十轮/新进程、连续迁移与TURN凭据/生命周期修复；区分源码/原生隔离和独立review503，不冒充现场已部署。

- [2026-09-17 现役集成窗口](2026-09-17-live-integration-window.md)：统一配置真实迁移、v7 成套加载、12 条有界 canary、改档/工具/重启与 stock 回程；记录现场发现的 Host 重复 apply 缺陷及修复、最终验证、清理和仍未证明的范围。不是全部 LIVE 或独立复审通过。

- [2026-09-17 Modeld 线性合入 v2](2026-09-17-modeld-v2-integration.md)：记录原提交到变基提交的完整映射、保留既有 MiniMax/投递修复的冲突处理、组合树验证及 LIVE 状态更新；源码集成不代表复审或 live 发布通过。

- [2026-09-17 Modeld 非 live 收尾](2026-09-17-modeld-effect-core-closeout.md)：固定候选的单一期限、最终类型/全库/制品验证、基线重跑、外部复审失败回执，以及跨 worktree LIVE 票；不是 live 发布成功证明。

这里保存已经发生、仍有解释价值的审阅/实验背景，不保存未来任务或当前运行状态。版本、时间和未证项必须明确；报告不授予实现/部署权限；报告、Spec与原生来源的断言都须按其实际输入和执行证据核验。

- [2026-09-17 Modeld 执行核心离线验证](2026-09-17-modeld-effect-core-offline.md)：固定提交与构建指纹、完整回归、真实生产程序上的合成延迟/取消对照；明确普通请求未证明普遍提速，以及 typecheck、外层超时、独立复审与原生发布的剩余门。
- [2026-09-12 Managed Compact演变](2026-09-12-managed-compact-evolution.md)：合并旧owner brief/technical path的背景与取舍，说明旧harness、Working、审批等待为什么不再有效；给出Git原文和回执引用。

历史 [orchestrator handoff](../../roadmap/2026-09-12-orchestrator-handoff.md)保留旧路径，不作为当前执行指令。功能合同走 [Spec](../../roadmap/box-runtime-impl-spec.md)，实现/离线/review 走 [Tickets](../../tickets/README.md)，当前现场进度只走 [LIVE](../../tickets/LIVE-integration-validation.md)。不能从旧 handoff 恢复 worker、test2 heavy 或 GATE 权限。

私有Host/App dump、真实历史和凭据不进公开报告；已有私有receipt是否仍存在需实际检查。未来候选在[roadmap/future](../../roadmap/future/README.md)，不要把历史未完成列表直接当future已排期。

## 全部固定窗口

- [Managed compact evolution — historical route](2026-09-12-managed-compact-evolution.md)
- [配置重建与运维 Spec 的 v2 线性集成回执](2026-09-17-config-ops-v2-integration.md)
- [2026-09-17 — 本地上下文维护实现与离线收口](2026-09-17-context-maintenance-offline.md)
- [2026-09-17 — CTX 503 对照、显式备用模型与加载接缝修复](2026-09-17-context-provider-failure-evidence.md)
- [2026-09-17 UTC — CTX v8 成套采用、503 与备用模型验证](2026-09-17-context-v8-live-window.md)
- [2026-09-17 — v2 live integration window](2026-09-17-live-integration-window.md)
- [Modeld core: deadline closeout and deferred live acceptance](2026-09-17-modeld-effect-core-closeout.md)
- [Modeld execution-core: fixed-candidate offline results](2026-09-17-modeld-effect-core-offline.md)
- [Modeld core — linear integration into v2](2026-09-17-modeld-v2-integration.md)
- [同通道推理设置的 v2 线性集成回执](2026-09-17-reasoning-v2-integration.md)
- [AH-99 / AH-100 — 统一配置实现与验收收口](2026-09-17-unified-configuration-closeout.md)
- [唯一当前状态：捕获、初始化与中断对账 · 2026-09-18](2026-09-18-continuity-current-state.md)
- [原生 checkpoint 闭包捕获与严格读回 · 2026-09-18](2026-09-18-continuity-native-checkpoint.md)
- [CONT 真实恢复材料与操作安全记录首个实现切片 · 2026-09-18](2026-09-18-continuity-recovery-store.md)
- [默认禁用 Routine 创建、持久回执与精确对账 · 2026-09-18](2026-09-18-disabled-routine-provisioning.md)
- [显式单次原生通知发送 · 2026-09-18](2026-09-18-explicit-native-notification.md)
- [HCR — Host 能力与中断恢复离线回执（2026-09-18）](2026-09-18-host-capability-recovery-offline.md)
- [journal 配置采用、受管维护与死 writer 恢复 · 2026-09-18](2026-09-18-journal-policy-and-lock-recovery.md)
- [modeld 写入端日志轮转与独立存储取证 · 2026-09-18](2026-09-18-modeld-process-log-rotation.md)
- [modeld 生命周期内存储维护与诊断占用计量 · 2026-09-18](2026-09-18-modeld-storage-lifetime.md)
- [原生 Routine 管理首个切片 · 2026-09-18](2026-09-18-native-routine-management.md)
- [单目标策略、事务化通知与固定现场 · 2026-09-18](2026-09-18-notification-outbox.md)
- [故障证据首个实施切片 · 2026-09-18](2026-09-18-observation-evidence-first-slice.md)
- [故障证据、SQLite容量与采集调度增量 · 2026-09-18](2026-09-18-observation-storage-followup.md)
- [私有目标配对准备与撤销 · 2026-09-18](2026-09-18-private-target-pairing.md)
- [接收者自动任务选模预检 · 2026-09-18](2026-09-18-receiver-model-preflight.md)
- [共享存储意图、配置 schema4 与局部 owner 采用 · 2026-09-18](2026-09-18-storage-config-v4.md)
- [结构化 journal 分段、游标接续与固定证据 · 2026-09-18](2026-09-18-structured-journal-rotation.md)
- [Agent-first CLI 多视角审查](2026-09-19-agent-first-cli-review.md)
- [Agent-first CLI 与 Web UI V0 文档基线回执](2026-09-19-agent-first-design-baseline.md)
- [自动通知执行与 v2 交叉整合回执 · 2026-09-19](2026-09-19-automatic-notification.md)
- [2026-09-19 context-debt audit](2026-09-19-context-debt-audit.md)
- [2026-09-19 连续性候选的集成证据](2026-09-19-continuity-lifecycle-integration.md)
- [原生当前状态控制与 v2 集成 · 2026-09-19](2026-09-19-continuity-native-binding.md)
- [诊断联合容量接纳与过期证据退役 · 2026-09-19](2026-09-19-diagnostic-admission.md)
- [2026-09-19 — Source-first documentation convergence slice](2026-09-19-documentation-convergence.md)
- [文档收敛合入 v2 与源码口径对齐 · 2026-09-19](2026-09-19-documentation-v2-integration.md)
- [2026-09-19 — Live E2E清单重整回执](2026-09-19-live-e2e-checklist-rebaseline.md)
- [2026-09-19 本机原生来源只读资格核验](2026-09-19-live-source-qualification.md)
- [官方式 duplicate 与持久创建事实 · 2026-09-19](2026-09-19-native-agent-duplicate.md)
- [NET-01：V2 线性集成与合入后复验](2026-09-19-network-boundary-v2-integration.md)
- [E2E 前置实现收口 · 2026-09-19](2026-09-19-pre-e2e-closeout.md)
- [E2E 前观测、持续采集与恢复接线 · 2026-09-19](2026-09-19-pre-e2e-observation.md)
- [Web UI 数据与原生客户端可行性研究](2026-09-19-webui-source-feasibility.md)
- [2026-09-20 Grok Bot 上游版本变化对 grokbox 的影响](2026-09-20-grok-bot-upstream-impact.md)
- [Host 同代注册与实际边界见证](2026-09-20-host-capability-witness.md)
- [Host 编译回执与运行代健康集成](2026-09-20-host-compilation-health.md)
- [Host 健康首个端到端工作包：固定证据](2026-09-20-host-health-first-integration.md)
- [固定 Host 的 idle/action-only 配方适配与注册合同复核](2026-09-20-host-idle-layout-adaptation.md)
- [2026-09-20 旧 Host 补丁失效检测、告警与自治链审计](2026-09-20-host-patch-health-chain-audit.md)
- [Manual compaction through the unified management owner](2026-09-21-compaction-management.md)
- [CONT 元数据并发读取：已退役 journal 的身份观察](2026-09-21-continuity-journal-race.md)
- [旧控制入口与 preload 回退退出](2026-09-21-controller-entry-retirement.md)
- [当前 Host 合同、配方与 ABI 的单版本收束](2026-09-21-current-host-contract-convergence.md)
- [Current recovery and verification entrypoints](2026-09-21-current-recovery-entrypoints.md)
- [Current safety-store contracts](2026-09-21-current-safety-store-contracts.md)
- [Handover activation and last-effect authority](2026-09-21-handover-activation-authority.md)
- [Handover controls through the original CONT owner](2026-09-21-handover-management.md)
- [Host lease / finally 静态生命周期](2026-09-21-host-lease-finally.md)
- [Managed main-stream lease：运行寿命与采样间隙故障](2026-09-21-host-lease-opportunities.md)
- [Host 原生角色的有界语义验证](2026-09-21-host-native-role-analysis.md)
- [Model-domain convergence](2026-09-21-model-domain-convergence.md)
- [当前 Host／worker checkpoint ABI 配对与生产入口接线](2026-09-21-native-checkpoint-pair.md)
- [旧网络兼容链退出与重建阶段回归](2026-09-21-network-compatibility-retirement.md)
- [Explicit notification delivery through management](2026-09-21-notification-send-management.md)
- [SQLite 只读锁等待与保护元数据并发](2026-09-21-sqlite-read-scheduling.md)
- [AH-115 E1 准备回执](2026-09-22-ah-115-e1-prep.md)
- [当前 Host/worker 核心接缝与有限 ABI 窗口](2026-09-22-current-host-core-abi.md)
- [Desktop management: complete source intake for the parallel v2 baseline](2026-09-22-desktop-v2-intake.md)
- [Named-root files through the shared management owner](2026-09-22-file-management.md)
- [Managed Jobs and retirement of daemon execution](2026-09-22-job-management.md)
- [Job owner extraction and safety identity](2026-09-22-job-owner-foundation.md)
- [B1 · Current Memory / Project / fileRef material contract](2026-09-22-material-contract.md)
- [AH-118 消息关联与原请求恢复接续](2026-09-22-message-association-recovery.md)
- [Native material entry points after a Host source change](2026-09-22-native-material-source-drift.md)
- [AH-133 self-reset 队列与消费程序验证](2026-09-22-self-reset-queue.md)
- [v2 并行成果回流核对](2026-09-22-v2-closeout.md)
- [core/release 有界完整回归（2026-09-23）](2026-09-23-bounded-verification.md)
- [原生产品合同的浏览器边界](2026-09-23-browser-product-contract.md)
- [Console 停服身份与已登记事务结算](2026-09-23-console-shutdown-settlement.md)
- [Controller unknown replay boundary · 2026-09-23](2026-09-23-controller-unknown-replay.md)
- [核心观察与保全闭环 · 2026-09-23](2026-09-23-core-observation-safety.md)
- [核心可达补丁风险闭包 · 2026-09-23](2026-09-23-core-reachable-patch-risk.md)
- [Core risk and observation window · 2026-09-23](2026-09-23-core-window-9f7728ad.md)
- [创建后归属验证迁移到正式管理入口](2026-09-23-created-bot-ownership-intake.md)
- [删除后桌面清理：停止读回与原座位保护](2026-09-23-desktop-deletion-readback.md)
- [AH-159 · 固定来源窗口、变化分类与增量回流证据](2026-09-23-host-source-windows.md)
- [消息派发前的管理授权复核](2026-09-23-message-dispatch-authorization.md)
- [模型配置最终授权与事务收尾](2026-09-23-model-publication-authorization.md)
- [A3-C：当前连续性屏障的资格边界](2026-09-23-native-continuity-fence-boundary.md)
- [新来源的有限核心配对资格](2026-09-23-native-core-pair-requalification.md)
- [原生消息交付、账号绑定与持续来源演进（2026-09-23）](2026-09-23-native-message-source-evolution.md)
- [AH-138 原生产品管理：修复与交付验证](2026-09-23-native-product-review.md)
- [R1 原生运行与独立进程资格（2026-09-23）](2026-09-23-native-runtime-qualification.md)
- [Observed adoption commit lease · 2026-09-23](2026-09-23-observed-adopt-lease.md)
- [Preload 当前源码绑定验证（2026-09-23）](2026-09-23-preload-source-binding.md)
- [Provider fixture 的日志结算窗口](2026-09-23-provider-fixture-journal-settlement.md)
- [Service registration intent boundary · 2026-09-23](2026-09-23-service-intent-boundary.md)
- [Source shim：限定加载目录并恢复调用语义](2026-09-23-source-shim-probe-diagnostics.md)
- [核心验证入口的安全反例回流](2026-09-23-verifier-safety-intake.md)
- [Compact STEP deadline and frame EOF · 2026-09-24](2026-09-24-compact-step-deadline.md)
- [2026-09-24 受控迁移、固定候选与双 Bot 窗口](2026-09-24-controlled-dual-bot.md)
- [Core candidate: review binding and current integrated regression](2026-09-24-core-candidate-101e77be.md)
- [Core review closeout: native repairs, R boundaries and configuration reads](2026-09-24-core-review-config-read.md)
- [Current native evolution and pre-adoption qualification](2026-09-24-current-native-evolution.md)
- [Persistent observation-loss projection](2026-09-24-observation-loss-projection.md)
- [Compact resume capacity attribution · 2026-09-24](2026-09-24-resume-capacity.md)
- [Host 更新现场断链：安装级 intake 与实际来源保全](2026-09-25-host-intake-recovery.md)
- [Host 更新事件与维护任务联合集成（2026-09-25）](2026-09-25-host-notification-integration.md)
- [2026-09-26 — Box 创建核心前提：原生对照与完整客户端编码链](2026-09-26-box-creation-feasibility.md)
- [2026-09-26：历史证据统一与独立 POC 提炼](2026-09-26-evidence-unification.md)
- [2026-09-26：统一集成接收与正式候选准备](2026-09-26-live-unified-integration.md)
- [2026-09-27：正式退出恢复、固定安装与 a22d48c 重新配对](2026-09-27-official-exit-and-source-rebind.md)
- [2026-09-27：正式采用的模式声明与前置拒绝](2026-09-27-adoption-mode-identity.md)
- [2026-09-27：Host 工作范围与正式空闲门](2026-09-27-host-work-gate.md)
- [2026-09-27：84c3000e 正式采用失败与未完成的物理恢复](2026-09-27-formal-adoption-unresolved.md)
- [2026-09-27：已知失败 Host 的单次受控退场](2026-09-27-owned-host-retirement.md)
- [2026-09-27：原失败采用的官方回程与退场审查修复](2026-09-27-original-adoption-restored.md)
- [2026-09-27：当前来源、入口识别与首次失败证据](2026-09-27-current-source-and-entrypoint.md)
- [2026-09-27：在官方前置条件之前选择 managed session](2026-09-27-early-session-entry.md)
