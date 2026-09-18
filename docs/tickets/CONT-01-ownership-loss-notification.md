# CONT-01 — 归属丢失的持续识别、证据与通知

**状态：planned；现有 T41 local-only collector 是复用基础，不是本票已交付。**

合同：[S13.1–S13.3](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。现场只看 [LIVE-MONITOR-PERSISTENCE](LIVE-integration-validation.md#live-monitor-persistence) 与 [LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)。

## 目标与依赖

无模型常驻服务及时发现指定 Bot 不再满足 Box 期望，保存可解释前后证据，向已经配对的用户接收目标做一次短提醒。读不到不是被迁移，写日志不是通知成功。本票独立上线，不等待 CONT-02–04。

依赖 T41 observer/store、T40 服务生命周期、现有 ownership read scheduler，以及 Template Ops 已接受的目标绑定/脱敏投递/费用合同。若投递尚未实现，在本票的最小通知纵切中复用其合同实现，不能以“运维大功能还没完成”为由无限推迟。

## 固定代码位置

- `runtime-kernel/src/internal/continuity/`：期望 owner、持续条件、baseline mismatch 与变化事件的纯规则。
- 现有 config schema：显式保护注册/通知启用，保留用户 off；不新建第三配置入口。
- `box-runtime/src/internal/roots/monitor.runtime.ts` 与 `io/monitor-store.node.ts`：受控 event-triggered reread、串行轮询、完整覆盖、incident/manifest/outbox事务；不在 observer 执行 clone。
- 既有 service/Template Ops delivery owner：常驻安装/恢复、有限目标投递、送达结果；监控 CLI 查询仍纯读。

## 必须通过的行为

`ownership_changed` 继续表示边沿。保护注册拥有 `expectedHarness=box` 的持续条件：confirmed Temporal 或 Server-temporal/local-box conflict 时不因下一次状态不变而关闭；解除保护与替换完成不回写原身份。首次启动已 Temporal 为 baseline mismatch，变化时间 unknown。失败、过期、scope/Gateway不稳定只标 gap，不能触发自动克隆。

同一 collector 中 event 与 polling 共享受控读取入口；原生事件只加速 Server核实。保持 T37 五秒证据年龄及业务优先级。超过32目标分批、首次启动/长期空闲/Host重启也必须覆盖，若迟延明确显示。延迟指标分采样、事件、提交、投递和实际接收；不存在网络/盒子失联下的硬秒级保证。

incident + before/after引用 + outbox 同事务；默认按迁移批次聚合，重复采样、服务重启、ack/snooze不重复唤醒。接收目标不依赖被接管 Bot 自己；投递失败保留待处理/结果不确定，不把 stdout 或 HTTP accepted 当用户已见。短提醒不启动自动诊断/建单，不送 Memory、prompt、密钥或blob。

## 验收出口（本票实现时新增测试）

在现有 monitor 套件补独立用例：Box→Temporal、多次Temporal不误解决、首次Temporal、local conflict、unknown→重新确认、scope切换、批量限制、collector crash恢复、相同server行乱序、缺bridge。真实SQLite事务故障注入证明 incident/outbox原子、重启不漏/重发；owned notification sink证明去重和未知响应规则，通知ack不伪造用户阅读。

通过现有 `bun test packages/box-runtime/test/monitor-store.test.ts packages/box-runtime/test/monitor-commit-boundaries.test.ts` 只是防回归，不是新行为全部验收。新增用例和打包CLI/Node/service测试须随实现进入本票；真实用户接收、Host重启与实际采样延迟在 LIVE 登记。

## 禁止与非目标

不默认启动模型分析，不调用 migration/re-adopt，不改Bot模型/归属，不在业务判权中使用monitor快照。通知授权不自动授权克隆、源任务停止、外部webhook改写。盒外heartbeat是另行配置能力，不声称盒内collector可以在整盒冻结时发出告警。
