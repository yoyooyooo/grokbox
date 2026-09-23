# 核心可达补丁风险闭包 · 2026-09-23

本报告固定 A2 的采用前证据，不是现役加载回执。候选基线是 V2 `13f2296f701faa670d15e39ee9a9d2e25e1e0339`；当前磁盘 Host `bfa76e4e…`、worker `da6796b2…`。实际采用后的 loaded/attachment/exercised 仍只归 LIVE。

## 可达集合与证据层

唯一 `HOST_RECIPE` 为 core 39、checkpoint 3、currentState 19，共 **61** 个切片。新增的 `host-core-risk-manifest.mjs` 只是验证清单：测试要求它与 recipe 完全相等、每个 slice 恰好一次；它不是第二个运行状态库。

A2 分五层理解证据：
1. **applicability/static**：唯一锚点、有序 recipe、Rust/Oxc 四项有限语义规则及合法 JS 破坏反例。
2. **compile/candidate**：61 片完整候选可生成、语法有效，worker 候选与原依赖摘要明确。
3. **hook/reference**：preload/capability witness、RPC/symbol 注册与缺 hook fail-closed。
4. **opportunity**：官方 passthrough、managed retry、compact、辅助调用、观察、ownership/resume、startup/current-state 的隔离行为。
5. **delivery/effect**：工具不重复、checkpoint 写序、原 worker SQLite/冷读、消息/历史/duplicate 与取消释放。

前四层或五层的离线通过均不声称 Host 已加载、某 Bot 已调用或真实 Provider/App 已成功。

## 本轮发现的来源演进

首轮 `core-risk` 为 63 pass / 1 fail：`native-receiver-model.test.ts` 仍固定旧 Host `e7031f…`。当前来源是 `bfa76e…`。没有直接改 pin 求绿；先对当前完整 recipe 抽取原 `createHostInference` 及七个原生选模函数，在环境 override × 实验 control/treatment/undefined 组合中核对预览与真实 automation session 的模型 revision。

该原生正例重新得到 **1 pass / 72 assertions**，且预览阶段 session=0、experiment-applied=0、auth=0；真实 session 只在随后明确调用时创建。随后才把独立 receiver 资格 pin 更新到 `bfa76e…`。生产 receiver/slice 未修改。

## A2 固定入口

`node scripts/verify-host-health.mjs core-risk` 需要显式：
- `GROKBOX_TEST_NATIVE_CONTINUITY=1`
- `GROKBOX_TEST_NATIVE_HOST=1`
- `GROKBOX_TEST_NATIVE_NODE=/exec-daemon/node`

缺任一输入时在运行任何证据前拒绝。当前固定窗口为 **289 pass / 0 fail / 0 skip，42 个不同 evidence 文件、7 个顺序组**；源码/测试/锁摘要前后 `121c4217fc95f543c38110d54e49741df7ca675009d2454ac4b1e3675969d41c` 一致。

完整候选摘要：recipe `34b214eb…`，candidate `830a2c20…`，worker candidate `8eb521da…`。四个 Rust/Oxc 正例通过，四类保持合法 JavaScript 的语义破坏均为 violated。静态检查只有四项，明确不等价于 61 片全部行为资格。

## 共享故障域结论

已覆盖官方 passthrough、非目标 Bot、工具 effect、Memory/episode 辅助链、checkpoint/lease、取消释放、ownership/resume、startup/duplicate、观察只读边界和 native writer 保留。完整原 Agent loop、真实账号 Provider/App、现役 loaded/attachment/exercised、J2 独立审查及采用后恢复仍未由本报告证明。

A2 完成后，E1/Q 应消费这个固定入口和候选摘要；新 Host SHA 继续由 HOST-01/AH-159 分类为新观察、recipe 失配或具体行为回归，不自动抹去已经签收的历史窗口，也不自动取得新资格。

## 最终组合回执

在上述代码固定后，从头执行同一输入窗口；源码/测试/锁共1288文件，before/after均为 `121c4217fc95f543c38110d54e49741df7ca675009d2454ac4b1e3675969d41c`。声明工具链 Bun 1.3.14，native Node显式 `/exec-daemon/node`。

| 入口 | 实际结果 |
| --- | --- |
| build / protocol / type | build、协议、根/Web typecheck通过；Rust 39 |
| core | 1505 pass / 0 fail；18条命令全部close结算 |
| core-risk | 289 pass / 0 fail / 0 skip；42个不同evidence文件、7组 |
| native-runtime | 90 pass / 0 fail / 0 skip |
| native-pair | 34 pass / 0 fail |
| release-offline | 695 pass / 0 fail / 0 skip；`passed-offline` |
| docs / publication | docs 16；1624 blobs / 0 findings |

包装内外及跨入口计数不相加。窗口结束再次读取 Host `bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`、worker `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`，未变化。

A2 给 Q 的结论是“采用前核心可达补丁风险闭包完成”，不是运行采用许可：candidate/profile/loaded/attachment/exercised/真实Provider与App均按各自后续门继续核对。
