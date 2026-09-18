# 原生 checkpoint 闭包捕获与严格读回 · 2026-09-18

本报告固定 `0c0aef5` 之后的 CONT-00/02/07 原生格式切片，不维护动态现场账本。实现合同归 [S13](../roadmap/box-runtime-impl-spec.md#continuity-primitives)，最小原生事实归 [upstream integration](../upstream-integration.md#native-checkpoint-closure)，实际现场状态仍归 [LIVE-CONTINUITY-MATERIAL](../tickets/LIVE-integration-validation.md#live-continuity-material) 与 [LIVE-CURRENT-CONTEXT](../tickets/LIVE-integration-validation.md#live-current-context)。

## 这次实际新增的能力

`host/native-checkpoint.ts` 提供 `createNativeCheckpointCapturePort`，由 `runtime` facade 导出；取得明确的原生读取边界后，使用注入的原生 protobuf/引用元数据捕获不可变的依赖闭包，并接到已有 `openContinuityCurrentState.capture` 和真实 CONT vault。这里没有读取私有路径的生产代码，也没有默认安装 acquire binding。

依赖遍历包括原生 GC/export 刻意跳过的摘要归档和历史 root 引用，处理 repeated、oneof、内联 map、外置子任务状态及循环引用。恢复清单扁平列出可达集合；原生 root 和所有 blob 字节保持原样，不为满足管理清单的 DAG 校验而改写原生内容。读取前传递预算，读取后校验，未知字段/类型、缺引用、同ID异类型、坏JSON/UTF-8以及不完整元数据拒绝该native候选。

`verifyNativeCheckpointReadback` 对比持久root与原生reset后的内存序列化状态；`verifyNativeCheckpointMaterialReadback` 进一步重走实际图并与已固定材料逐项比对。匹配root但缺archive、引用内容被换、原生静默回空均不能通过。返回明确不证明application marker、Memory/展示历史、模型窗口或执行授权。

捕获范围只是所选版本的原生引用图，不涵盖全部文件系统/展示历史/Memory。材料保留对应gap；原生结构中pending工具或子任务运行信息保持unknown_effects，不因保存成功允许重放。过大/不完整材料可以由未来best-effort策略另行语义重建，不能在本reader内截断后继续标完整。

## 实际使用的原生代码

单独限定Host/worker源码对，不改旧 `QUALIFIED_NATIVE_HOST_SHA`：

```text
Host   e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e
Worker 56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e
Schema native-checkpoint-proto-20260918
```

原生读取路径已通过允许的workspace打开，不再以工具路径限制作为未读取理由。测试在内存中选择worker的原protobuf/引用声明和Host的原AgentStore，不执行whole Host/worker入口、不复制私有源码到仓库。共享的引用decoder按实际描述符匹配，四个该版本worker-only decoder明确列出，不伪造其在main中的对应类。

原AgentStore的真实方法证明：固定root槽位可覆写；metadata失败可能发生在blob已经改变之后；reset遇到损坏可静默返回空结构。原生通常openSession还会做repair/maintenance，因此不能直接将其用作无修复捕获入口。这些是需保留的实际接线约束，而非默认认为现有API已满足我们的安全协议。

## 新进程往返及边界

独立Node进程先用原AgentStore生成合成的原生root/摘要/归档，生产capture将其保存进真实私有SQLite/内容vault；删除测试源，再由另一进程用原AgentStore写入测试目标，第三个进程重新加载并核对完整图。当前消息和摘要能进入生产window codec投影，历史archive仍被保全但没有被全量灌回当前窗口。随后破坏目标archive的反例在新进程中明确失败，即便原生root仍可解码。

真实依赖：原生protobuf/AgentStore选定实现、Node20进程、CONT协调/存储/codec与临时文件。替身创建、准备锁、原生DB连接/事务、消息loop、真实Provider/工具执行依旧不是本组依赖；测试目标metadata/blob端口归fixture，不声称生产initializer已经装好。

## 验证

固定Bun1.3.14、Node20.17.0、原依赖锁。公开组合不需要私人源：

```bash
node scripts/verify-runtime-rebuild.mjs continuity-native-checkpoint
```

结果 **82 pass / 0 fail / 401 assertions**。显式原生组合：

```bash
GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-native-checkpoint-qualified
```

结果 **30 pass / 0 fail / 119 assertions**：12项公开reader用例、16项原生隔离性质、2项多进程往返。两组重叠12项，不将它们累加成112项独立测试。类型、构建、Host import边界和包含未跟踪文件的隐私扫描通过。显式组合未设置opt-in时，在运行前返回失败，不接受skip为资格。

最终原生组合验证前后source摘要一致：`7837d0741fb425a395d6e78561ab9f61b0a867f01396b50fec5a249c0462ff79`，771个source/test/lock输入；实际preload为 `ed3e71865fce99fe0292f7a72f84664a537702c0c6137c7efe36ef12ad827d02`。该pin来自真实构建，不是原生Host资格pin。

中途完整组合曾有一次Node child读回超时，没有证据证明是状态丢失。资格工具原先每进程为整份大型Host建AST，已缩小到固定版本中所需声明，仍检查实际描述符。精确处理lazy-init中的类与不同命名空间重名，相关选择器失败在最终重跑前修正；没有放宽产品断言、扩大超时或更新原生pin凑通过。最终组合正常完成，失败结果不改记成功。

## 尚未证明的下一道门

需要把预算化读取和checkpoint/GC共同边界接到实际运行的Host/worker，不能仅以两次相同读数充当锁。目标初始化仍需合法的准备屏障、身份转换、持久application marker与读取/写入生命周期；本次只验证原生格式、选定writer语义和读回，不提供默认initialize或observeApplication fallback。

原生完整Memory/转录/附件导入、实际第一轮Agent loop和模型请求、配置自动接线、reset/spawn/clone命令、独立review和live均未签。本次没有创建/唤醒真实Bot、修改原生状态、读取凭据、重启Host/modeld或迁移运行配置。只有固定整合候选及明确现场授权后才进入LIVE；该读回证明不授执行权。
