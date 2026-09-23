# A3-C：当前连续性屏障的资格边界

## 结论与来源窗口

从 AH-138 已交付的 V2 `d94f76f1` 继续 AH-139。现有初始化、启动、回合/checkpoint hold 与 C1 持久队列能够分别验证，但它们不能合并解释为 self-reset 的完整原生屏障。当前真实 Memory producer 仍能在该 hold 建立后提交迟到结果，且 current-state head/revision 不变。

固定来源：Host `bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`，worker `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`。实验前后摘要一致。本次没有修改生产配方、原生写入、现役服务或用户数据。

## 已执行的反例

[原生 Memory 屏障资格用例](../../packages/box-runtime/test/native-memory-fence-qualification.test.ts) 只在显式 native qualification 模式执行，并核对精确 Host 摘要。选定的实际声明在隔离 VM 中执行，不导入完整 Host、不把私有源码复制到仓库。

| 原始声明 | 选定源码摘要 |
| --- | --- |
| `FileMemoryStore.addMemory` | `f4ad6623a05beafe1037e3b57f1f4f53f491e533713fc2a54278e5f358a7c454` |
| `runMemoryExtraction` | `47a2047f3f2e1e297b16d0afc3189614c81a43a96185841431fd5c6e4053b48c` |
| `applyExtractedMemories` | `a8ab2edd09713186ff0acb5301a1c2cdfa8ab4a3572e48df7508b6746db92162` |

第一例通过生产 `createNativeCurrentStateOwner.withBirth/stageBirth` 正式建立 prepared hold。`enter` 与 `checkpoint` 均拒绝，checkpoint 回调未运行；选定原 `addMemory` 仍执行写入，真实字节只落在测试自有临时文件。current-state head/revision 未改变。

第二例执行原 `runMemoryExtraction`，以可控推理替身停在真实 await 边界；在返回前建立 hold。恢复后，原 `applyExtractedMemories` 仍调用原 `addMemory` 写入迟到内容，head/revision 同样未变。

这两个测试的通过表示**反例被稳定重现**，输出明确 `selfResetQualified=false`，绝不是 self-reset 验收通过。Memory 的格式化、去重、IO适配及推理是有限替身；原 current-state owner 的登记/metadata 是自有测试能力。这不是对完整原生 FS/同步/账号的集成证明。没有实际 Provider 或 Bot 请求。

## 为什么属于具体材料 producer 前置

[C1 合同](2026-09-22-self-reset-queue.md) 要求 `SelfResetOwner.withSource` 从 sourceRevision/sourceGeneration/turnSettled 观察到 awaited work 结算维持同一原生屏障，并覆盖迟到 tool/checkpoint/**Memory** 写入。现有 current-state owner 管回合和 checkpoint；Memory store 的原生提交没有加入该协议。

当前 `MemoryService.createAgentStore` 可以创建其他 `FileMemoryStore` 实例；只包住 `registration.material` 的一个对象不能约束其他实例和 await 后的提取提交。文件或当前 root 的两次读取也不能形成提交屏障。直接替换文件/另建 Memory writer 会破坏原材料 owner、User shard 同步与回调责任。

因此，AH-139 需要既有 AH-155 原生 Memory/Project writer 接缝提供其实际依赖的能力：原任务捕获的源身份/版本，最终原生 Memory 提交约束与失效处理，以及原回调/读回边界。这里不要求 AH-155 实现 C2 工作流或全部 B3，也不把普通 Memory 行为说成已经违反其历史合同。

AH-155 现有 AH-123 资格前置尚未完成；执行排程及这条具体依赖由 Linear 维护。A3-C 不能签完整 self-reset，而不是等待已完成 AH-111/AH-133/AH-138，或笼统“待 live”。

## 保留的已验证能力与未签范围

在同一源码树重跑 `native-current-state-owner`、`self-reset`、`bot-convergence`、`continuity-workflow-retention` 四文件：**42 pass，0 fail**。覆盖初始化/恢复/启动 ticket、worker/metadata 部分成功、回合/checkpoint 保护、C1 单次claim与GC、入站缺页/quiet不足及条件删除拒绝。其原生端口和数据为自有fixture，不将其扩大成 Memory writer 已被原子隔离。

另有上述 **2 项选定原生声明的边界反例通过**，必须单独理解其含义。普通 native qualification 关闭时它们显式跳过，不能把跳过当已验证。

条件删除仍缺原生入口封锁与资源独立性证明。当前 convergence 明确 `resourcesIndependent=false`、`deletionFenceAvailable=false`；没有为推进票据而改成普通 delete。AH-138 的有界关系/独立读回可被消费，但不证明完整 ingress、不支持由 quiet 自动退役。后续恢复/资源独立性仍归 C2/C3 和 B3。

## 复验入口

```bash
GROKBOX_TEST_NATIVE_CONTINUITY=1 bun test packages/box-runtime/test/native-memory-fence-qualification.test.ts
bun test --timeout 30000 packages/box-runtime/test/native-current-state-owner.test.ts packages/box-runtime/test/self-reset.test.ts packages/box-runtime/test/bot-convergence.test.ts packages/box-runtime/test/continuity-workflow-retention.test.ts
```

当 producer 接缝完善后，应将当前缺口反例替换为同范围的正向隔离证明，并证明下一输入/迟到结果/重开均绑定正确版本。不要删除负例、不固定旧来源永远绿色，也不以本报告代替原生效果或最终用户验收。
