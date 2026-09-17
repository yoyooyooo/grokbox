# CTX-02 — Host 安全点与唯一上下文维护程序

Status: **Implemented / offline and pinned native-isolated proof recorded / independent review pending**。主要实现 `883e224`，提交读回修复 `269f1e2`，TURN授权一致性修复 `f4b3a18`，手动入口的不确定提交/取消与队列阻断修复 `5f2afdb`。没有把隔离原生方法验证称为已加载或完整原生存储事务。

## Goal / authority

普通输入/restore/模型切换/工具后的安全点与空闲手动维护共用真实root owner；Host继续拥有材料、队列、archive/carrier/root/checkpoint，kernel拥有唯一维护程序、预算和Effect寿命。唯一合同为 [Spec S12.1/S12.4–S12.5](../roadmap/box-runtime-impl-spec.md#context-maintenance)，算法来自[CTX-00](CTX-00-pi-compaction-reuse.md)，策略来自[CTX-01](CTX-01-context-policy-and-meter.md)。复用T32/T35/F/E，不另开施工队列。

## Actual modules / ownership

- kernel `context-maintenance.ts` 执行inspect/plan/summary/validate/commit/readback；同root、同操作waiter共享source并有独立取消，最后waiter取消才中断source。当前不同operation占用同root时有界busy，不同时建立两个writer。`5f2afdb`补实际manual facade→Unix→SDK六种分支：成功/503、checkpoint和append不确定、发布前后取消。发布已开始的失败不误报材料无效，owner等待真实checkpoint；不确定root阻断当前与后续排队输入、换operationId也不能越过，状态明确blocked/nativeBlockReason。
- Host `context-maintenance.ts` 是Effect/Pi-free原生facade，`context-client.node.ts`/`context-control.node.ts`借真实native执行及空闲summarize动作，`context-slices.ts`/`live-slices.ts`负责exact-source安全点。手动入口当前限定已加载默认Box session，WeakMap可信标记不来自用户正文；不伪造业务STEP。
- modeld `context-maintenance.node.ts`与`wire/context-wire.ts`提供wire8有限协议、分页材料和逐消息seq/大小/身份校验，无generic eval/RPC。
- ExecutionHistory记录操作/阶段与提交引用；主STEP/绑定仍在原域，maintenance记录跨服务重启保留以防未知摘要重发。Host持久root是提交事实，维护索引不保存第二份完整历史。

真实candidate先完成sourceRef覆盖、工具组、固定输入、metadata、目标预算与native carrier验证，之后才释放原生accept。回执必须绑定同operation/sourceRootRevision和实际material/rootRevision；不一致为commit_unknown，不能再次生成摘要或声称回滚。原生archive写入、root发布、checkpoint与ACK是不同阶段，不把Effect Scope当事务。

可独立结束的pending经原owner取消并等待，未确认停止不竞争写；同STEP自依赖摘要明确busy而非盲等/抹Promise。取消/换代/闭合root lease在实际writer侧检查，包括迟到callback及保存过的mutator；commit之后取消不声称撤销已写root。未资格化的self-document/preCompact-hook/resource链仍拒绝。

## Executable proof

```bash
bun scripts/verify-runtime-rebuild.mjs context-owner
GROKBOX_TEST_NATIVE_HOST=1 bun scripts/verify-runtime-rebuild.mjs context-native
```

公共owner与实际Unix链分别在 `context-maintenance-{host,boundaries,lifetime,control}.test.ts`、kernel `context-selection.test.ts`及CLI命令测试。私有原生源码仅在维护者显式选择的隔离VM资格中读取，公共CI/fixture不包含私有实现。native方法测试使用固定SHA，外围blob/telemetry/privacy能力仍被隔离；版本变动需重验。

[离线报告](../reports/2026-09-17-context-maintenance-offline.md)记录实际pipeline、取消/已有pending/错root、十轮/新进程、key轮换及native-isolated执行结果。合成Host方法与真实原生隔离结果分别标注，没有用mock最终成功代替实际调用链。

## Remaining / release boundary

独立review未完成（已请求但503无报告）。全原生archive/checkpoint的新Host进程读回、真实App输入/活动/交付及受控现场未知结果对账，分别由[LIVE-CTX-NEXT-INPUT](LIVE-integration-validation.md#live-ctx-next-input)和[DURABILITY](LIVE-integration-validation.md#live-ctx-durability)拥有当前状态。不把这些范围说成已通过，也不把本票的源码/review缺口移到live。

禁止从UI/store.db/整个archive另拼prompt、Pi Session持久化、静默截断或绕原生writer。named/server/subagent与自依赖pending的支持限制是明确边界，不因现有默认Box旅程通过而扩充。
