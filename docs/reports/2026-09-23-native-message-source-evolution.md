# 原生消息交付、账号绑定与持续来源演进（2026-09-23）

本窗口接续 AH-157/AH-118，基线为 V2 `3f07c55cdbd17bf78d3e47d02ae1ed246e425e57`，已有消息实现 `fb4064125b57368d54f226bfb77478f7a12b9f53`。上一窗口与工具拒绝保留在 Linear 原评论；本报告只记录本次实际输入与验证，不作为以后的当前状态清单。

## 来源与开发反馈

原固定来源为 Host `68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc` / worker `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`。本轮实际磁盘 Host 为 `bfa76e4eb13a207e57bbd9c1017482234aa342fa436357d25cc59356c31650be`，worker 未变。先读回61片完整recipe全部适用，再推进独立测试期望，选定原声明与消息Node/SQLite先取得29个外层测试通过（内含消息14项），随后才推进单一生产元组；68fab3只保留为拒绝反例，不提供历史fallback。

在生产元组推进前，现行只读 `qualify-host-health.ts` 实际输出 changedComponents=[host]、完整recipe适用、旧元组不匹配、`source-change-needs-abi-proof`，而不是把哈希变化当成功或功能退化。第一次显式验证器目录选错导致 unavailable，纠正为打包目标目录后取得有效分析；该失败不被记作来源回归。当前只读报告不授予loaded/profile/采用权限。

Host持续变化是开发输入。每次完整结果归固定来源集合；新SHA触发新观察/受影响检查，不让历史资格丢失或已完成实现反复归零。固定快照和持续增量/去重能力另由AH-159在原A/E/Q链承接；本次没有启动定时后台任务或更改现役服务。

## 消息与身份合同

原 API→用户factory→TurnRuntime request关联→SendPipeline→SandAgentDb原SQL→重开tail→管理投影，使用选定原声明、明确Node22.14.0和自有SQLite；不是完整主Host、完整manager/数据库迁移、真实Provider/账号或App执行。覆盖活跃和非活跃Bot、有限RPC接受/等待/拒绝、原request不覆写/跨Bot不借用、分页及文本delta不造SendToUser。

原文本交付是kind=send-message、type=text，保留isStreaming缺失为null，另报persisted-text。精确nonce→唯一native requestId→同request文本交付，不能由普通assistant/位置/同thread推断。交付与accepted/queued/TURN/run/STEP/terminal分层。pending持久保存账号scope、Server Bot id、harness与Gateway generation；采样前后校验不是全局账户锁，缺证/换账号/失权保持unknown、不借外来源正文、不补投。旧未绑定回执只读为nativeIdentity=null。

CLI的便捷send/history消费同一management owner，原CLI/daemon夹具迁入真实CLI→shared client→管理HTTP→现有native适配，未恢复第二writer。Group及非文本完整产品能力仍归D2。原版App取证键和边界见[T39](../tickets/T39-native-model-roundtrip.md#d1-当前标识与原版-app-取证交接)，实际App旅程不由本窗口代签。

## 复现入口

使用仓库声明Bun1.3.14：`bun run build`，`node scripts/verify-host-health.mjs core`，`node scripts/verify-host-health.mjs integration-host`，`bun scripts/verify-modeld-core.mjs tool-contract`；显式原生资格为 `GROKBOX_TEST_NATIVE_CONTINUITY=1 GROKBOX_TEST_NATIVE_NODE=<native-node> node scripts/verify-host-health.mjs native-pair`，原核心行为为 `bun run test:native-host`。来源需匹配独立期望；不改测试来接纳未知字节。

文档旧日期锚点已补回，历史链接保留；没有删除失败断言、隐藏skip或用重复计数充作覆盖。最终固定输入、各命令实际计数及合流结果由下方收尾回执和Linear记录补足。

## 最终固定验证回执

源码/测试/lock共1277文件，固定摘要 `559f3cac4061542f8be0dfe57b8ccf252238e91c0b523f6719520bbba10c5ebe`；完整组合前后相同，core/native-pair/Host integration各自也核验稳定。所有命令使用Bun1.3.14。

| 检查 | 实际结果 |
| --- | --- |
| 正式build、根/Web类型、协议 | 通过 |
| core | 1478 pass / 0 fail，154文件；Rust39通过 |
| native-pair | 34 pass / 0 fail / 0 skip，7文件；内含选定原生消息Node14 |
| native-host | 28 pass / 0 fail，6文件 |
| Host integration | 6包装测试通过，内部Node98；真实制品+公开业务替身 |
| tool-contract | 194 pass / 0 fail，17文件 |
| 消息/Server/client/CLI交叉 | 203 pass / 0 fail，25文件；内含消息Node25、Server36，不重复累计 |
| 文档 | 16 pass / 0 fail |
| 公开性 | 扫描通过、0 findings |

来源哈希在全部验证结束再次读回，仍为本报告bfa76e/da6796配对。四个完整候选语义正例通过；四类合法JavaScript破坏反例正确返回violated，未删除required检查。

完整Host candidate：`830a2c20dc2c4d31f58fdb716588c0cfec9341b7bdb11907663428eca08d9529`；worker candidate：`8eb521daa9a75cd5c09c377c4b9ff69d483fe783d83d5f98f845ad7b4f85eb8f`；有序recipe：`34b214eb0dd37eb22697f8e47252db55498bd39e85870f4c41f77e5b8c7a5fcd`。

本轮一次额外进程诊断读取被工具检查拒绝，未重试该诊断；已启动的正式验证按原命令完成并取得以上回执，不以工具拒绝猜测业务失败。报告收尾不改运行时/测试输入，合流SHA记录于Linear AH-157/AH-118。

AH-157/AH-118签收限定于上述实现与来源下的隔离资格和交付文档，不签A2全可达风险或R1整段冷进程业务联调，也不签真实App、收费模型、profile发布及现役Host/modeld切换。后续上游更新保留本窗口，依据新观察回流相关Issue，不自动撤销本票已完成的实现交付。整体运行/采用 `qualified=false` 不被本报告修改。
