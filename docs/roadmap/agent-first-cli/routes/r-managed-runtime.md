# R · 模型执行、原生会话往返与核心日用

归属：[并行拓扑](../parallel-delivery.md)。建议分支`feat/w3-runtime-dogfood`，从当前v2切出。优先结果是完整运行核心，不是另一套Harness或扩大管理页面。

## 目标与先读入口

同一确认Box的Bot可以官方→多个合格自定义模型→官方→再自定义，保持原生会话、Memory/工具关联和实际App体验；正常长会话、辅助推理、取消/失败、checkpoint与重启都成立。先读[T39](../../../tickets/T39-native-model-roundtrip.md)、[T24](../../../tickets/T24-runtime-route-binding.md)、[T49执行资格](../../../tickets/T49-modeld-qualification-and-release.md)、[CONT-07](../../../tickets/CONT-07-current-context-control.md)及[核心LIVE集合](../../../tickets/LIVE-integration-validation.md#core-runtime-lane)。不沿用历史测试对象或旧模型可用性。

## 掌管模块与协作边界

`packages/runtime-kernel/src/internal/inference/`及原STEP/TURN/context程序；`packages/box-runtime/src/internal/backends/`、`internal/modeld/`、`internal/roots/modeld.runtime.ts`；现行模型管理与上下文/Compact领域。Host session/codec/辅助purpose等必要修改由R提出，配方/ABI注册交A统一。正式服务安装/controller交F，原生产品输入和结果观察交D，诊断/保全装配交E。

R先核对`fix/tool-contract-evidence`及`fix/modeld-hot-ledger-reclaim`的实际内容。只吸收仍适用且未等价整合的执行修复；缺共同祖先不直接merge，不恢复旧writer/格式。处置记录给Q，确实影响本次执行安全的缺口是J2前置。

## 分阶段出口

| 出口 | 可开始条件 | 必须交付 |
| --- | --- | --- |
| **R1 核心程序与隔离资格** | J0可开工；原生接入消费A1，运行部署消费F1 | 实际现行选择→Host→Unix→modeld/kernel→SDK→工具/原生checkpoint链；在途捕获、三种选择关系、权限/新鲜度、流终态、工具不重复、辅助Memory/episode、compact/overflow、失败后新输入和跨进程恢复。使用当前原生接口而非旧元组。交J2 |
| **R2 真实旅程关闭** | J2候选/授权齐备，A/F/D/E配合 | 主持Q窗口内的三模型两档、同一长会话、工具独立oracle、原版App、原生Memory/持久checkpoint、官方回程和重启/退出。修复回原owner并经v2候选复验；交J3，不替用户签J4 |
| **后续执行扩展** | J4后或与不相关路线并行 | B/C/D等新增能力的实际执行合同回归；不因全产品继续施工而自动升级日用制品 |

R1不等待B的全局检索/管理CRUD、C的完整替身/退役或W的页面。但会经过的原生Memory、附件引用、辅助调用和必要保全不能排除；实际缺口交B/C的原owner补齐后再关闭R1。

## 验证出口

现有可用入口为`bun run verify:modeld-core -- release-offline`，以及`packages/box-runtime/test/model-switch-pipeline.test.ts`、`test/context-management.test.ts`、`test/compaction-management.test.ts`、现行codec/工具/ownership/持久化相关测试。先针对变化取证，J2再跑适用整体/实际安装/独立审查；不把旧历史计数直接签新提交。

R2遵守LIVE已有模型矩阵，不暗中缩水为一个模型。真实Provider reported未知可以如实未观测，但requested/captured/emitted必须有实际链路证据。compact no-op不算成功，模型猜中事实不代原生读回，SDK工具事件不代工具执行。原版App不是W路线可后置的自有Web。

失败的旧nonce/STEP保持原身份和unknown；不能换nonce重试同一意图、清账本、假回官方或改harness。独立已授权新测试与旧请求对账分开。没有费用/目标授权只阻真实窗口，不在工作树私自发模型请求。

## R1 显式原生隔离验证入口

`GROKBOX_TEST_NATIVE_HOST=1 GROKBOX_TEST_NATIVE_CONTINUITY=1 GROKBOX_TEST_NATIVE_NODE=<native-node> node scripts/verify-host-health.mjs native-runtime` 在同一源码/测试/lock窗口执行原summarizer/archive接纳、原AgentStore/完整图的独立进程读回、原worker事务及跨模型继续执行。缺显式Host/worker opt-in、Node或出现skip均拒绝签通过；`--list`仅列出将执行的范围，不运行原生代码。

`native-model-switch-pipeline.test.ts`复用公开模型切换业务断言，但将JSON重启替身换成原AgentStore→原worker SQLite→独立Node完整图读回，再继续真实modeld/Unix/kernel/SDK请求。外部Provider、official session及工具效果仍是隔离能力；这证明组合程序与原生存储接缝，不是完整原版Agent loop或真实模型/App成功。原摘要、overflow/取消、辅助purpose、B2及管理HTTP边界按同组或对应原生窗口分别取证，不把一种替身结果替代另一层资格。

普通公开测试保持无需私有来源；原生源码只在本机受控声明内执行。固定来源结果可签收对应实现，持续新版本由HOST-01/AH-159另记变化和受影响回归，不要求上游停更。固定回执见[本轮R1原生验证](../../../reports/2026-09-23-native-runtime-qualification.md)。

## 交付

每个出口报告集成tip、实际执行入口、未吸收旧分支处置、原生/合成层级、模型/会话/制品范围、失败与恢复、直接依赖。当前模型支持和真实结果仅写LIVE链接的固定报告；产品规则仍由原T24/T39/context票拥有，不复制第二个“日用完成”状态库。
