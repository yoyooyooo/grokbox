# CONT-07 — 唯一当前上下文的原生控制

**状态：当前原生初始化基础切片已实现，真实部署待验；本票完整reset/recover范围仍有实现工作。** capture/initialize/reconcile/hold release已有具体主Host/worker接线、有限RPC和`agents state` CLI，接入CONT持久层；显式`current-state` profile升级保持既有接缝，未修改现役profile。已有非空状态reset、完整语义recover、Memory/展示历史和完整clone/spawn不由本切片冒充完成。

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00、CONT-11和CTX-02；接口可先用owned fixture，产品reset/recover必须先满足CONT-02保全。为CONT-03和CONT-08提供最小公共内核，不先建设多会话平台。

## 目标与模块

同一长期Memory身份只有一份当前工作状态。提供观察、原生hold、initialize、reset、recover、commit/read-back/reopen及激活边界；context版本与activationEpoch是并发控制，不是用户session。

`internal/host/continuity-import.ts`及有限slices对接原生writer/runner；`roots/continuity.runtime.ts`管理操作寿命；kernel continuity校验候选与revision，CLI在现有context能力上扩展。原生Host仍拥有活状态，vault是备份，不直接覆盖活库，不为单次操作全局重启Host。

## 当前已证范围

`openContinuityCurrentState`在`roots/continuity-state.runtime.ts`持有捕获、初始化和对账操作寿命；kernel `current-state.ts`定义有限identity/revision/材料与application receipt，`host/continuity-import.ts`只作Effect-free原生边界校验，无文件/RPC/修复副作用。捕获传递读取预算并验证前后head和字节；初始化仅限empty/prepared目标，保护源快照、复核原始归属证据年龄、单次claim后提交，reopen和真实root读回且cleanup成功后才结算。

同操作重入不重新捕获/生成材料；目标有B2新进度不重导B0。原生结果unknown不盲重试；显式reconcile向原生只读取证但会写本地结算，不能当GET或重新激活。application marker与持久准备状态已由下述worker和主Host适配实现，并非官方原本已有的字段。完整Memory/转录/附件导入、self-reset和语义恢复仍需实现；整条原生业务回合尚待现场验证。

[协调程序固定报告](../reports/2026-09-18-continuity-current-state.md)记录105项组合/711断言，真实CONT SQLite、owned合成原生协议、生产window codec与Node进程强杀；不是真实Host/Provider执行。

后续[原生checkpoint切片](../reports/2026-09-18-continuity-native-checkpoint.md)已解除源码读取阻断，新增`host/native-checkpoint.ts`具体capture adapter与严格root/全图读回。使用单独固定Host/worker对的原schema和AgentStore，在owned端口及独立Node进程中完成源移除后的持久往返；不是再用合成protobuf代替原生。旧whole-Host pin不变。该历史报告当时尚缺的worker事务/预算读取、持久应用凭据、主Host准备屏障和RPC已经在下一切片接线，见[当前操作指南](../maintainers/current-state-control.md)与[2026-09-19集成回执](../reports/2026-09-19-continuity-native-binding.md)。原生worker在owned数据库上实际启动，主Host注册/runner/checkpoint/profile接缝通过固定原源资格；整Host/真实Bot的第一轮及重启后续轮仍须LIVE，不把worker往返当整条用户旅程。

```bash
node scripts/verify-runtime-rebuild.mjs continuity-current-state
```

## 当前初始化切片

`native-checkpoint-worker.ts`在原worker连接内串行执行有界读取事务或写入事务，root/依赖/worker marker同库提交；prepared marker阻断原生GC/写入，重启保留。`native-current-state-owner.ts`登记实际原生store与metadata，协调主回合/异步checkpoint、CAS root指针和主Host应用标记；只接受未运行、无历史请求/转录/待处理结果的空白目标，不把缺root等同新Bot。

当前能力通过独立`current-state`同源profile升级接入，不改变默认历史recipe。prepare保留现有来源/目标，initialize完成双层读回但不开始工作；activate显式释放已核实屏障，只允许后续正常输入。原生worker commit、主Host应用完成、本地安全账本完成分别记录；部分成功unknown不重导，B2继续工作后不能被B0覆盖。

`agents state show/capture/initialize/operation/reconcile/activate`及`agents create --defer-start`已有注册/帮助/处理程序。defer-start只请求抑制介绍和kickstart，不是入站屏障；state命令Box-local、UUID限定、写操作需confirm、普通输出无原始上下文。CONT库的显式迁移保留原始初始化请求；CONT-06追加后当前私有库为v3，支持v1/v2连续升级并保存复制身份回执，GET不迁移。使用方法和限制唯一归操作指南。

稳定验证入口：`node scripts/verify-runtime-rebuild.mjs continuity-native-binding`；明确本机原生资格另用`GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-native-binding-qualified`。后者Node22仅来自原生worker的node:sqlite要求，不提高grokbox Node20.17产品基线。独立外部review和实际profile加载仍未签；不把未实现项移成单纯live待验。

## 必需行为

reset保全旧状态后建立合法的新工作起点；保留身份、Memory、模型、Routine定义和真实文件，不创建可切换session。原生root为空时的salvage、自动prepend、reply引用、摘要/prompt pins、待办及pending结果均须遵守新revision，不能下一次输入或重启又找回旧窗口。

initialize只写明确准备中的目标；recover恢复唯一当前状态，不回滚外部世界。导入成功后B0持续发展为B1/B2，重启恢复最新B2，不重新拼旧转录。原生提交不明必须读回；操作表没有成功不等于目标未写，不重复注入。

per-Bot屏障区分已接收旧输入与切换后新输入，迟到旧工具/checkpoint/Memory后处理不得串revision。Bot自请求先持久登记并返回，当前回合收尾后执行；不能CLI等当前Bot、Bot等CLI死锁。操作完成回执才承诺下一条普通消息使用新状态。

## 验收出口

新增owned原生形状、真实SQLite/文件、独立进程及packed测试：空状态合法、旧root不复活、Memory保留、跨reply/queued/late输入、不确定提交、重复operation、self-request及更新/杀进程恢复；原生资格固定版本检验所需接点。

验证真实下一次request而非模型自述记忆；缺旧历史不会被fixture默认回答掩盖。现有context-maintenance测试仅防回归。实际Host/App验收放在[LIVE-CURRENT-CONTEXT](LIVE-integration-validation.md#live-current-context)。

## 非目标

无`agents sessions`、命名会话、会话切换或`session=`标题；不抹除原生既有session边界，不拿default支持冒充named/server/subagent都支持。context修改不授予新权限或自动执行旧任务。
