# 正式退出恢复、固定安装与 a22d48c 重新配对

2026-09-27。AH-187 统一集成，延续[候选准备](2026-09-26-live-unified-integration.md)。当前现场只由 [LIVE](../../tickets/LIVE-integration-validation.md) 汇总；本报告不继承 POC 的业务和更新成功。

## 已执行的退出恢复与安装

同一独立只读审查者对 `3dafd5c35602a431bc5abdc57fe917c80549b121` 复看，两项 P1 均解除，限定范围内无新增发现。该提交已串行快进合回 v2，未 push。构建、controller/CLI 回归及 publication 检查通过。

该固定提交通过正式 pack 安装；98 个发布文件逐个摘要读回一致。包中重复出现的 `bin/grokbox` 两份字节相同，首次停止后的部分安装经完整核验才继续。生产依赖安装后，固定 Node 22.22.0 下 sqlite3 6.0.1 / classic-level 3.0.0 原生检查通过。全局 shim 未切换。

使用该安装目录的正式 `runtime operation-recovery --restore-operation … --confirm`，得到 `interrupted-official-exit / physicallyRestored:true`。五项原证据摘要不变，controller 仍为 8 unknown / 0 running / 51 terminal；未清锁、发信号、采用或授权重放。这仅完成原物理退出结算。

`75c8f81` 上先发布 41 切片，再由原 writer 加入 current-state，最终 63 切片的变换摘要与此前隔离候选一致。首次完整发布进程被 SIGKILL，原因未确证；独立读回确认旧 profile 字节和时间未变。保留失败后，以相同 CAS 输入和有界 Node heap 重试成功。正式 Server/modeld 从固定制品启动；仍属前台验证范围，不具有开机持久性证明。

## 采用前来源再次变化

采用前完整原文核对发现官方自行更新到 `a22d48c`，Host SHA 为 `462603791cf7516915084d175cb96125241cacb1352e2e42fb100ebe4feb71e0`，worker 仍为 `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。检查在保存采用请求前终止，未执行 Host 信号或创建 Bot。新完整来源由正式 observe writer 保留，没有覆盖旧原文。

再次观察原 modeld，service epoch 未变，accepted/completed/activeSteps 均为 0。此前准备窗口的服务持续存在，但没有把暂停期间解释成新的现场采用或模型执行授权。

## 当前源码差额与复验

唯一当前配对改绑新 Host，worker 与 disposer 函数摘要不变。会话材料的原路径 binding 变为 `import_node_path143`，沿原 materialization owner 修正；独立复制夹具、摘要 logger 和 disposer 后邻声明也按当前原文更新，没有增加历史执行路径。

- `native-pair`：40 pass / 0 fail，包含完整 63 切片、四项 Rust 正向语义检查及四项有效 JavaScript 反例。变换 Host SHA 为 `faad30368ce732b04e6739c7bf42a16bc139779c2d02ac61b6acc1a373c86a41`。
- `native-runtime`：4/4 commands、88 个外层测试通过；内层 Node 用例不重复相加。
- 当前 Local-first 与原生模型预览：2 pass / 0 fail、113 assertions；没有真实账号或 Provider 效果。
- 类型、CLI/Server/Web 构建、文档 16 项与 publication 检查通过。

首轮夹具绑定错误和打包失败保留。后续完整升级用例在组合运行中失败，单独运行 8.3 秒通过，整组重跑也通过；未放宽原断言或超时。验证器继续只给 `passed-in-selected-scope / qualified:false`。完整官方 Host、真实 Provider、App 和费用均不由这些结果证明。

## 此记录结束时的边界

新来源的源码配对已完成，尚待固定新制品、正式发布当前 profile、实际采用和一次静默 canary。静默创建 request 仅已规划，尚未发送。模型前置选择、业务矩阵、正式通知出口及正式程序更新连续性仍未验收；费用仍为 `billing not observed`。
