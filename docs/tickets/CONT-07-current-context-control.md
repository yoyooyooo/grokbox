# CONT-07 — 唯一当前上下文的原生控制

**状态：planned；复用CTX已有capture/compact，不宣称已有通用initialize/reset/recover。**

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00、CONT-11和CTX-02；接口可先用owned fixture，产品reset/recover必须先满足CONT-02保全。为CONT-03和CONT-08提供最小公共内核，不先建设多会话平台。

## 目标与模块

同一长期Memory身份只有一份当前工作状态。提供观察、原生hold、initialize、reset、recover、commit/read-back/reopen及激活边界；context版本与activationEpoch是并发控制，不是用户session。

`internal/host/continuity-import.ts`及有限slices对接原生writer/runner；`roots/continuity.runtime.ts`管理操作寿命；kernel continuity校验候选与revision，CLI在现有context能力上扩展。原生Host仍拥有活状态，vault是备份，不直接覆盖活库，不为单次操作全局重启Host。

## 必需行为

reset保全旧状态后建立合法的新工作起点；保留身份、Memory、模型、Routine定义和真实文件，不创建可切换session。原生root为空时的salvage、自动prepend、reply引用、摘要/prompt pins、待办及pending结果均须遵守新revision，不能下一次输入或重启又找回旧窗口。

initialize只写明确准备中的目标；recover恢复唯一当前状态，不回滚外部世界。导入成功后B0持续发展为B1/B2，重启恢复最新B2，不重新拼旧转录。原生提交不明必须读回；操作表没有成功不等于目标未写，不重复注入。

per-Bot屏障区分已接收旧输入与切换后新输入，迟到旧工具/checkpoint/Memory后处理不得串revision。Bot自请求先持久登记并返回，当前回合收尾后执行；不能CLI等当前Bot、Bot等CLI死锁。操作完成回执才承诺下一条普通消息使用新状态。

## 验收出口

新增owned原生形状、真实SQLite/文件、独立进程及packed测试：空状态合法、旧root不复活、Memory保留、跨reply/queued/late输入、不确定提交、重复operation、self-request及更新/杀进程恢复；原生资格固定版本检验所需接点。

验证真实下一次request而非模型自述记忆；缺旧历史不会被fixture默认回答掩盖。现有context-maintenance测试仅防回归。实际Host/App验收放在[LIVE-CURRENT-CONTEXT](LIVE-integration-validation.md#live-current-context)。

## 非目标

无`agents sessions`、命名会话、会话切换或`session=`标题；不抹除原生既有session边界，不拿default支持冒充named/server/subagent都支持。context修改不授予新权限或自动执行旧任务。
