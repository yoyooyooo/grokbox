# T55 — custom 接收者资格、成本预算与跨 Bot 交接

## Status / Goal

**Planned · Spec-only。** 让 T54 的配置真正进入 T45 通知链：支持廉价/custom 接收者，防止坏 modeld 使告警递归失败，避免重复/备用/升级放大成本或重复维护。Owning contract：[Spec §6.4](../roadmap/template-ops-automation-spec.md#receiver-resilience)。

## Depends-on / Modules

依 T54 RouteDecision、T45 outbox/claim、T53 native invoke/outcome；复用 T24/T37 的逐 Bot selection/Server 准入证据，不扩范围。T47 诊断接口是后续升级消费者，固定 brief 可以独立交付；不等 Host 自动维护。

box-runtime `internal/ops/automation/notify.ts`、`diagnose.ts`、`internal/io/template-notify.node.ts`、`monitor-store.node.ts`、`internal/roots/monitor.runtime.ts`；kernel `routing.ts`、`notification.ts`、`internal/commands/ops.ts`；模板/通用接收指南复用已安装 ops topic，不复制完整提示。

## Work

发送前核对 target identity/routine/ownership/model/tool/data/freshness，各面独立 unknown。custom 依赖受损 Host/modeld/provider 时不自动修目标；官方备用也披露共同故障域。原生 Webhook Routine 可能与普通聊天使用不同 session/选模路径，须单独核对 native wake→实际模型捕获，不以聊天换模成功代替；未知标 webhook-model-unqualified。实际已采用模型与配置选择分开，配置模型/供应商/endpoint 指纹变化默认阻止新投递直到重绑；不在 STEP 中切模型或将 assignment 存盘当已生效。

消费冻结路由；target circuit、安装/原生 Bot/工作预算、旧绑定/撤销、候选 supersede 均在真实 outbox/claim 程序实现。alias 共用原生 owner 配额，fallback/重试/集中报告都扣额度。critical 调度优先不取消已运行用户任务，也不自动增加预算。Effect 子 Scope/有界队列/取消关闭遵守既有 pin，collector 不得到控制信号权限。

明确未发送或已证未接收才走显式 fallback；unknown 不直接发给其它 Bot。处理中的旧尝试不能和新目标同时领同 work；旧回调不能覆盖新阶段。`needs-analysis` 只产候选，经启用开关/数据/预算决定最多一层升级；Bot 不相互 sendPrompt，不带整段对话，不把分析结果当新的监测根事件。

默认报告在当前接收 Bot；routing.reportTarget 显式配置时，分析先存结果、再作为独立有预算通知发送安全摘要。issue draft/consent 与 maintenance plan 的身份不随换 Bot 变化，多个 Bot 不能多次创建 issue 或重做 signal。caller 的真实身份必须来自已资格化 native bridge，参数里的 agentId 不是鉴权；无权限隔离时降级固定安全摘要，不以 prompt 假装 sandbox。

## Executable acceptance

实现时创建并运行：

```bash
bun test packages/box-runtime/test/custom-notification-receiver.test.ts packages/box-runtime/test/ops-cross-bot-handoff.test.ts packages/box-runtime/test/template-notification-outbox.test.ts
bun run typecheck
```

首两项本票创建，outbox 测试复用 T45。FakeClock/真实临时 SQLite/HTTP oracle 覆盖：custom unavailable→批准官方备用；ACK 丢失不扇出；已 run 无 reply 不重试；model change/privacy downgrade 拒绝；同 Bot 多 alias 的全局上限；升级 off 时询问而不运行贵模型；A→B→A 环拒绝；报告目标失败与诊断成功分列；原生身份缺失不领取私有证据；两个 Bot 提同计划仅一次执行身份。

每实际网络/推理尝试有独立计数，native token 上界不可证时输出 not_proven。无事件 0 模型、rule explain 0 外部副作用。隔离 packed CLI 的正常关闭/硬崩恢复不泄漏 lease/secret、不重复 unknown 动作。

原生 lane 由 T50 在明确测试预算下验证两个不同模型测试 Bot + 可选官方备用，包含 routine update 后新 revision、实际 Webhook POST、真实选模/运行证据；缺 Webhook 路径模型可观测性则如实 not_proven，不以普通聊天/assignment 或 Bot 自报模型作证。

## Forbidden / Non-goals

不为通知开启/restart Host/modeld、不修改接收者模型、不把昂贵 Bot 视为可信审批人、不自动跨账号/供应商 fallback、不自发创建 Bot 集群或另一个 provider loop。不对生产 Bot 注入故障。

## Done evidence / Next

提交真实消费冻结决策的程序/预算/去重/交接测试，不留通知器中的第二路由 engine。T50 对单目标/custom/分流分别签署；issue 出版者 T56 与本票模型生命周期解耦。
