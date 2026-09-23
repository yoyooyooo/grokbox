# 核心观察与保全闭环 · 2026-09-23

本报告固定 AH-121/E1-I 的采用前证据。基线为已完成 A2 的 V2 `8a4b40ade784e12a4af5ba228f3e6870b2cc5274`；不代表 J2 已授权采用，也不把隔离能力改写为真实 App/Provider 或 24 小时运行。

## 固定入口

新增 `node scripts/verify-host-health.mjs core-observation`。它要求显式 current native Host、continuity 和 Node 资格输入，缺任一输入都会在开始证据运行前拒绝。

验证 manifest 只维护 E1 evidence 文件集合，不复制 monitor、incident、protection 或 notification 运行状态。当前是 **31 个不同 evidence 文件、10 个受控进程**，清单要求并集完整、互斥、无遗漏和无重复。

## 证据范围

E1 固定入口覆盖：
- input/execution/error/unknown 到原 journal、SQLite cold read 和 CLI outcome 的关联；
- 当前 Host 观察、原生消息/SQLite、source missing / stale / detector failure 不假健康；
- monitor 单 owner、迟到结果、gap、重启、原子提交、retention、read-only 与 bounded query；
- 默认 protection、ownership pause、材料保留、策略关闭后的历史只读与 SIGKILL/restart；
- notification 显式授权、revocation、future-work fence、unknown no replay、单次 POST 和 structured shutdown；
- 诊断容量 admission、维护持有 writer、失败后未来周期继续、至少三个维护周期、关闭结算与 packaged owner SIGKILL；
- management worker inventory / effectivePolicy，以及 observation / incident / notification / protection 的真实 Node HTTP 管理边界。

真实 live duration、真实外部接收者、真实 App、现役 Host loaded/attachment/exercised 仍归 J2/J3/LIVE。

## 首轮联调发现

首轮把四个通知套件放入同一个 Bun VM，得到 78 pass / 2 fail：一个 packed query 超过原 15 秒测试预算，另一个在 esbuild 报 `The service is no longer running` 后失败。

没有修改生产通知逻辑或扩大测试预算。四个套件分别在独立 Bun VM、原测试预算下复验：
- automatic notification：25 pass；
- notification outbox：26 pass；
- native notification：22 pass；
- authorization contract：7 pass。

因此固定入口把四个编译/打包 owner 明确拆成四个顺序进程；清单测试锁住每个套件恰好一个独立 command。第二轮及最终窗口全部通过。

## 最终固定窗口

源码/测试/锁共 **1291** 文件；before/after 均为 `ed0a03bcad1f4a68bdd1a0e2bb58548168c7baaa33d32106aec592d18f612bed`。Host=`bfa76e4e…`、worker=`da6796b2…`，窗口结束未变化。

| 入口 | 实际结果 |
| --- | --- |
| build / type / Rust | build、根/Web typecheck、协议和 Rust 39 通过 |
| core-observation | **230 pass / 0 fail / 0 skip**，31 文件、10 组 |
| core | **1507 pass / 0 fail**；18 条命令均 close 结算 |
| docs | **16 pass / 0 fail** |
| publication | **1628 blobs / 0 findings**（最终提交前另扫描 untracked） |

core-observation 的 management wrapper 内部还实际运行 protection 24、observation 13、incident 19、notification 44、first-setup 18 个 Node 子测试；这些不与外层 230 重复累计。

## 边界与下游

当前 worker 清单是 monitor、notification-outbox、protection。自动通知仍需要显式 ongoing authorization；未启用时 local-only，不把“可发送”写成“用户已收到”。桌面不是本 E1 Server 后台 worker，不因 UI 能力存在而获得自动副作用许可。

`installationBudgetEnforced=false` 继续准确表示当前容量门只覆盖协作诊断 writer，不冒充 OS/全安装 quota。E1 的容量验收来自真实 writer admission、持久 SQLite/日志、维护周期及关闭/重启证据，不靠将此标志改绿。

没有发现需要新建 B/C blocker 的核心数据安全缺口：当前必要保护使用原 CONT persistence，ownership loss 先阻准入，unknown/COMMIT 丢回执不重放，源缺失和损坏 store 均 fail closed。后续完整材料迁移/退役仍按 B/C 自身 DAG 推进，不作为 E1 已完成核心候选的隐式前置。

本票完成后 Q/AH-122 可以消费 `core-observation` 与 A2 的 `core-risk` 两个固定入口；独立审查、实际候选安装及 J2 授权仍是 Q/J2 自己的验收，不由本报告代签。


## 通知 fixture 收尾与最终复验

在固定入口首轮暴露的通知生命周期串扰之后，最终补齐了测试 owner 边界：`ops-notification-outbox` 的 packed CLI 构建移到 `beforeAll(..., 90000)`，因此原 15 秒用例只计业务场景，不再把 fixture 构建算入；automatic/outbox/native/authorization 四类通知证据继续各自独占 Bun 进程。生产授权、HTTP、重试和持久化逻辑未改变，原业务 timeout 未扩大。

直接复验 outbox + native notification 为 **48 pass / 0 fail**。随后从头执行最终代码窗口：

- build：通过；
- core：**1507 pass / 0 fail**，Rust 39、根/Web typecheck、协议通过；
- core-observation：**230 pass / 0 fail**，10 组全部 close/settled；
- source/test/lock：1291 文件，before/after 均为 `83c01a12ac8a4aae8f177f3a335c6436d8f2481705d4d37a0a668dc708e42ce9`；
- Host `bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`、worker `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`，窗口结束未变化。

本节 supersede 本报告更早、fixture 修复前的源码摘要；测试职责与 E1 产品结论不扩大。跨入口和 management wrapper 内部 Node 计数仍不重复累计。
