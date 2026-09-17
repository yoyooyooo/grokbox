# Reports：历史解释与有界证据

**当前现场已验/未验、阻断与下一步只看 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md)。** 本目录报告固定在各自窗口结束时，不随后续推进维护当前状态；报告中的未验清单只说明当时缺口。

- [2026-09-17 现役集成窗口](2026-09-17-live-integration-window.md)：统一配置真实迁移、v7 成套加载、12 条有界 canary、改档/工具/重启与 stock 回程；记录现场发现的 Host 重复 apply 缺陷及修复、最终验证、清理和仍未证明的范围。不是全部 LIVE 或独立复审通过。

- [2026-09-17 Modeld 线性合入 v2](2026-09-17-modeld-v2-integration.md)：记录原提交到变基提交的完整映射、保留既有 MiniMax/投递修复的冲突处理、组合树验证及 LIVE 状态更新；源码集成不代表复审或 live 发布通过。

- [2026-09-17 Modeld 非 live 收尾](2026-09-17-modeld-effect-core-closeout.md)：固定候选的单一期限、最终类型/全库/制品验证、基线重跑、外部复审失败回执，以及跨 worktree LIVE 票；不是 live 发布成功证明。

这里保存已经发生、仍有解释价值的审阅/实验背景，不保存未来任务或当前运行状态。版本、时间和未证项必须明确；报告不授予实现/部署权限，也不能盖过Spec与原生来源。

- [2026-09-17 Modeld 执行核心离线验证](2026-09-17-modeld-effect-core-offline.md)：固定提交与构建指纹、完整回归、真实生产程序上的合成延迟/取消对照；明确普通请求未证明普遍提速，以及 typecheck、外层超时、独立复审与原生发布的剩余门。
- [2026-09-12 Managed Compact演变](2026-09-12-managed-compact-evolution.md)：合并旧owner brief/technical path的背景与取舍，说明旧harness、Working、审批等待为什么不再有效；给出Git原文和回执引用。

历史 [orchestrator handoff](../roadmap/2026-09-12-orchestrator-handoff.md)保留旧路径，不作为当前执行指令。功能合同走 [Spec](../roadmap/box-runtime-impl-spec.md)，实现/离线/review 走 [Tickets](../tickets/README.md)，当前现场进度只走 [LIVE](../tickets/LIVE-integration-validation.md)。不能从旧 handoff 恢复 worker、test2 heavy 或 GATE 权限。

私有Host/App dump、真实历史和凭据不进公开报告；已有私有receipt是否仍存在需实际检查。未来候选在[roadmap/future](../roadmap/future/README.md)，不要把历史未完成列表直接当future已排期。
