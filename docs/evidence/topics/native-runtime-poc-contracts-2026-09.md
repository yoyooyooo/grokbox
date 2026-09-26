# 原生运行接线：普通 Bot POC 的可移植合同

固定依据为 2026-09-26 受控窗口及该窗口的 `runtime/native-hook-routine.cjs`、`runtime/loop.ts`、执行记录和原生回执；另补入同日 14:05 UTC 收场的 [program-update 窗口](../2026-09/2026-09-26-box-creation-feasibility.md#program-update-continuity)。它们是独立 POC，不是正式 v2 默认实现。本文只提炼可复用机制及证据上限，产品差额回原实施票，不新增验证框架。

关联：[Local-first 事实](box-local-first-poc-2026-09.md)、[入口演变](official-client-ingress-poc-2026-09.md)、[私有材料定位](independent-poc-atlas-2026-09.md)。

## 1. 一个 Bot，多种输入作用域

POC 绑定一个准确 Bot UUID 和服务端登记 ID，不按名字或“最近活跃 Bot”选择执行者。执行前和回复前核对 runner 的 Agent 目录及 profile 与本次绑定一致；被停用或归属变化就不继续该自定义执行。

主身份和长期 Memory 保持 Bot 维度，即时对话分为 private、room、routine。群输入必须带准确 roomId；Routine 使用原 automation/run 来源；普通私聊使用其 session。模型状态文件按作用域隔离，Memory 经同一原生 Bot writer 访问。

这守住的是“同一人格、不同会话”，不是把多个群的全部历史混到一份隐藏 session。目录中出现 Memory 也不代表它是当前服务端权威；本 POC 只在当次原 Server 确认 Box 且原执行许可有效的窗口取得正例。

## 2. 原输入身份先于生成内容

原生 messageId、clientNonce、turnUnitId、inferenceRequestId 与任务标识用于关联请求；任务键结合 Bot、作用域及请求身份。对于相同键的完成结果，返回原结果而不再请求模型；输入指纹不一致拒绝，未决状态不能自动重做。

房间级早期实验已经证明，取“最后一条用户文本”不足以绑定原请求。不同请求得到相同正文是合法的，不能用历史里正文唯一性判断重复；应看 nonce、entryId、作者和回执。

**POC 上限**：私有 helper 在原生请求标识都缺失时仍有随机 ID 回退，这不提供跨重试幂等保证。不能把有限正例扩成任意输入路径的可靠性。正式接入应沿原请求与操作 owner，移植关联合同而非照搬这条实验回退。

## 3. 有可见回复，不等于原生回复义务已结清

早期 helper 向原 writer 发送正文，却没有透传本次运行的 ackToken。于是原生历史已有回复，原生可靠性机制仍认为输入未获确认，触发 ack-redrive。

修复保留原 token：非 parent-mediated 回合通过原 send-message 事件写入回复，并将 token 随原结束事件继续传递。没有清空台账、删除义务或关闭计时器保护。

在线证据不只看气泡：输入与 native fulfill 记录中的 token 摘要相同；对应义务和计时器消失；三次普通私聊的 redriveAttempts 均为 0。早期遗漏引发的重复唤醒仍保留为反例，不能算成正常续聊。

**POC 上限**：helper 自己写入 completed 记录并不天然等于所有外部写入都已耐久结算；当次通过来自原生 ack 和历史独立读回。跨崩溃时“正文已写、完成回执未写”的处理，必须沿正式 writer/原操作事实，不以本地记录猜成功或可重试。

## 4. Routine 不是一条普通群消息，也不是只换一次模型

原生 parent-mediated Routine 子任务不直接向用户私聊发布正文。它需要将结果交给原结算链，然后唤醒父 Bot：

```text
Bot 自身 Routine / scheduler
    → 原生子任务
    → 子任务自定义模型与工具
    → finalAssistantText / automationParentWake
    → 原 settlement + 父 Bot 唤醒
    → 父回合自定义模型
    → 原私聊 writer
```

父回合收到的 prompt 可能是原生对象，而不是字符串。接线必须提取其提示字段并保留 Routine/子任务关联，不能丢掉来源后把它写成新的用户输入。

受控窗口中 manual 与 schedule 有不同 run 身份，子、父回合都有自定义记录，并读取同一长期 Memory。真实定时触发晚于原 nextRunAt 投影，所以只证明真实定时运行，不证明严格准点。

停用 Routine 又产生了一次原生事件回合，带来了额外可见说明。该回合被单列，没有混成用户续聊或 ack-redrive。未来统计模型调用必须包括这类事件，不能只计算用户主动聊天。

后续 program-update 的首次 Routine 真实失败于 loop_budget：模型已读算，又写入结果 Memory、重复工具，没有及时完成。修正明确最终文本由原生适配器交付，并在相同四次调用预算内保留最后一轮无工具收束；同一 Routine 的新只读输入、新 run 完成子/父闭环。旧失败及额外 Memory 写入保留，不把新成功倒填到旧 run，也不把增加预算当作完成接线。

## 5. 原生 Memory 是 writer，不是复制一份“看起来一样”的 JSON

POC 的 remember 工具调用 runner.agentState.writeMemory，明确 agent scope，再从原 memoryStore 读回。runtime_context 返回原 Bot 身份、当前会话作用域和同一原生 Memory，因此私聊写入的合成事实能在两个群和 Routine 中读取，群里新增的事实也归同一 Bot。

这与较早的 standalone / tool-delegation POC 不同：早期 remember 写的是自定义会话文件，不应在归档中写成“当时已接官方 Memory”。

**POC 上限**：该 helper 只读取有限数量的 Memory；它证明同一 writer/身份和跨入口共享，没有证明任意规模检索、全部长期材料同步、并发多任务一致性或完整 compact/checkpoint。有限实验用量不能变成正式产品的容量或完整记忆保证。

## 6. 模型和工具控制范围

Loop 复用 v2 的配置读取、requireModel、BackendAuth、ModelBackend、上下文快照合同与 provider dispatch，不重新实现认证或供应商协议。工具只有 remember、runtime_context、multiply 三类；模型根据工具结果继续生成。实验设置了步数、请求数和时长上限，不应作为生产默认硬上限照搬。

选定 runner 的原 runShell 未用于这些自定义调用；原 session/executor 端口的有限 fence 用于阻止被观察到的官方推理入口。没有配置自定义的 Bot 保留原路径。窗口记录为 12 个完成的 Loop 调用、21 次 DeepSeek HTTP 200，包含群 pass、Routine 子父回合和原生事件。

**证据上限**：早期窗口没有真实 Provider 故障注入；后续 program-update 窗口对一个声明输入实际发出不存在的 model，得到 HTTP404，明确失败并正确完成原 ack，后续独立新输入恢复自定义执行，官方对照正常。这个具体失败正例不覆盖全部503/认证/网络故障；没有 fence 告警也不能排除未观察的 Server 辅助推理。官方模型 ID 和账单归因未完整取得，保持 billing not observed。

## 7. POC 不是另一个长期运行平台

实验有自己的 JSON request/session/delivery 文件、活动锁、精确 Bot 绑定和临时 import。完成请求可以只读复用，未知任务拒重放；但会话更新、模型回执与原生显示是多个提交点，不存在跨它们的通用原子事务。固定合成问题、少量工具与串行调用也没有证明完整并发任务系统。

正式移植应把原输入、ack、Routine、Memory、模型选择和观察合同接回 v2 现有 owner。保留原生工厂/调度/持久写者，必要时替换唯一的执行适配；不要长期运行两个主循环、两套 Memory 权威或两套恢复数据库。具体实现选择属于 A/B/C 的生产工作，不由本档案重写。

原始 POC 仍被使用时可以继续留在独立目录；正式产品不应依赖它的绝对路径、旧 PID、实验绑定或历史 source pin。先提炼、再去依赖、最后按准确范围退役，不能因已有这篇档案就删原始回执。
