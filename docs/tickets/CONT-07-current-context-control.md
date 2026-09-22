# CONT-07 — 唯一当前上下文的原生控制

**状态：partial implementation；原生初始化基础及外部空闲Bot的reset/recover已接线，self-reset 的 CONT 持久队列与消费合同已实现，原生安全点接通仍未实现。** capture/initialize/reconcile/hold release与新的原生compose、历史补齐floor、Memory/指令保留进入有限RPC/CLI和CONT持久层；完整profile叠加compact通过限定原生验证。见[本轮集成证据](../reports/2026-09-19-continuity-lifecycle-integration.md)。

现有原生入口的活动回合自身调用仍明确not_prepared，不能宣称后台已排队；AH-133 新增的本地队列尚未接入该入口，安全收尾与后续输入归属由 AH-139/AH-140 继续完成。附件/全历史资源覆盖、真实原App/首次及重启后模型窗口、独立review仍各自有门，未修改现役profile。

合同：[S13公共原语](../roadmap/box-runtime-impl-spec.md#continuity-primitives)。依赖CONT-00、CONT-11和CTX-02；接口可先用owned fixture，产品reset/recover必须先满足CONT-02保全。为CONT-03和CONT-08提供最小公共内核，不先建设多会话平台。

## 目标与模块

同一原生 Bot 只有一份本能力管理的当前工作状态。提供观察、原生hold、initialize、reset、recover、commit/read-back/reopen及激活边界；context版本与activationEpoch是并发控制，不是用户session。

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

当前状态的普通管理已进入 `bot context get/initialize/reset/restore`、`bot snapshot create`、`bot activate` 和 context 域 operation get/reconcile/resume/cancel；旧 `agents state` 注册和直连 writer 已退出。`agents create --defer-start`仍只请求抑制介绍和 kickstart，不是入站屏障。管理主体、安装、原请求与固定目标/head/material 存入原 CONT 控制表，不新建操作数据库；源码版本以原数据库 owner 为准，GET 不迁移。操作方法唯一归[当前指南](../maintainers/current-state-control.md)。

[管理组合](../../test/context-management.test.ts)和[生产浏览器旅程](../../apps/web/test/context-browser.node.ts)通过共享 API 消费原生 owner/RPC/checkpoint worker，实际测试 Node HTTP、SQLite、打包 CLI、SIGKILL 后原标记对账、未知原生 apply 不重发、独立解除和 B2 不回退。Web 只保存原定位，丢解除回执后从历史取首次解除 revision，不用刷新后的新 revision 替代。读源、写上下文、解除和历史权限分开，最后授权撤销、客户端断连、关闭结算与元数据泄漏都有对应反例。

手动压缩现通过同一个 Server 的 `bot context compact` 与 compaction 域原操作入口执行，见[管理切片](../reports/2026-09-21-compaction-management.md)。声明、派发与结算使用原 CONT queued-control 表，并与未完成 current-state 修改在同一事务内互斥；不能换 UUID 或换领域绕过未知原生效果。它保留 Host 默认 current root 的原生 summarize 行为，不是本票 self-reset 安全队列，不能据此签署活动 Bot 自重置已完成。

未完成准备与等待解除的来源/备份/候选在原 CONT GC 事务中受保护。有限 cancel 仅在没有任何原生应用声明和解除声明时保留原取消墓碑，不能取消未知 apply；来源不存在在预留前拒绝。完整 self-reset、附件、源资源独立和真实账号资格仍未关闭；固定源码及扩大回归归 [CLI-05](CLI-05-implementation-follow-through.md)。

稳定验证入口：`node scripts/verify-runtime-rebuild.mjs continuity-native-binding`；明确本机原生资格另用`GROKBOX_TEST_NATIVE_CONTINUITY=1 node scripts/verify-runtime-rebuild.mjs continuity-native-binding-qualified`。后者Node22仅来自原生worker的node:sqlite要求，不提高grokbox Node20.17产品基线。独立外部review和实际profile加载仍未签；不把未实现项移成单纯live待验。

## 当前Host/worker ABI资格（2026-09-21）

前一[配对工作包](../reports/2026-09-21-native-checkpoint-pair.md)的2380…来源资格属于历史窗口。当前Host已更新为6be750…，并完成28项隔离原生验证：原schema/AgentStore、完整引用图、实际worker事务/持久marker/GC hold、重启/解除/B2、startup、duplicate和disposal。生产仅保留当前准确元组，旧元组与旧配方回退已退出；preload、worker与主Host注册使用同一当前身份，证据与先拒绝后验证的顺序见[单版本收束](../reports/2026-09-21-current-host-contract-convergence.md)。

新的显式资格入口是 `node scripts/verify-host-health.mjs native-pair`，需Bun1.3.14及显式native continuity、idle-candidate和native Node配置。它只访问指定源和自有测试库，不自动发布profile、启动Bot或执行真实Provider。原source/candidate/worker静态资格同步通过；整Host实际使用、self-reset、附件独立、完整用户恢复与独立审查不由这个ABI实验代签。

## self-reset 本地队列与消费合同

`openSelfResetQueue` 在原 CONT 控制表登记不可变请求，登记不调用原生 owner。消费要求 `SelfResetOwner.withSource(request, work)` 持有源观察至消费结算的屏障；未结算回合继续 queued，revision/generation 变化写 blocked，成功 claim 先落 effect_unknown。重开不再次派发；显式 reconcile 绑定原请求摘要，保留已完成职责。材料、职责结果及 workflow 引用与 GC 同事务保护。接口、反例和原生/fixture 边界见 [C1 固定报告](../reports/2026-09-22-self-reset-queue.md)。

本地队列不安装 Host hook；真实迟到工具/checkpoint/Memory 隔离、下一输入和重启仍需原生 owner 证明。

## 必需行为

reset保全旧状态后建立合法的新工作起点；保留身份、Memory、模型、Routine定义和真实文件，不创建可切换session。原生root为空时的salvage、自动prepend、reply引用、摘要/prompt pins、待办及pending结果均须遵守新revision，不能下一次输入或重启又找回旧窗口。

initialize只写明确准备中的目标；recover恢复唯一当前状态，不回滚外部世界。导入成功后B0持续发展为B1/B2，重启恢复最新B2，不重新拼旧转录。原生提交不明必须读回；操作表没有成功不等于目标未写，不重复注入。

per-Bot屏障区分已接收旧输入与切换后新输入，迟到旧工具/checkpoint/Memory后处理不得串revision。Bot自请求先持久登记并返回，当前回合收尾后执行；不能CLI等当前Bot、Bot等CLI死锁。操作完成回执才承诺下一条普通消息使用新状态。

## 验收出口

新增owned原生形状、真实SQLite/文件、独立进程及packed测试：空状态合法、旧root不复活、Memory保留、跨reply/queued/late输入、不确定提交、重复operation、self-request及更新/杀进程恢复；原生资格固定版本检验所需接点。

验证真实下一次request而非模型自述记忆；缺旧历史不会被fixture默认回答掩盖。现有context-maintenance测试仅防回归。实际Host/App验收放在[LIVE-CURRENT-CONTEXT](LIVE-integration-validation.md#live-current-context)。

## 非目标

无`agents sessions`、命名会话、会话切换或`session=`标题；不抹除原生既有session边界，不拿default支持冒充named/server/subagent都支持。context修改不授予新权限或自动执行旧任务。
