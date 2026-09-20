# T55 — 接收者资格、故障域与有限交接

## Status / Goal

**Partial：固定disabled提醒blueprint与实际加载Host的只读自动任务选模预检已实现；真实Webhook回合/激活仍未资格化。高级分流是独立后续。** [Spec §6.3–6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。首发每个实际支持的目标仍须取得其最小身份/模型/数据/成本资格；不能因为高级延期就免验custom接收者。

## 显式发送前置增量

T45的`ops notifications send`已把用户确认的model fingerprint、prepared配对与启用定义、当前Host同帧观察、既有Server/local所有权门接到真实HTTPS。只在显式单条既有work上使用，保持原证据年龄，不将`verify`结果写为永久资格，也不凭预检自动启用Routine。模型/ownership/代际/定义变化在发送前拒绝；真实回合使用的模型与工具及用户送达仍未观测。自动资格、长期激活和后续交接不由该命令代替。[固定回执](../reports/2026-09-18-explicit-native-notification.md)。

## Depends-on / Modules

依T43/T53原生合同、T54 frozen route、T45 delivery；T47仅是后续诊断消费者。kernel routing/policy/notification；box-runtime native-notification与bindings/state，复用同一outbox而非新增sender。

## 已实现的接收者预检

`ops targets blueprint <alias>`生成固定禁用Routine定义；`ops targets verify <alias>`只读prepared配对、安装scope、受管原生ID/revision、prompt策略和Host选模见证。模型与loaded capabilities来自同一原生状态帧，前后校验reviewed profile和Gateway代际，最终本地核对后再次检查五秒新鲜度。缺证、已启用、变化或过期不得得到绿色预检，不读key、不写资格/配置、不发模型请求。

Host选模闭包复用原生automation实验/默认/环境逻辑，route模式附精确Agent的managed selection revision；仅限下一次本地默认自动任务。`preflight_ready`明确没有Server所有权、实际工具、HTTP或用户已读证明，也不授权canary/activate/send。旧Host没有对应观察点时返回缺证，不从当前配置猜测模型。

## 新管理健康面（2026-09-20）

HOST-01当前提供来源/静态分析和原installation incident，公开合同保留 `notificationCoverage=local-only`，不把依赖同Host的receiver当独立兜底。原接收者所有资格门保持不变，检测器不能写入许可或改模型/目标。首次接入和enable/test已经由T45/T46统一管理入口替代本票早期 `ops targets` 示例；阅读历史预检回执不得恢复已退役writer。实际送达、同故障域失效和独立出口仍需本票/现场证据。

## Work

分别验证identity、routine、ownership、Webhook实际model selection、tool scope、data consent与availability。普通聊天选模不证明automation回合走同一供应商；配置/捕获/观察值不同必须展示。custom依赖本次故障Host/modeld/provider时明确dependency-unavailable；官方也可能共用Host/Box，不承诺高可用。

最小模式：一个明确目标，不可用本地保留/过期合并，不改模型/修Host/猜备用。后续备用仅限已配对相同intent和数据范围且确定原attempt未接收/未开始；timeout或无报告为unknown，不扇出。新增alias不得扩大安装或真实native Bot费用预算。

后续受托/预授权诊断允许一次受控needs-analysis交接：核对权限/数据/预算，安全summary+refs，不转发整段对话、不A→B→A；默认brief只提醒不能提出自动升级。集中reportTarget是额外有预算的投递，与诊断完成分列，不能偷换会话。

绑定/caller真实身份不可证时不开放自动诊断工具；固定安全提醒仍按最小载荷合同，不用agentId参数自证权限。同UID任意shell不宣称沙箱，模型输出不授予控制权。

## Executable acceptance

已新增`packages/box-runtime/test/ops-receiver-qualification.test.ts`、`test/receiver-frame.test.ts`及显式固定源`native-receiver-model.test.ts`。`ops-receiver`完整专项117 pass/0 fail，原生函数探针1 pass/72断言；CLI全量732 pass。最终packages前两组1156 pass/20 skip，第三组86文件被工具拦截，未签全仓完成。独立审查超时无报告。实际失败、夹具更新、Node checker与未证范围见[本轮回执](../reports/2026-09-18-receiver-model-preflight.md)。

`ops-receiver-handoff.test.ts`及实际Webhook模型/工具/数据链仍待实现和验证，不能从预览推导已执行。高级故障切换/交接后续独立完成，不以默认提醒扩大权限。

原生资格在独立授权的一次性接收Bot上通过实际Webhook捕获选模/供应商/报告；无证据标unqualified，不用配置值代替。首发只签所选目标已证范围，高级route/handoff另记未完成。

## Forbidden / Exit evidence

不再造model catalog/agent loop，不为告警可达先restart，不借高severity提高权限。当前原生状态唯一归[LIVE-OPS-RECEIVERS](LIVE-integration-validation.md#live-ops-receivers)，自主任务归[AUTONOMY](LIVE-integration-validation.md#live-ops-autonomy)。
