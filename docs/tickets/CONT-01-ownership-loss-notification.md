# CONT-01 — 归属丢失感知、默认暂停与用户通知

**状态：planned；T41/OBS已实现子集是复用基础，不是本票外部闭环已完成。**

合同：[S13感知与暂停](../roadmap/box-runtime-impl-spec.md#continuity-observation)。依赖CONT-11、既有ownership reader/T41/T40、OBS证据和T45/T46通知；Routine复用T53正式能力。本票可独立交付，不等CONT-03–10全部完成。

## 目标与模块

无模型常驻观测受保护Bot，事件加速、serial polling兜底，确认接管后通知并按配置暂停旧Routine。复用`monitor.runtime.ts`、`monitor-store.node.ts`、统一config及原生Routine adapter；observer仅写事实/意图，实际变更由受控operation执行。

`ownership_changed`继续表示边沿，Box期望是持续条件。首次即Temporal仍报告baseline mismatch、发生时间unknown；下一次仍Temporal不能误解决。Server-temporal/local-box conflict可形成已确认的偏离；读取失败/stale/scope不稳只形成gap，不误触发克隆。

正常策略10–30秒采样不是送达保证，超过32目标分批并显示覆盖。保留读取身份/证据时间、Host代际和前后区间，不以Server更新时间或Host升级相关性冒充确切迁移因果。

## 暂停与通知

新保护默认pauseOnOwnershipLoss=true，用户可关闭；与routineTransfer=move/keep-source分开。到当前真实管理端暂停并读回，不能只改本地文件。暂停前的enabled意图、用户新修改、最后fire/未结任务分开记录，已运行任务不声称终止；结果unknown只挂对应职责。

冻结最小证据并提交outbox，不等待摘要或大快照完成。归属偏离是保护事件，不被“纯上游bug不告警”分类吞掉。通知复用ops目标/预算/安全摘要；实际接收未证不得报通知成功，无法配对保留可查欠账，不能只依赖受影响Bot本身。

## 验收出口

新增Box→Temporal、首次不符、连续Temporal、冲突、乱序/失联/恢复、批量覆盖、事件与轮询去重用例；真实SQLite检查incident/intent原子与崩溃恢复。正式Routine adapter测Box/Temporal目的端、读回失败、暂停false、在途fire和保留原始意图。owned通知sink检查unknown和重复不多发。

现有monitor-store/monitor-commit-boundaries套件只是回归。实际常驻、用户接收与暂停在[LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)和[LIVE-OWNERSHIP-LOSS-PROTECTION](LIVE-integration-validation.md#live-ownership-loss-protection)登记。

## 非目标

不部署恢复对象、不改原Bot归属、不让monitor缓存授予推理许可，不默认分析或公开Issue。整盒停机不承诺盒内通知；后续观测恢复时保留gap。
