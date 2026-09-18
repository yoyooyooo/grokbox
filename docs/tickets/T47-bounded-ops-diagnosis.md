# T47 — 原生 Bot 受托自主排障与操作验收

## Status / Goal

**Planned / 独立后续A；不是默认提醒前置。** [Spec §1/§7](../roadmap/template-ops-automation-spec.md#execution)。原生Bot接到用户任务后自主理解、取证、执行范围内动作并验证；“默认brief只提醒”不限制此能力。独立自动诊断策略仍默认关闭。

## Depends-on / Modules

依OBS-00/02/03/04的证据/视图/租约、T51权限/预算合同；从通知接续时复用T45/46身份。用户手动发起任务不要求先收到Webhook。kernel ops task/policy；box-runtime有界诊断adapter；既有doctor/status/agents/models/context命令与controller owners；按需ops Skill。

## Work

区分可信用户任务、自动brief、独立预授权诊断；日志/Webhook/模型声称用户同意不创建任务。任务绑定对象、操作类、数据与预算；常规只读步骤不重复审批，新增共享Host中断/模型费用/供应商或公开范围需要决定。

Bot通过原生执行体系选择有限工具，不由grokbox内嵌另一套agent loop。诊断优先固定incident revision和必要当前状态，显式申请短期证据租约，区分事实/推断/缺证并引用evidence refs；模型输出不是权限或成功回执。

排查任务不自动拥有模型修改/重启权限；用户明确换指定模型时，复用models owner完成解析、保存、捕获/下一TURN采用验证，保留原TURN选择和其他Bot状态。需要真实付费probe则验证任务授权预算。不把“配置已保存”说成“运行已恢复”。

自动诊断只有工具边界已资格化才可启用，最多2轮×8只读操作、120s及安装级费用预算；默认brief不得自行升级。用户任务按明确任务预算执行，不被提醒的首醒限制截成命令教学。跨Bot升级后置T55、最多一层；维护计划交T49，Bot持久交接后结束。

## Executable acceptance

待新增`test/ops-delegated-task.test.ts`、`packages/box-runtime/test/ops-diagnosis-scope.test.ts`、`test/ops-model-change-journey.test.ts`。Fake任务/原生adapter与实际CLI验证：默认brief零诊断；明确排查自主多步只读不反复确认；只排查不能换模/重启；明确换模只改指定Bot并验下一TURN，不改旧TURN。

覆盖证据过期/partial、租约预算/取消、恶意JSON命令、用户身份不可证、越权公开、provider变化、任务超时、工具已产生副作用后失败、Bot迟到结论；输出事实/推断和真实结果分离。实际原生Bot交互、模型采用和用户旅程另外授权并验。

## Forbidden / Non-goals / Exit

不自动Issue、不以提示词代替工具隔离、不反向让T45等待诊断，不直接signal/清circuit/重放旧STEP。旧任务unknown必须对账，换Bot不换操作身份。当前现场只看[LIVE-OPS-AUTONOMY](LIVE-integration-validation.md#live-ops-autonomy)，维护另看MAINTENANCE；没有原生运行证据不以离线工具mock签自主闭环。
