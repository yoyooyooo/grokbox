# CONT-01 — 归属丢失感知、默认暂停与用户通知

**状态：实施中。默认发现、原 CONT 状态与 Routine 暂停、事件导出、管理 Server 单 owner、共享 CLI/Web 策略及恢复读面已接通；实际原生资格、用户收到通知和完整持续安装仍未关闭。**

合同：[S13感知与暂停](../roadmap/box-runtime-impl-spec.md#continuity-observation)。依赖CONT-11、既有ownership reader/T41/T40、OBS证据和T45/T46通知；Routine复用T53正式能力。本票可独立交付，不等CONT-03–10全部完成。

## 目标与模块

无模型常驻观测受保护Bot，确认接管后导出观察事件并按配置暂停旧Routine。当前[保护服务](../../packages/box-runtime/src/internal/roots/protection-service.runtime.ts)在管理 Server Scope 内复用原 CONT 数据库、[保护程序](../../packages/box-runtime/src/internal/roots/bot-protection.runtime.ts)和共享原生适配；通知仍由原 monitor/outbox/sender 负责。旧 daemon 保护启动和普通 `agents protection` 命令退出。通道分别负责发现、观察、材料/继任推进、交接，不因慢材料捕获阻止归属观察。事件加速的进一步来源支持仍待核验，当前使用有界轮询。

`ownership_changed`继续表示边沿，Box期望是持续条件。首次即Temporal仍报告baseline mismatch、发生时间unknown；下一次仍Temporal不能误解决。Server-temporal/local-box conflict可形成已确认的偏离；读取失败/stale/scope不稳只形成gap，不误触发克隆。

默认发现每30秒轮转32个目标，保护观察使用 `runtime.continuity.intervalMs`，单轮16个已保护主体；累计最多128个主体，容量或创建未关联时显示明确覆盖限制。默认发现只接纳新核验的 owned Box；用户明确配置的主体首次即Temporal则报告偏离，不把所有Temporal Bot误纳入保护。保留读取身份/证据时间、Host代际，不以Server更新时间或Host升级相关性冒充迁移因果。

## 暂停与通知

新保护默认pauseOnOwnershipLoss=true，用户可关闭；与routineTransfer=move/keep-source分开。到当前真实管理端暂停并读回，不能只改本地文件。暂停前的enabled意图、用户新修改、最后fire/未结任务分开记录，已运行任务不声称终止；结果unknown只挂对应职责。

冻结最小证据并提交outbox，不等待摘要或大快照完成。归属偏离是保护事件，不被“纯上游bug不告警”分类吞掉。通知复用ops目标/预算/安全摘要；实际接收未证不得报通知成功，无法配对保留可查欠账，不能只依赖受影响Bot本身。

## 验收出口

新增Box→Temporal、首次不符、连续Temporal、冲突、乱序/失联/恢复、批量覆盖、事件与轮询去重用例；真实SQLite检查incident/intent原子与崩溃恢复。正式Routine adapter测Box/Temporal目的端、读回失败、暂停false、在途fire和保留原始意图。owned通知sink检查unknown和重复不多发。

[管理 Node 组合](../../test/protection-management.test.ts)与[真实生产浏览器](../../apps/web/test/protection-browser.node.ts)覆盖默认/显式排除、来源错误、并发策略、权限撤回、丢回执、离开页面、精确暂停、原生创建未知、竞争 owner 及 Node SIGKILL 后原 loss guard。原生事实与恢复端为隔离合成输入；默认不支持捕获的场景保持 snapshot_unavailable。原观察 SQLite 组合还验证有序事件、未配置通知不丢保护状态、通知 off 无投递工作。新事件序号随 subject CAS 持久化，不再把时间戳解释成缺失事件计数；旧不确定导出只保留原事件格式，不改写成新流。

固定源码与实际回归计数见 [CLI-05](CLI-05-implementation-follow-through.md)。实际常驻、用户接收与暂停在[LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence)和[LIVE-OWNERSHIP-LOSS-PROTECTION](LIVE-integration-validation.md#live-ownership-loss-protection)登记。

## 非目标

不部署恢复对象、不改原Bot归属、不让monitor缓存授予推理许可，不默认分析或公开Issue。整盒停机不承诺盒内通知；后续观测恢复时保留gap。
