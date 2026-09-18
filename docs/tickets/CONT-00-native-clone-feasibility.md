# CONT-00 — 原生克隆与恢复能力资格

**状态：部分资格已证；8 个原生隔离探针通过，跨身份恢复未证。**

合同：[Spec S13](../roadmap/box-runtime-impl-spec.md#ownership-continuity)。互操作事实唯一归 [upstream integration](../upstream-integration.md#continuity-import-boundary)。现场索引：[LIVE-OWNERSHIP-CONTINUITY](LIVE-integration-validation.md#live-ownership-continuity)。

## 目标与依赖

识别可复用的官方创建、原生目录 materialization、root/blob reader、session open/checkpoint writer，并明确哪些“clone/read”操作会丢数据或产生副作用。不将目录存在、列表可见、一次 create 回执或模型自报记忆当成恢复成功。

依赖 T37 的 Server ownership、T38 的原生身份 writer 和 CTX-02 原生 context owner；不要求重做历史票，也不调用全局 identity reconcile 来制造资格。

## 当前证明

`packages/box-runtime/test/ownership-continuity-native.test.ts` 对明确 opt-in 的固定原生版本读取 AST，只执行选定原函数；filesystem/DB/network 是 owned fake，未启动 whole Host，未读取真实 Bot 内容。

2026-09-18 执行以下入口：**8 pass / 0 fail / 42 assertions，Bun 1.4.2**。

```bash
GROKBOX_TEST_NATIVE_HOST=1 bun test --timeout 30000 packages/box-runtime/test/ownership-continuity-native.test.ts
```

探针覆盖：新身份重写及 source checkpoint→copy 顺序；普通 duplicate 清会话；不移植 server identity、不复制独立 blob/Memory；原样复制 routine 并取消隐藏；history=true 的内部 helper 仍不足以复制闭包；真实 clearConversation 重置 root/转录/completion；工作态 exporter 在 Temporal/in-flight 时拒绝；无 root 的 snapshot helper 可调用恢复。

这些是原生行为边界证明，不是产品 clone/resume 实现。未 opt-in 时显式 skip 不计作资格；换 Host SHA 后必须重新审查，不能仅更新 pin 使测试变绿。

同轮防回归：`monitor-store.test.ts`、`monitor-commit-boundaries.test.ts`、`context-maintenance-boundaries.test.ts`、`context-maintenance-control.test.ts` 合计 **28 pass / 0 fail / 290 assertions**；`bun run typecheck` 与 working-tree publication检查通过。未运行整个仓库套件，未完成独立架构review；这些旧行为回归不代表CONT-01–05已经实现。

## 后续决策与扩展资格

[S13完整路线](../roadmap/box-runtime-impl-spec.md#continuity-delivery)已经冻结单盒、每Bot唯一当前上下文、best-effort恢复和按职责边接活边交接。旧8探针只保留其实际已证范围，不重新命名为全部能力通过；CONT-06–11及更新的CONT-01–05都有单独出口。

新增资格需识别：原生后台创建和抑制introduction/kickstart；唯一当前状态的hold/initialize/reset/recover及首次startup；固定root槽位覆写与真实内容版本；reset后salvage/prepend不复活旧历史；profile指令装配与重启/compact；Box/Temporal Routine当前管理端、群成员/peer发言身份、侧栏分区和可用删除前屏障。只记录所选版本证据，不把接口名或hidden prompt当满足产品语义。

新测试继续只提取必要函数，以owned依赖运行；未加入源码和执行收据的向量仍为planned。原生事实最小化写入upstream integration，不能把私有实现、用户内容或本机测试身份放进仓库。

## 剩余实验与模块

CONT-03 的 Host importer 从 `internal/host/context-maintenance.ts`、`context-codec.ts` 的原生 owner/版本接口复用，实验须覆盖：

1. 官方创建 `confirmed_box` 的新空 Bot，保留创建 nonce 与精确 ID，证明不运行任何任务；另验证不会改变用户当前 App 选择的准备入口。隐藏不等于隔离。
2. 仅用合成源先导入一份完整 root/可达 blob/Memory，跨新 identity 进行 native accept/checkpoint，再关闭并重开新 session；验证下一次模型输入包含规定 sentinel，而不是重新灌 UI transcript。
3. 文件级实验先在 owned 路径进行：写入时 source/target owner、WAL/closure、root reference、UUID自引用和 pending 状态皆有可检查不变量。缺 native writer 协议时保持不执行，不覆盖活库。
4. 对 Temporal 源分别测试已有 Box checkpoint 可用、只有展示转录、缺 closure 和源已新增服务端消息；输出不同恢复质量/水位，不编造同等成功。

## 禁止与非目标

不直接改原 Bot harness/profile/SQLite，不为恢复调用迁移，不复制凭据、审批、旧待执行队列或运行中网络状态。不包装普通 duplicate 后标 full resume，不把上游上传出口当本地只读备份，不从普通日志重建不存在的精确模型上下文。

本票不启用自动监控、通知、替换、Routine切换，不承担整个产品上线；实际创建/导入/reopen/App 测试在 LIVE 条目登记，完整部署证据不能由本页 8 个隔离探针替代。完整阶段由CONT-05贯穿收口，不能只做第一条实验便将其余已接受能力后移为未规划事项。
