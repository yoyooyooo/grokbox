# R1 原生运行与独立进程资格（2026-09-23）

基线V2 `fa124dfc0d5f82ffa6a7adbc4a76078ab479be1f`，AH-117。原A1/D1已交付的核心/消息不重做；本窗口补齐此前被skip的原summarizer/archive及独立Node持久化链，并把跨模型执行与原生存储接成同一测试。不是现役采用、真实Provider或原版App验收。

## 原始失败与修正

首次显式三文件资格为14 pass/1 fail：独立新Node完整图读回和compact接点通过，摘要夹具在现行原声明的 `__awaiter29` 处报缺依赖。按实际源核对后将旧26/27替身绑定改成当前28/29；下一次运行发现新增 `isInjectedReminderMessage` 未随原函数选择进入VM。

修正只在资格夹具：选择当前原提醒分类函数及原 `INJECTED_REMINDER_CURSOR_FLAGS` 字面常量，逐个验证真实标志的user/assistant分支和无标志反例；没有用恒false函数掩盖新逻辑。原生摘要正例随后通过，原managed候选只生成一次，原native assembler/archive接纳保留固定消息、尾部、TODO/模式和生命周期。生产summarizer、原Host和任何实时权限均未修改。这是持续Host更新暴露的测试依赖债，反馈给AH-159的变化分类/依赖回归，不重开已完成A1/D1。

## 同链原生恢复

模型切换测试的共有业务链抽成单一helper，公开测试仍使用原有JSON持久化替身且保留全部断言。新增显式原生测试复用同一链：官方→模型A→模型B→官方→A，旧TURN选择保持、工具效果一次、非目标Bot不变；把真实SDK结果/工具历史交原AgentStore序列化为native protobuf与原叶格式，原worker写自有SQLite。

writer与reader分别在独立Node进程启动原worker，核对不同PID、固定来源/根摘要、全部引用parts和原AgentStore读回。读回的实际消息接回新modeld生命周期并生成后续SDK请求，保留原工具/metadata，而不是模型猜中事实或从旁边的JSON快照恢复。当前原生样本共6个原生parts；另有原checkpoint-process的summary/archive五part完整图及篡改拒绝反例，worker重启/GC持有/B2不回退由原worker-binding用例负责。

metadata端口和活动对象为自有能力；原SQLite是原blob worker的真实事务，未调用原版主Host/完整数据库迁移或用户存储。原工具效果、official session、Provider及账号/ownership端点是明确的隔离替身；没有真实费用/模型或App操作。

## 可重现入口与资格边界

新增 `verify-host-health.mjs native-runtime` 复用既有验证runner和source before/after guard，要求 `GROKBOX_TEST_NATIVE_HOST=1`、`GROKBOX_TEST_NATIVE_CONTINUITY=1`、显式 `GROKBOX_TEST_NATIVE_NODE`，禁止旧pair selector及任何skip。新进程原checkpoint测试使用同一显式Node变量，不再凭默认Node碰巧通过。公开组和native-pair原合同不变。

源资格在固定 bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be / da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c 下执行；原声明的外部依赖隔离范围与A1一致。固定候选成功不覆盖新磁盘来源，后续演进观察不自动擦除这个结果。A2仍需真正可达补丁风险闭包，Q仍需独立审查/安装，真实加载/Provider/App在各自LIVE窗口。

## 首次组合未通过与验证资源收敛

首次宽组合为88 pass/2 fail：原摘要测试超过20秒，打包CLI一个子测试在自身15秒期限终止，其余独立原生存储及同链恢复通过。CLI独立组随后20个Node子测试全部通过；没有凭这一重跑声称已精确定位历史超时原因，也没有修改业务代码或放宽截止时间。

摘要测试原先为17个声明构建整个27MB Host的AST；现改为SHA固定后按唯一声明边界选取、有界AST校验。17个原函数/方法的字节摘要与先前全AST选择完全相同，新增提醒依赖仍是原常量/函数，不删分支。独立测试降至约3秒并保持原20秒测试期限；该时长只是本窗口，不承诺一般性能。

`native-runtime` 按原摘要、原持久化/独立进程、管理HTTP、运行合同拆成顺序独立Bun进程，完整清单不减少、每项截止时间不变、每组skip仍拒绝。显式路径消除Bun子串匹配：此前隐式匹配到的Box compaction测试也明确列入清单，禁止重复或漏跑。分组是测试资源生命周期隔离，不作为压住实际失败的重试机制；下面只记录新固定窗口实际结果。

## 原生组合通过与制品检查回流

新固定窗口源码/测试/lock共1280文件，摘要 `865613c0e8a74c8b19aabb8b76346816f710640f52b94a5d2aa6f2d78d13cd0f`。`native-runtime` 四组分别1/7/7/75项，共90项、14文件，零失败、零跳过；各组完整完成，窗口前后一致。管理HTTP内部context18、compaction20项不与外层重复累计，原生模型checkpoint验证6parts及独立writer/reader进程。

随后正式release-offline运行672项/69文件，671通过、1失败：E09静态fixture要求当前源码重建preload继续等于历史 `8d5c2f5a8daab7faf923de97f080a3d4b365fabd5f5d0dc3ea2557fbd6ca6a27`，而本轮产物为 `9c06ec5bed2eabf58f0291c32f4e3f77bbe8d2a3c1f4fdd1fff71101eba7e50a`。`verify-context-continuity.mjs` 的pinOk还有同一个消费者。不能只改golden、用任意非空SHA或自产物自比较代签拒旧。

已读取的pack脚本使用现有buildProvenance编入身份并核对构建前后sourceDigest。进一步读取构建身份定义、preload身份出口与context verifier相关段的组合调用被平台安全检查拒绝，没有执行回执，未改通道重试。具体修复归 **AH-160**，实际阻塞AH-117与Q/AH-122；复用原制品身份、不建第二版本库，修好所有现行消费者和旧/篡改/错身份反例后再签release-offline。

这不是Host再次更新造成整票清零，也不回滚已Done的A1/D1。当前原生运行证明保留，其余核心/类型/文档检查可独立继续；AH-117尚未Done、A2/Q采用未放行。历史前一组合失败与新的成功/未通过范围分别保留，不以native-runtime成功掩盖release失败。

## 收尾验证与回流范围

在相同1280文件输入摘要下，完整core **1480 pass / 0 fail，154文件**，Rust **39**、根/Web类型及协议检查通过；文档 **16 pass**、公开性扫描0发现、diff检查通过。native-runtime90项和core窗口各自前后stable，最终全部源码/测试/lock摘要与运行前相同；磁盘仍为本报告的bfa76e/da6796。

原生资格需要明确使用 `GROKBOX_TEST_NATIVE_NODE`，包括已有verify-runtime-rebuild的相关原checkpoint进程用例；没有隐式选系统Node或把默认skip算通过。普通公开的model-switch测试仍无需原生来源。

本批合流只包含测试helper/原生夹具、验证入口和技术报告，不改变生产Host/modeld/SDK/CONT业务源码。**release-offline的671/1仍未修复，AH-160为明确阻塞，AH-117保持In Review。** 这不撤销本次原生运行和核心回归的准确结果，也不放行A2/Q整体或真实采用。合入提交及当前状态以Linear签收回执为准，不在后续源码变化时重写本日期报告。

最终公开性扫描数量：1617 blobs，0 findings。
