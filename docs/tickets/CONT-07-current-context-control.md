# CONT-07 — 唯一当前上下文的原生控制

**状态：部分实现。** capture/initialize/显式reconcile协调程序、有限native port和接缝校验已实现，接入真实CONT持久层；安装中的官方Host decoder/hold/writer仍未绑定和资格化，reset/recover/spawn/clone CLI未交付。

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00、CONT-11和CTX-02；接口可先用owned fixture，产品reset/recover必须先满足CONT-02保全。为CONT-03和CONT-08提供最小公共内核，不先建设多会话平台。

## 目标与模块

同一长期Memory身份只有一份当前工作状态。提供观察、原生hold、initialize、reset、recover、commit/read-back/reopen及激活边界；context版本与activationEpoch是并发控制，不是用户session。

`internal/host/continuity-import.ts`及有限slices对接原生writer/runner；`roots/continuity.runtime.ts`管理操作寿命；kernel continuity校验候选与revision，CLI在现有context能力上扩展。原生Host仍拥有活状态，vault是备份，不直接覆盖活库，不为单次操作全局重启Host。

## 当前已证范围

`openContinuityCurrentState`在`roots/continuity-state.runtime.ts`持有捕获、初始化和对账操作寿命；kernel `current-state.ts`定义有限identity/revision/材料与application receipt，`host/continuity-import.ts`只作Effect-free原生边界校验，无文件/RPC/修复副作用。捕获传递读取预算并验证前后head和字节；初始化仅限empty/prepared目标，保护源快照、复核原始归属证据年龄、单次claim后提交，reopen和真实root读回且cleanup成功后才结算。

同操作重入不重新捕获/生成材料；目标有B2新进度不重导B0。原生结果unknown不盲重试；显式reconcile向原生只读取证但会写本地结算，不能当GET或重新激活。接口中application marker是对后续native binding的要求，不声称官方已有此结构。正常pipeline、Memory/转录/附件完整导入、self-reset以及原生持久屏障仍未实现。

[固定报告](../reports/2026-09-18-continuity-current-state.md)记录105项组合/711断言，真实CONT SQLite、owned合成原生协议、生产window codec与Node进程强杀；不是真实Host/Provider执行。当前原生源码已变化且本轮直接读取受路径限制，历史资格pin未修改，缺正式新资格不得安装。

```bash
node scripts/verify-runtime-rebuild.mjs continuity-current-state
```

## 必需行为

reset保全旧状态后建立合法的新工作起点；保留身份、Memory、模型、Routine定义和真实文件，不创建可切换session。原生root为空时的salvage、自动prepend、reply引用、摘要/prompt pins、待办及pending结果均须遵守新revision，不能下一次输入或重启又找回旧窗口。

initialize只写明确准备中的目标；recover恢复唯一当前状态，不回滚外部世界。导入成功后B0持续发展为B1/B2，重启恢复最新B2，不重新拼旧转录。原生提交不明必须读回；操作表没有成功不等于目标未写，不重复注入。

per-Bot屏障区分已接收旧输入与切换后新输入，迟到旧工具/checkpoint/Memory后处理不得串revision。Bot自请求先持久登记并返回，当前回合收尾后执行；不能CLI等当前Bot、Bot等CLI死锁。操作完成回执才承诺下一条普通消息使用新状态。

## 验收出口

新增owned原生形状、真实SQLite/文件、独立进程及packed测试：空状态合法、旧root不复活、Memory保留、跨reply/queued/late输入、不确定提交、重复operation、self-request及更新/杀进程恢复；原生资格固定版本检验所需接点。

验证真实下一次request而非模型自述记忆；缺旧历史不会被fixture默认回答掩盖。现有context-maintenance测试仅防回归。实际Host/App验收放在[LIVE-CURRENT-CONTEXT](LIVE-integration-validation.md#live-current-context)。

## 非目标

无`agents sessions`、命名会话、会话切换或`session=`标题；不抹除原生既有session边界，不拿default支持冒充named/server/subagent都支持。context修改不授予新权限或自动执行旧任务。
