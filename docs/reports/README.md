# Reports：固定验证回执

- [2026-09-23 Provider fixture 日志结算](2026-09-23-provider-fixture-journal-settlement.md)：受控锁反例证明终态文本可见不等于原写入结算；修复测试等待并保留生产 partial 判定，不代签原生消息资格。

- [2026-09-22 self-reset 队列与消费程序验证](2026-09-22-self-reset-queue.md)：C1 的登记、消费阶段、材料引用与 GC 保护；明确 A3-C2 原生 safe-point 接通仍未证明。

- [2026-09-20 旧 Host 补丁健康链审计](2026-09-20-host-patch-health-chain-audit.md)：限定旧逻辑，核对字符串/Golden/AST、watchdog实际入口、来源事件到incident与通知资格；89项隔离检查包含4个缺口反例，不签持续感知接通或现场告警送达。

- [2026-09-20 Grok Bot 上游版本影响](2026-09-20-grok-bot-upstream-impact.md)：App 0.47→0.57.1、磁盘 Host 0382fa8 与当前工作树的接口/切片核对；记录 Memory 回退、idle compaction、旧回放资格失效及 53 项隔离回归，不签当前进程、模型链路或部署。

- [2026-09-19 本机原生来源只读资格](2026-09-19-live-source-qualification.md)：4 次有界元数据请求与目录/stat；记录 ownership 响应缺字段，不签部署、材料写入或模型 E2E。

- [2026-09-19 上下文债审计](2026-09-19-context-debt-audit.md)：反例、删减、代码简化与未证边界；不签整库或当前部署。

固定报告保留各自源码/窗口、失败与未证范围，不维护另一份当前进度。退役的设计和研究解释归 [archive](../archive/README.md)；需要继续被 LIVE 引用的验证回执保持本目录稳定路径。

- [2026-09-19 网络边界合入 V2 与合入后复验](2026-09-19-network-boundary-v2-integration.md)：线性提交映射、固定 V2 上的网络/CLI/文档/安装包验证与实际退出码；代码已集成不等于现场或独立审查通过。

- [2026-09-19 文档合入 v2 与源码对齐](2026-09-19-documentation-v2-integration.md)：快进集成、保留并行生命周期/LIVE 变更、补齐指南与旧入口收敛，记录联合回归和 CONT-01 单页未落盘边界。

- [2026-09-19 文档收敛切片](2026-09-19-documentation-convergence.md)：合同与按需入口重整、归档及验证；明确保留两处未成功写入、全仓测试超时和同期 v2 继续前进的基线差异，不宣称全部冲突已清零。

- [2026-09-19 连续性候选集成证据](2026-09-19-continuity-lifecycle-integration.md)：生命周期/保护/交接的限定验证、原生启动反例修正、材料引用GC和仍未完成的源码/文档项；不是现场通过或完整产品交付声明。

**当前现场已验/未验、阻断与下一步只看 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md)。** 本目录报告固定在各自窗口结束时，不随后续推进维护当前状态；报告中的未验清单只说明当时缺口。

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

历史 [orchestrator handoff](../roadmap/2026-09-12-orchestrator-handoff.md)保留旧路径，不作为当前执行指令。功能合同走 [Spec](../roadmap/box-runtime-impl-spec.md)，实现/离线/review 走 [Tickets](../tickets/README.md)，当前现场进度只走 [LIVE](../tickets/LIVE-integration-validation.md)。不能从旧 handoff 恢复 worker、test2 heavy 或 GATE 权限。

私有Host/App dump、真实历史和凭据不进公开报告；已有私有receipt是否仍存在需实际检查。未来候选在[roadmap/future](../roadmap/future/README.md)，不要把历史未完成列表直接当future已排期。
