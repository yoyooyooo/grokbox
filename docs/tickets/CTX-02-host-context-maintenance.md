# CTX-02 — Host 安全点与唯一上下文维护程序

Status: **Planned / Spec-only** · M2。2026-09-17规划基线 `7994b92`；无本票实现/验收提交，没有修改原生Host或运行会话。

## Goal / authority

把新输入、restore/模型切换、工具结果后的发送前检查，以及空闲手动维护，接到同一个真实root owner。维护不再依赖已有active STEP或上游失败，已有pending摘要能够有界收口。唯一合同为 [Spec S12.1/S12.4–S12.5](../roadmap/box-runtime-impl-spec.md#context-maintenance)；Host继续写root/archive/carrier/checkpoint/队列，kernel拥有预算操作和Effect寿命。

## Depends on / reuse

依赖 [CTX-01](CTX-01-context-policy-and-meter.md) 的冻结budget/policy/identity合同，复用T35已有provider前slot、root guard、错误/outer-retry边界、S10 authority/Scope与F1/F2状态保真。T35未完成的pending/实际接受资格进入本票，不开第二施工路线。可先使用同合同无网络摘要替身验证owner；真实摘要与费用限制由CTX-03接入，不能用替身签整个能力完成。

## Module / change set

- 新 `runtime-kernel/internal/inference/context-maintenance.ts` 为唯一操作程序；演进 `ports.ts` 中既有 `HostCompact`，显式inspect/prepare/accept/readback与root版本/operation身份，不保留旧并行执行器。
- 改 `box-runtime/internal/host/{compact,context-budget,live-slices,session,session-hook,modeld-client.node,profile}.ts`：真实输入/restore/工具完成安全点、IPC前有界计量、候选与接受分离、原生队列/状态适配。切片须exact source/唯一anchor/生命周期资格，不直接patch App。
- 改 `modeld/{server.node,same-connection-compact}.ts` 与kernel `step-program/overflow-recovery`：budget/purpose/maintenance identity控制面，显式下一wire同代执行。CLI和Host不能通过任意RPC取得root写权。
- 扩展既有ExecutionHistory存有界typed维护claim与结果引用；Host持久root记录真实提交。无摘要正文/历史副本/credential；旧service请求不能跨重启自动执行。
- 目标测试 `runtime-kernel/test/context-maintenance.test.ts`、`box-runtime/test/context-maintenance-host.test.ts`，复用host-compact-control/lifetime/coordination和实际Unix夹具；注册 `context-owner`。

## Acceptance — executable targets

实现后 `bun scripts/verify-runtime-rebuild.mjs context-owner` 必须实际执行CTX-A04/A06/A07/A08/A10/A11/A12/A14的owner子集，缺原生隔离fixture不记绿色skip：

1. 真实合法root/ctx/身份已存在、provider未启动时可维护；无assistant首次restore与旧失败会话也能到达。空闲manual拥有operationId而非伪STEP，空session合法、歧义明确拒绝。巨型root在完整CCS/IPC序列化前按owner材料分区，不用静默裁剪。
2. 同root并发操作合并到单一source/accept owner，重复operation输入不变只读/等待，输入变化冲突；不同root/会话独立。首waiter取消不能取消其他有效waiter的工作，最后waiter/parent取消按明确source owner收口，不留脱离Scope任务。
3. 已完成pending候选前缀匹配则验证/采用；独立pending有界等待；依赖暂停STEP的self/未知任务不形成环，不抹Promise或永久blocked。所有主请求占满槽时摘要仍可推进；取消后真实producer/资源收口。
4. 候选在活跃root修改前完成结构/目标验证；非法/空/仍超预算候选不覆盖旧root。prepare/summary/validate/accept前后取消、root版本改变、Host换代、正式归属撤销均有writer侧fence；持有旧mutator引用的迟到callback也无法写新root。
5. 原生root提交与checkpoint后的回读、新进程重建、提交前故障/提交后回执丢失分别核对；unknown不说回滚/未发生，不重复生成摘要或重放业务。metadata索引不能替代Host提交证据。
6. 新输入保留原nonce/附件/顺序，压缩成功继续一次，失败/取消保留实际未执行状态；旧失败STEP仍失败、旧工具副作用不重做。schema/policy改变只影响下一TURN；活跃manual遵守捕获值，不能热换模型/effort。
7. 父剩余期限覆盖所有阶段且预留后续主请求/结算；心跳/重连/新waiter不续租。官方未opt-in对照的root/summary/retry行为保持，不将所有原生后台入口全局关闭。

## Forbidden / non-goals

不从UI/store.db/整个archive重建第二prompt，不另写会话数据库，不让kernel直接修改Host文件，不复制原生私有代码到公共fixture。不得把Promise.race取消当root回滚、Scope当事务、消息数减少当候选成功，或把现有抑制摘要的patch本身当维护能力。摘要模型实现、命令最终体验与live验收分别交CTX-03/04。

## Exit / remaining evidence

本票Done需owner程序、接缝退旧、公共离线合同、可取得的原生隔离消费者资格与固定提交独立review；完整native/lifecycle必需输入缺失仍留本票 **blocked/not_proven**，不能统称live-only。真实加载/用户App和现场checkpoint采样另由CTX-04的LIVE条目负责。当前全部新实现/证明 **not-recorded**；T35已有子证明继续保持原范围。
