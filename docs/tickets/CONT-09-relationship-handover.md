# CONT-09 — 机械关系迁移与旧 Bot 辅助交接

**状态：Partial implementation。关系账本、正式用户身份的有界交接说明、群成员与 Routine 停旧启新已接线；完整外部任务/职责效果约束和多代关系收口仍有差额。新替身接活与关系交接并行，不要求先全迁完。**

源码入口为 [handover 程序](../../packages/box-runtime/src/internal/roots/bot-handover.runtime.ts)和 [Gateway adapter](../../packages/cli/src/gateway-bot-handover.ts)；[CLI 回归](../../test/bot-handover-cli.test.ts)验证命名范围，固定证明见 [生命周期报告](../reports/2026-09-19-continuity-lifecycle-integration.md)。操作与权限边界见 [指南](../maintainers/bot-lifecycle.md)，本票不维护另一份现场结果。

合同：[S13交接](../roadmap/box-runtime-impl-spec.md#continuity-handover)。依赖CONT-03、CONT-04最小逐职责协议、CONT-11；原生Routine复用T53，消息身份与投递复用正式Gateway/ops能力。CLI未提供的原生能力先资格化再公开。

## 目标与模块

新Bot承担已转交业务，程序机械化处理群成员/公告、近期DM联系人、Routine和外部结果路径，旧Bot辅助指路。所有关系逐项记录来源、scope、旧新目标、执行身份、message/task ID、当前状态和读回，不以一个总成功字段隐藏剩余问题。

`io/continuity-relations.node.ts`适配已授权的关系查询/修改，`roots/continuity.runtime.ts`协调，kernel提供逐项规则。复用groups、Routine、title codec和通知边界，不创建另一套关系SoT。

## 行为要求

群成员以当前正式读回为主、转录补充。公告优先合法原Bot身份，不支持且策略允许才以用户身份代为说明；不伪造sender。公告与成员替换独立读回，处理满员、只有一个成员、并发用户编辑和部分成功；不能以过期整个成员集合覆盖当前配置。旧Bot不主动重复群发。

DM只通知可见真实近期联系人；未结任务联系人不受窗口忽略，报告发现coverage。漏网peer后来找旧Bot时限次指路；对一个入站只选重定向或有证据转发一种处置，避免用户重发与程序转发各执行一次。消息accepted/记录/阅读不混淆。

Routine按S13默认暂停与独立move/keep-source策略逐项对账。外部job保留原ID，支持改callback则核验，不支持则旧端接收结果后去重转交；不得重新派一份任务或猜已完成。失败项只阻断相关职责。

旧Bot交接指令在源快照固定后设置，不能带进新Bot成为其职责。包含当前继任ID、指路、旧任务结果交接、不重复派发/群发和不得自行删除。提示词是best-effort，实际工具/触发限制能力另证；偏离按策略告警。

侧栏使用“替身交接期”分区并保留用户其他布局。标题新增独立`handoff=`，owner保留真实归属、用户标题/其他k=v原样保留，不新增session字段，不重复堆字段；投影失败不回滚已接手业务。

## 验收出口

新增typed关系适配、owned消息接收者/任务账本和并发测试：群满/用户同时改成员/公告丢回执、DM发现缺口/重复入站、callback结果重投、提示词不生效、多代继任解析、标题反复同步不丢字段。证明一个关系unknown时另一个已核实职责能继续。

真实群/DM/旧Bot指路/侧栏及费用收据只在[LIVE-CONTINUITY-HANDOVER](LIVE-integration-validation.md#live-continuity-handover)。人工假造消息或模型口头答应不算API效果证明。

## 非目标

不删除原Bot，不劫持全部官方入口，不迁移共享凭据或运行中进程。新Bot上线不是所有关系已迁完；原Bot提示词不是硬权限控制。
