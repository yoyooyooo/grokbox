# HCR — Host 能力与中断恢复离线回执（2026-09-18）

## 固定范围

来源合同为 [Host seam Spec §11](../roadmap/host-seam-ops-recognition.md#capability-recovery)，实现归 [HCR-01–04](../tickets/README.md#host-capability-recovery)。本报告记录固定代码的离线证据，不是当前部署状态表；现场状态只看 [LIVE-HOST-CAPABILITY-RECOVERY](../tickets/LIVE-integration-validation.md#live-host-capability-recovery)。

基线为 v2 `da6b5d4`，实施分支为 `fix/host-capability-recovery`。已验证实现头为 `cd836f2a05bc09b68f8bd60da2a11f64a17a73f7`，包含诊断提交 `a2cf0bd`、操作恢复提交 `1af30b4` 和加载能力/配方升级提交 `cd836f2`。后续文档不改变该实现。固定preload构建摘要为 `d60c26f0881e16b96a688983083083173023e444fefc698c9bee1785251c5cc9`；E09 pin已同步并实际重建核对。

未切换现役Host/modeld、未写现役reviewed profile、未改Bot模型配置、未发送业务消息或调用Provider。子进程退出/竞争测试只使用本测试创建的一次性进程和临时root；公开fixture不包含用户handoff、原始Host或真实账号资料。

## 已实现的链路

| 范围 | 实现与观察 | 不能推导的结论 |
| --- | --- | --- |
| 配方诊断 | 同一个preflight供analyze/write使用；`recipe_unapplicable`保留slice/code；CLI的`error.profileWrite`仅投影有限诊断，额外正文与访问器不进入输出 | 不表示任意上游切片已适配；原slice-review/golden gate继续有效 |
| Local witness | source/schema、scope、目标行、时钟/年龄失败分别给出有限子原因；scope变化/过期不再一律建议组件升级 | 不放宽原五秒年龄检查，不把Server注册或full List当执行许可 |
| 加载能力 | 实际执行的Gateway wrapper与安装reader共同提供版本化manifest，绑定加载进程和profile身份；无目标探测不走Server List或Provider | 源码、文件存在、custom或modeld ready不能证明桥已加载；manifest不是STEP许可 |
| 生命周期 | doctor未知状态有next；loaded-profile mismatch不重复写配方；upgrade/start/restart/re-adopt分别呈现请求、manifest、committed现态及剩余证明 | partial/unknown/recovery-required/refused都不算verified；旧terminal回执不能掩盖pending attestation；模型roundtrip始终单列not_proven |
| 操作恢复 | controller/identity新写者持有Linux系统gate；持久owner包含pid/start/uid/boot/nonce；只读preview不创建目录或gate；显式恢复只能将已证失效的running/reserved转unknown | 不签attestation、不清adopt journal、不发送Host信号，不重试业务；原controller仍唯一后续执行器 |
| 局部能力升级 | `ownership-local`更新登记的schema/API/resume依赖，非目标reviewed切片保持；analyze与write使用相同selector；分析摘要经`--expected-reviewed-sha`绑定到发布前复验 | 无任意skip list、无外部JS配方、无第二注入路径；缺少可测golden的历史基线仍拒绝 |

另外收紧了controller store：有界、no-follow读取，悬空symlink不视为空store；唯一受保护staging及fsync后发布。发布失败保留原记录，部分恢复不得声称回滚或完整attest。Recovery回执的operations/locks统计表示恢复后的元数据，而不是把恢复前running数量留成现态。

## 验证结果

运行环境为Linux。开发工具为Bun **1.4.2**，仓库声明仍为Bun **1.3.14**；本轮未更改packageManager、依赖版本或锁文件。已运行`bun install --frozen-lockfile`，无依赖改动。Node20实际入口为 **20.19.2**；安装包测试还保留其他既有Node入口验证，但不扩大为macOS/所有Node版本证明。

| 检查 | 固定结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| HCR五个文件 + operator/runtime CLI 定向组合 | 121 pass，0 fail，745 assertions |
| `bun run build` | 通过；只重建本worktree的dist |
| `bun run verify:package` | 6 pass，0 fail，179 assertions；真实打包安装后的Node CLI运行同一HCR用例 |
| Root / CLI / kernel（91个测试文件） | 899 pass，0 fail |
| box-runtime A（排序后前75个文件） | 524 pass，3 skip，0 fail |
| box-runtime B（随后75个文件） | 388 pass，4 skip，0 fail |
| box-runtime C（其余69个文件） | 559 pass，8 skip，0 fail |
| 全库分组总计（310个测试文件） | **2370 pass，15 skip，0 fail** |
| `git diff --check` | 通过 |
| 工作树publication检查 | 通过；不是完整Git历史/独立安全审查 |

分组按完整文件路径执行，避免Bun相对路径过滤器意外匹配同名文件；root组包含`test/verification-source.test.js`。这是全库文件覆盖的分组结果，不宣称单进程`bun test`完成：早期单次全库运行超过工具窗口，改用上述四组取得明确退出码。

架构测试曾因外层默认5秒与内部5秒import probe竞争而超时。调整的是该组测试的外层15秒预算，未删除反例、放宽checker或修改生产超时；随后A组整体通过。15项skip均保留原来的真实Host/原生资格门禁，不算现场通过。

### 针对事故形状的可执行证据

- `packages/box-runtime/test/hcr-diagnostics.test.ts`：一致的失败slice、有限CLI诊断、witness分类和脱敏。
- `packages/box-runtime/test/hcr-capabilities.test.ts`：实际applied synthetic wrapper/reader组合、无native读取、加载身份失配、控制回执白名单、committed现态与doctor路由。
- `packages/box-runtime/test/hcr-operation-recovery.test.ts`：14项独立进程/文件系统测试，覆盖活owner拒绝、硬退出、普通acquire不恢复、并发恢复、PID身份、文件替换、损坏store、发布失败后重试、旧格式保守恢复和terminal记录保留。
- `packages/box-runtime/test/hcr-profile-upgrade.test.ts`：7项测试，覆盖无关alert变化下的局部升级、目标失配、非法selector、分析与发布之间的基线变化、完整依赖计划和系统gate。缺少golden的情况仍断言拒绝。
- `test/hcr-cli-fixture.ts`由`test/hcr-cli.test.ts`与`test/packaging.test.ts`共用；对源码CLI和隔离安装后的Node20 CLI验证同一analyze/write流程、过时摘要拒绝和显式元数据恢复，不依赖工作区内部模块解析。
- `test/operator.test.ts`：refused/partial/unknown/recovery-required在upgrade、re-adopt及restart都不能得到verified；旧完成回执遇到pending attestation仍拒绝verified。

## 已知边界与下一道门

本轮进行了实现者复查，并由反例发现、修正了CLI丢失slice诊断及生命周期非refused即成功的问题；**尚未取得独立固定提交review**。特别是重副作用取消传播、旧版不协作维护进程与真实adopt提交窗口，不能由子进程硬退出测试替代完整证明。

新Linux写者要求`/usr/bin/flock`；缺少primitive时明确失败，不退回弱锁。Gate只协调新协议写者；恢复前须停止旧版维护写者，不对绕过gate的手动替换作事务保证。旧PID-only记录遇到重用的活PID时缺少start证据，必须保守拒绝。纯合同测试保持跨平台，真实Linux lease测试只在Linux运行；macOS未在本轮执行。

Bun 1.3.14目标工具链、独立review及真实加载验收分别保留，不把Linux/Bun1.4.2离线通过叫做全部发布门已关闭。当前分支尚未合入v2，也未推送或部署。真正的旧/新Host组合、局部profile写入后的重新加载、attestation中断恢复、App细因以及新nonce/STEP的Provider请求与结果，统一在LIVE条目中安排单独授权窗口。
