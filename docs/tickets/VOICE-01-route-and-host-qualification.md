# VOICE-01 · 语音委托路由与 Host 接缝资格

状态：**deferred；方向已接受，当前阶段之后回访，尚未实施。** 不阻塞 HOST-01/CLI-05、当前 W4/W5 或已有 LIVE 场景。排程唯一见 [Roadmap](../roadmap/README.md#voice-delegation)，范围与研究线索见 [语音 Spec](../roadmap/voice-delegation-spec.md)。

## 目标

证明目标原生通话的委托是否真正进入 Box 主 Bot 推理，并找出复用现有模型替换与交付链所需的最小缺口。先分清媒体/转录、语音 Harness 路由、Bot 执行归属及最终执行位置，不能把“Box 收到请求”判成“Box 做了推理”。

## 依赖与位置

当前手头阶段完成、用户回访本事项时启动；届时读取 CLI-05/源码实际状态，不要求机械重跑全部旧阶段。技术依赖是目标 Bot 的权威归属、对应 Host 来源/加载资格和现有受管 session 接缝；相关 [HOST-01](HOST-01-patch-health-verifier.md)、[HCR](README.md#host-capability-recovery)、[T37](T37-server-ownership-admission.md) 不在本票重建。

公共入口：`packages/box-runtime/src/internal/host/{session-hook,live-slices,turn-observation}.ts`。按 Spec 的私人材料定位重新检验客户端 `DesktopVoiceCallHarness` 与 Host `VoiceCallRuntime`；公开合成回归落在 `packages/box-runtime/test/voice-delegation.test.ts`，需要新增观察/切片时按 Spec 归位。固定研究写有边界的 reports，不修改现行合同宣称已支持。

## 工作与可执行出口

- [ ] 固定实际读取的客户端版本、Host/companion 来源及哈希；磁盘、已加载运行代、账号有效开关分别取证。前轮研究回放/计数只作线索，不能复用为当前通过。
- [ ] 回放 package+Box、package+Temporal 的 send_task 特判、backend Harness、Host server-loop；用独立合成调用者验证选择和拒绝。真实 backend 后续路径缺证时保留 unknown，不凭同名方法或本地 recall 推断可拦截。
- [ ] 验证转录 partial/final 的实际出站时机、结束记录提交、request 与 spokenTurns 内容边界及实际长度校验；不得把挂断记录或空 spokenTurns 解释为实时完整上下文。
- [ ] 定位 nudge→wake/steer→原生 Runner→createSession→受管选择以及原生 voice channel→客户端结果消费的实际调用边。空闲新回合和已有非 voice-call 回合的 steer 分别检查；只找到代码锚点不宣称执行已发生。
- [ ] 用延迟/拒绝/丢失的合成回执复现客户端提前 receipt、Box accepted 早于执行、steer 丢失回队及重复提交；分清原入口行为与产品期望，保留能推翻假设的反例。
- [ ] 输出逐边界覆盖表：已有且复用、需要观察、需要修正、当前未知/不支持。新切片只针对已证明缺口，经现有 profile/compile/witness 资格；不匹配当前来源不得放宽匹配或删依赖求绿。
- [ ] 实际新增测试落盘后登记并运行准确命令，同时运行相关现有 session/observation 回归；固定报告给出来源、命令、结果和限制。公开测试无私人源码/账号/网络依赖。真实探测如需通话、付费模型或状态变更，先进入获授权窗口；纯静态/合成出口不能代签它。

完成条件是下一票能按实际接口开工，并知道哪一段尚未证实。若目标路由不落 Box，保留具体阻断与证据；不可把改变执行归属或修改 App 当默认修复，也不能以文档齐全关闭整个语音能力。

## 非目标与禁止

不在本票实现另一套推理服务、迁移 Bot harness、直接改产品数据库、批量修改角色描述或接管音频。Presence、一次 Gateway ACK、通话 JSON、模型自报身份和后端 URL 均不是受管执行证据。不为了制造通过而删除未知路径或忽略 Temporal/backend 分支。

## 交接

把最小实现差额交给 [VOICE-02](VOICE-02-managed-execution-and-delivery.md)，真实用户故事交给 [VOICE-03](VOICE-03-live-acceptance-and-coverage.md)。现场结果仍只归 [LIVE](LIVE-integration-validation.md)，本票只记录本范围的研究/实现/离线资格。
