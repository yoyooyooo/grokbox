# 2026-09-12：Managed Compact 早期规划与交接摘要

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

**历史背景，不是当前Spec、部署回执、worker指令或授权。** 合并原owner briefing、technical path、orchestrator handoff中仍解释设计原因的内容。当前施工从[Spec](../roadmap/box-runtime-impl-spec.md)、[Tickets](../tickets/README.md)进入，当前运行版本证据、现场未验项与下一步只看 [LIVE 唯一索引](../tickets/LIVE-integration-validation.md)。本页不保存另一份“当前PID/完成度”。

## 原材料与保留依据

| 原文/版本 | 仍有价值的内容 | 去向 |
|---|---|---|
| `pre-publication-revision` 的 managed-compact-path | L5顺序、同连接恢复、等待环与A/B/C选择 | 本页历史解释；当前合同归T32/T35 |
| `pre-publication-revision` 的中文owner brief | “会话连续是目标，Host摘要只是手段” | 已进入Spec S0，不再等待再次批准 |
| `pre-publication-revision` 的orchestrator handoff；`pre-publication-revision` recenter | 两仓分工、旧分支与回执定位、当时的未证边界 | 分工见AGENTS/文档索引，工作树收口见T40，实际旧文本可从Git读取 |

旧路径保留短跳转以接住历史引用。原完整已提交文本可按上表Git版本追溯；本轮未删除或修改任何Git历史。未提交的后续口径已经归并现有Spec/Ticket，避免在历史稿保留互相冲突的“现在要做什么”。

## 当时为什么卡在首请求溢出

早期固定Host顺序：记STEP身份 → 启动executeToolStream → 可选background summary → stepClosed → 注册compact slot。更小窗口模型可在首个请求立即overflow，此时恢复能力未就绪，或被已启动的摘要阻挡。

当时观察分为快速断连/unready或blocked，与约5秒等待到期两类。分类器命中、CF日志出现、消息数量下降都没有证明实际resume成功。单纯调大计时器解决不了注册晚于请求的问题。

讨论的三个选择是：A补齐真实等待点/生命周期；B增强日志以区分拒绝原因；C接受快canary不通过而等慢触发。A成为主线；B只是诊断辅助；C不能覆盖实际首请求就溢出的用户场景。这个选择已经完成，不应再从旧文档恢复“等待owner A/B/C”的门。

## 仍然保留的设计理由

Host继续拥有摘要策略、分区、carrier、归档、root与持久写入。Managed attempt0/attempt1沿原TURN/STEP/binding恢复，专用external summarizer不回到正在等它的managed STEP；不另建compressor，不从UI/store.db拼prompt，不使用Host外层新STEP重试绕过恢复预算。

新资格不只需要register-before-stream，还需要真实root/ctx已有效、同root摘要协调、父期限、取消/换代后的接受fence和外层TURN retry控制。当前细节及真实证据归[T32](../tickets/T32-runtime-confirmed-compact.md)、[T35](../tickets/T35-host-compact-wait-point.md)及[原生seam](../tickets/T32-host-compact-seam.md)。

## 旧结论被哪些事实更新

- 本地harness-stick曾被当作接管进展；后续原始Server查询确认test2为Server temporal/local box冲突。它现为T38反例，不是heavy正向canary。
- “有Gateway currentActivity就只剩像素问题”被实际renderer分析修正；Working有会话/运行代/来源层次，归T36，不是清缓存或Cmd-Q即完成。
- 早期F3容量/usage被当作可延后项；当前日用旅程依赖的真实预算仍须满足T39/T32/连续性合同，不能用旧排序缩减发布门。
- 旧GATE授权、PID REDACTED_PROCESS_ID、preload1577f418、worker偏好、10分钟routine与暂缓某review的叙述都是当时快照，不是本轮运行/权限证据。
- 旁支commit数量不等于缺少代码；export已port、control-frame/GATE等需语义核对，当前收口在Ticket索引/T40。

## 回执与知识分工

早期机内收据引用：`PRIVATE_EVIDENCE`、`PRIVATE_EVIDENCE`、`PRIVATE_EVIDENCE`。它们不是公共CI输入，本页不复制内容；路径存在与访问权限须在实际使用时核验。

grokbox保存公开产品合同、自己实现与合成fixture；私有grok-bot保存原生App/Host研究与版本核对。禁止把原生dump、真实会话和凭据搬来为了补历史。工具拒绝或缺回执时说明缺证，不据此回填“已完成”。

此历史摘要只有新增因果证据/追溯错误才修改；新范围、后续顺序、功能状态进入其Current Home，不给本报告追加下一轮任务。
