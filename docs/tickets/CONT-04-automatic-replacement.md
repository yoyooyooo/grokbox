# CONT-04 — 逐职责接替与自动替身编排

**状态：Partial implementation。分阶段 replace、创建/选模/初始化/激活及 active_with_handover 已接通；完整外部任务和逐职责效果约束仍未交付，不能从生命周期 ready/active 推导全部工作已接替或源可删除。**

当前实现入口为 [生命周期程序](../../packages/box-runtime/src/internal/roots/bot-lifecycle.runtime.ts)和 [handover 程序](../../packages/box-runtime/src/internal/roots/bot-handover.runtime.ts)，限定证明归 [生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)，操作归 [指南](../maintainers/bot-lifecycle.md)。下文完整目标与独立验收继续保留。

合同：[S13并行交接](../roadmap/box-runtime-impl-spec.md#continuity-handover)。依赖CONT-01/03/11；CONT-09消费本票逐职责协议并实现关系交接，不把其全完成设为激活前置；CONT-10拥有旧身份最终退役。

## 目标与模块

同一台云电脑，用户预授权后程序发现接管、恢复新身份、开放合格职责，同时继续迁移关系和观察旧端。`roots/continuity.runtime.ts`为单一Effect操作owner，kernel continuity决定transition/duty，store持久operation/nonce/generation/收据，observer仅提交候选事实。

```text
confirmed_loss → evidence_frozen → creating → prepared
→ active_with_handover → retirement_eligible → retired
```

prepared到active的条件是目标原生状态合法、实际Box归属和模型/政策合格，以及被开放职责自己的输入/effect边界可确认；不是所有旧任务和关系都已完成。退役后两步由CONT-10提供明确判定和正式删除。

## 逐职责推进

为routine、任务、关系入口或冲突资源保存old/new执行方、已处理水位、未决结果、交接状态和证据。已确认职责新Bot立即接手；旧job结果unknown只阻断该职责及可证明冲突资源。独立职责不能被全局idle门卡住；无法确定共享资源冲突范围时明确扩大范围并告警，不盲放行。

背景材料可best-effort，非法native提交/身份不明仍阻断目标激活。旧Bot可以合法继续指路和接旧结果，new active与old active不是自动认定双跑；禁止的是同一效果被重复执行。旧任务没有读回结果不能重新派发，Routine按CONT-01逐项切换，未结项留prepared duty而非回滚所有成功项。

稳定继任槽位只控制grokbox管理入口，官方App旧ID可能继续来消息，由CONT-09/10处理。每次创建/激活先持久operation ID；结果丢失读回，不换nonce多建，迟到旧代不能覆盖当前。每逻辑Bot最多一个构建/激活候选，旧grace代可多份受限存在；反复迁移触发冷却/次数/费用限额，指路统一解析当前继任者防循环。

## 验收出口

新增纯状态/真实SQLite/独立进程和owned端口测试：各步崩溃/取消、创建丢回执、目标立即再迁移、旧代迟到、同输入重复、多代风暴/指路、配置撤销。必须有一个实际case证明新Bot已执行职责A，旧job B仍unknown且关系C未迁；A继续，B不重复，C明确挂账。

手动replace和auto-replace共用用例，按配置自动执行而非每步再问。状态输出同时展示quality、职责、关系、旧入站和退役阻断。真实并行主线在[LIVE-CONTINUITY-HANDOVER](LIVE-integration-validation.md#live-continuity-handover)。

## 非目标

不永久钉住ownership，不全局claim exactly-once，不要求旧Bot全局空闲后才能开始，不把active当全部完成，不在本票自行删除旧身份。无多会话、跨机器或第二Agent loop。
