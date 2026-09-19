# CONT-03 — 新 Box 身份的状态 clone

**状态：partial implementation；已注册clone生命周期，具备受控创建、模型选择、原生/语义候选、有限Memory/历史补充与持久初始化；完整资源迁移未完成。**

本轮实现与限定验证见[集成证据](../reports/2026-09-19-continuity-lifecycle-integration.md)。正式CLI/RPC/CONT账本/原生owner与worker适配已串联，结果unknown不重建身份，当前状态后续演进不重导旧材料。真实账户、原App和首轮Provider尚未取证。

源码仍需补附件/引用文件搬迁、源目录删除独立性、更多历史/共享资源覆盖和精确职责约束；不能把已有有界Memory/转录补充说成任意Bot逐字全复制。新的操作指南被工具阻断未落盘，命令面以registry/help为准；本票不因此关闭。

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)与[best-effort材料](../roadmap/box-runtime-impl-spec.md#continuity-material)。依赖CONT-00/02/07/11，不依赖官方duplicate包装CONT-06；后者会清会话，不能当本能力内核。

## 目标与模块

创建真实新Box身份，将声明范围的profile/Memory/历史/当前状态和模型配置装配为目标唯一的工作状态。质量尽力而为、缺口可解释，原生提交是否合法必须严格核实。源Bot保留，关系迁移由CONT-04/09完成。

CLI通过`commands/continuity.ts`、现有Gateway/create/selection接口进入共享operation；Host写入只用CONT-07的initialize/hold/commit/reopen；CONT-02提供固定恢复候选，管理store保存source/target/operation/quality和收据。

**公共前置进展：** CONT-07现已提供真实持久层上的capture/initialize/reconcile协调，持久单次派发、原生reopen/marker核验、异常对账与B2不重导规则已有owned端验证。它尚无安装中的官方原生binding，不构成本票的真实clone；下一步优先完成当前Host资格及该binding，而不是继续把合成端通过当作产品已能换脑。[范围与证据](../reports/2026-09-18-continuity-current-state.md)。

## 顺序与边界

1. 固定源输入范围与质量、费用、目标配置和创建nonce。请求官方Box身份并读回；响应丢失先对账已知对象，不按名字猜、不换nonce再建。
2. 显式抑制介绍/自动启动，目标维持准备屏障，不消费Routine或业务入站。隐藏不是屏障，尽可能不改变App当前选择。
3. 将profile/受管指令、Memory、历史展示和模型工作状态分别校验后原生导入，保留历史来源，当前身份/环境重新绑定；不全文替换UUID或复制旧待执行动作。
4. checkpoint读回、关闭重开并核实目标状态。重启后沿B0→B1→B2发展，不反复读源重建覆盖新工作。native缺失可以按政策生成独立合法语义候选，不能把坏结构当成功。
5. 返回prepared与质量/缺口。单独clone不迁移关系、不启复制Routine、不删除源；激活仍走共享职责判断。允许best-effort而不强求逐字一致。

“血肉”既要能从原生资料/历史读取，又要实际进入后续request，重启后仍在；展示或一次prompt临时注入均不够。源删除独立性必须验证，跨共享Memory和外部文件不整体覆盖。

## 验收出口

新增CLI→use case→原生形状store→真实模型adapter/owned HTTP→新进程用例；验证初始事实、summary/最近tool组、来源、实际request和effect计数。覆盖缺blob/Memory、语义降级、目标创建后立即Temporal、partial写入、取消/丢checkpoint回执、重复导入、源后来增量、源目录清理不破坏目标。

原生资格固定版本、原生writer与实际Server/App分别取证；LIVE只在[LIVE-CONTINUITY-PRIMITIVES](LIVE-integration-validation.md#live-continuity-primitives)，新建空Bot/模型自报记得不能关闭本票。

## 非目标

不原地把Temporal改Box，不构造本地假注册，不完整复制进程/权限，不做多session，不因一个未结job阻止独立clone准备，不把clone成功说成业务已交接。
