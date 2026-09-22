# VOICE-02 · 受管推理、委托关联与通话结果交付

状态：**deferred；尚未实施。** 范围唯一见 [语音 Spec](../roadmap/voice-delegation-spec.md)，不插队当前主线。依赖 [VOICE-01](VOICE-01-route-and-host-qualification.md) 的实际入口和覆盖差额，以及相关模型/Host 能力资格；不要求重做已经成立的模型、上下文或通知实现。

## 目标与责任

已经到达 Box 的语音委托使用该 Bot 的现有受管模型与原生执行链，能关联实际执行并向正确通话交付结果。原生 Host 继续拥有队列、Runner、工具、会话、Memory 和通话记录；modeld 继续拥有模型执行；新增观察不拥有执行或第二份产品状态。

首版不增加“通话期间临时切另一个模型”的选择模式。新 TURN 捕获 Bot 当前配置；正在执行的普通文字/语音 TURN 收到 steer 后保留已捕获模型与 revision。受管 provider 失败不得静默回官方，未受管 Bot 保留原生行为。

## 模块位置

复用 `packages/box-runtime/src/internal/host/{session-hook,live-slices,turn-observation}.ts` 与原生发送渠道。新增有界关联/见证放 `host/voice-observation.ts`，必要挂接放 `host/voice-slices.ts`；只有已证明的交付缺口需要纯策略时，使用 `packages/runtime-kernel/src/internal/voice/delivery-policy.ts`。实际发送仍由原生 adapter/writer 执行，不在 nudge handler 调用 provider。

持久观察和读面复用现有 roots、provenance/OBS、`packages/server/src/observations.ts` 与共享 client 合同；不建语音 daemon/DB/第二任务账。公开测试落在 Spec 指定的 box-runtime 与 runtime-kernel 测试位置；不在本票增加 Web 通话页或 CLI 业务任务入口。

## 可执行验收

- [ ] 合成原生入口经过真实受管 session/stream 实现及确定性测试 backend，覆盖空闲 voice wake、已在运行的普通 TURN steer、step-boundary 交付和丢失回队。一次委托可跨回合、多个委托可共享 TURN，不能把观察关联 ID 强制当 stepId。
- [ ] 选择捕获、配置更新、缺失/陈旧 ownership、Host generation 改变、provider 出错与取消都有反例；缺资格不偷走官方路径，观察失败不阻断已有合法模型执行。
- [ ] 明确区分语音 receipt、Box accepted、queued/steer-delivered、执行开始、模型终态、原生发送/事件投递。缺少客户端播放确认时只报告可证明的层，不造 delivered-to-human。
- [ ] 显式发送绑定发起 callId；旧通话关闭后该委托仍欠的结果经原生文字聊天交付并读回。测试旧任务完成时同 Bot 已重拨、新 call 的迟到事件、显式发送与 final-word 兜底重复/误投；普通文字任务在电话播报的原有语义不被全局关闭。
- [ ] 无客户端稳定 ID 时不承诺 exactly-once；相同文字的合法再次请求不被永久吞掉。未知副作用先对账；已接受请求不因超时、挂断记录、leftover wake 或重启自动重跑。原生回执和新增关联的寿命明确，不用诊断 GC 删除执行安全状态。
- [ ] 插话停止音频与用户明确停止工作分开；中途变更保留约束，挂断不隐式撤销有效工作。只有上下文片段到达 Box 时不编造未收到的实时转录，超长/不完整委托显式处理。
- [ ] 默认只投递适合说出的结果及必要进展；不把 thinking/token 全流转交或广播。既有 overheard 内容单独核对最小暴露；公共日志与查询无语音正文、私人指令、凭据或完整 provider 输入。
- [ ] 新 observer/交付接缝进入现有 Host 健康能力、加载与同代见证机制；保持来源/静态/loaded/exercised 分层。运行实际新增测试、受影响旧回归和适用 typecheck/build/制品检查，记录源码身份与未验证范围。

每个修复必须有对应失败反例，不为了“语音专用”重写原生机制。新增测试通过只签其范围；真正的工具执行、客户端接收、音频播报由 [VOICE-03](VOICE-03-live-acceptance-and-coverage.md) 继续验证。

## 非目标与禁止

不强制所有口头问题经 Box，不改 App/实时传输，不新增 STT/TTS/provider，不靠角色提示或工具结果获得系统指令控制权。不直写 Bot profile/store/通话记录副本，不按当前最新 callId 猜旧结果目标，不通过直接复刻原生私有代码绕开能力资格，不因先有 ACK 就取消失败处理。
