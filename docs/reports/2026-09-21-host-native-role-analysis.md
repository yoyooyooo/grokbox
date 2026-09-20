# Host 原生角色的有界语义验证

2026-09-21。HOST-01 实施工作包，接续 [idle/action-only 适配](2026-09-20-host-idle-layout-adaptation.md)。本报告证明静态局部接线，不是全程序可达、实际加载、Host/worker资格或现场采用。

## 本次变化

原三个 checker 升至 revision 2，仍在同一 Rust library/binary 内；Node 的必要检查声明与握手同步，不回退 revision 1。wire 形状、TS唯一变换、profile publisher、实际采用与执行权限不变。

[原生角色识别](../../crates/host-verifier/src/native_roles.rs)不再要求整份 bundle 只有一个 `inference.createSession`，也不把一个正确的导出旁支当成原生主链。先从 `createTurnRunShell` 的实际词法绑定、返回的 run、直接等待或原 CONT fence 转接到 runTurn，选定主会话；独立 summary 必须明确标注其原生角色。追踪 trace 回调实际调用及 await 返回，检查 options 的有限对象/条件 spread 写集合，核对 agent、TURN 和 nonce 的原始绑定。动态对象、字段覆盖、错引用及不支持的调用形态拒绝。

TURN retry 沿 `createStreamAttempt`→返回 run→有界 retry closure→实际 executor 的 `isRetryable` 参数建立有限关系，核对传入及判断的是同一个 caught error；原 managed 分支必须先终止。checkpoint 位于原类的 runStep 方法与被消费的调用/回调链，核对同一 ctx/state/save 绑定及嵌套 await。原生 stateHandler 的其他元数据写入不再被误当成 `computeNewStructure` 替换；直接/动态方法覆盖、删除和显式 Object.assign 仍拒绝。

这些谓词只覆盖上述有限语法、绑定与局部消费关系，不推导任意别名的 heap effects、动态原型修改、所有外部调用者或完整 lease/finally。运行见证及未覆盖切片仍独立显示，`qualified=false`。

## 独立反例与真实发行链

新增公开 [native-roles.cjs](../../test/fixtures/host-verifier/sources/native-roles.cjs) 和 [Rust反例](../../crates/host-verifier/tests/native_roles.rs)，不是从私人Host复制整段实现。包括等价重命名、原CONT转接、summary与main分离、正确旁支掩护错误主链、未使用retry closure、反向错误门、错exception、trace提前返回、未调用箭头、方法替换和checkpoint await丢失。语义变体保持合法JS，不能只靠unknown-sha或语法失败通过。

[正式Node测试](../../packages/box-runtime/test/host-verifier.node.ts)使用安装布局中的实际Rust/FD，核对revision 2、三种语义破坏的实际候选摘要，以及旧revision被明确拒绝。没有测试时替代生产分析器。

## 固定磁盘观察

同一个正式资格入口对磁盘source/候选/worker重新完成分析，没有加载或执行私人Host。source仍为`2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`，26,523,565字节；candidate仍为`ab28117e86cdb619350f25813f311d2326d797074dc00bb85778516283381378`，26,547,337字节；worker仍为`56f87fa9fe599610b6c8201540ec3b510cc36a4535f629e2600aaf3cb90d7c4e`，677,638字节。

三份artifact严格parser/semantic诊断0。三个revision 2结果分别为 `native-main-local-wiring`、`entry-guard-terminates-managed-branch`、`compute-await-before-persist-await`，全部passed。此次分析1816ms、整个命令16717ms，只有单次测量意义。binary build为`7a53d6a5620130fdf28f7cce7620fa3e50e219b0660ecc38df0771894cb8624a`。61片候选字节与前一工作包相同，没有改候选求绿。

## 提交时验证范围

源码`fc3f3e04711dcd53c9b3f53a6541708d6263e013adb645e9a622adab967d6145`，1176个输入。core窗口463项/47文件通过且前后一致；Rust30项、根/Web typecheck、wire生成一致性通过。另一次focused窗口9项/4文件通过，包含实际verifier Node22、边界Node20、Host管理Node10；内部计数不叠加到外层数字。完整integration/Chrome/tarball的最终组合在本大阶段结束前另固定，不借用上一包486项。

Host/worker仍为unreviewed-pair，完整opportunity/lease/原生运行仍未签收；未发布profile、修改原生资料、调用模型或发送外部通知。并行VOICE规划保持原暂存状态，不混入本实现提交。
