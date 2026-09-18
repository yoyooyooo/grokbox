# T55 — 接收者资格、故障域与有限交接

## Status / Goal

**Planned / Spec-only；高级分流是独立后续，不阻塞已资格化单目标提醒。** [Spec §6.3–6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。首发每个实际支持的目标仍须取得其最小身份/模型/数据/成本资格；不能因为高级延期就免验custom接收者。

## Depends-on / Modules

依T43/T53原生合同、T54 frozen route、T45 delivery；T47仅是后续诊断消费者。kernel routing/policy/notification；box-runtime native-notification与bindings/state，复用同一outbox而非新增sender。

## Work

分别验证identity、routine、ownership、Webhook实际model selection、tool scope、data consent与availability。普通聊天选模不证明automation回合走同一供应商；配置/捕获/观察值不同必须展示。custom依赖本次故障Host/modeld/provider时明确dependency-unavailable；官方也可能共用Host/Box，不承诺高可用。

最小模式：一个明确目标，不可用本地保留/过期合并，不改模型/修Host/猜备用。后续备用仅限已配对相同intent和数据范围且确定原attempt未接收/未开始；timeout或无报告为unknown，不扇出。新增alias不得扩大安装或真实native Bot费用预算。

后续受托/预授权诊断允许一次受控needs-analysis交接：核对权限/数据/预算，安全summary+refs，不转发整段对话、不A→B→A；默认brief只提醒不能提出自动升级。集中reportTarget是额外有预算的投递，与诊断完成分列，不能偷换会话。

绑定/caller真实身份不可证时不开放自动诊断工具；固定安全提醒仍按最小载荷合同，不用agentId参数自证权限。同UID任意shell不宣称沙箱，模型输出不授予控制权。

## Executable acceptance

待新增`packages/box-runtime/test/ops-receiver-qualification.test.ts`、`packages/box-runtime/test/ops-receiver-handoff.test.ts`。验证不同模型路径/数据改变需重绑、目标失效/unknown不广播、预算多alias不放大、primary无资格不换规则、跨Bot同incident不重复动作，默认brief无升级。

原生资格在独立授权的一次性接收Bot上通过实际Webhook捕获选模/供应商/报告；无证据标unqualified，不用配置值代替。首发只签所选目标已证范围，高级route/handoff另记未完成。

## Forbidden / Exit evidence

不再造model catalog/agent loop，不为告警可达先restart，不借高severity提高权限。当前原生状态唯一归[LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)，自主任务归[AUTONOMY](LIVE-integration-validation.md#live-ops-autonomy)。
