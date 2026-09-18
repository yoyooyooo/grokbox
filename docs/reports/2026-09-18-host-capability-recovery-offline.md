# HCR — Host 能力与中断恢复离线回执（2026-09-18）

## 初始窗口固定范围

本报告保留初始窗口的工具版本和结果；后续目标工具链及取消补证见[补充窗口](#hcr-pinned-qualification)，不将新结论追溯为早期证明。

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

## 初始窗口验证结果

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

## 初始窗口已知边界与下一道门

本轮进行了实现者复查，并由反例发现、修正了CLI丢失slice诊断及生命周期非refused即成功的问题；**尚未取得独立固定提交review**。特别是重副作用取消传播、旧版不协作维护进程与真实adopt提交窗口，不能由子进程硬退出测试替代完整证明。

新Linux写者要求`/usr/bin/flock`；缺少primitive时明确失败，不退回弱锁。Gate只协调新协议写者；恢复前须停止旧版维护写者，不对绕过gate的手动替换作事务保证。旧PID-only记录遇到重用的活PID时缺少start证据，必须保守拒绝。纯合同测试保持跨平台，真实Linux lease测试只在Linux运行；macOS未在本轮执行。

初始窗口结束时，Bun 1.3.14目标工具链、独立review及真实加载验收分别保留，不能把Linux/Bun1.4.2离线通过叫做全部发布门已关闭。该窗口未合入v2，也未推送或部署。真正的旧/新Host组合、局部profile写入后的重新加载、attestation中断恢复、App细因以及新nonce/STEP的Provider请求与结果，统一在LIVE条目中安排单独授权窗口。

<a id="hcr-pinned-qualification"></a>
## 补充窗口：目标工具链与取消边界

固定生产实现为 `f3b831bc935bf8ae865f757badfe85636383ef69`；后续 `4663b5ed9df2a092f4ddc528246b3b34520fcafc` 只调整 `test/cli.test.ts` 的用例划分，不改变生产代码或runtime测试。下面runtime三组按前者运行，root/CLI/kernel组按后者运行；对两提交的文件差异及四份JUnit中的file集合做了核对，覆盖完整311文件，无遗漏、无意外匹配。两者的preload摘要一致：`7d259cef708d1ee37aa6fb06e9af9922170a99e9ed02e4de1ed0a318178fefd2`。

### 修复和新增证据

- CLI取消信号接入原metadata recovery的Effect根。已经取消的调用在进入不可中断的资源申请前拒绝，不能仅依靠runtime注册取消信号，否则仍可能创建gate。
- `hcr-operation-lifetime.test.ts` 新增5项：持锁取消保留unknown及prefix、申请未返回时取消不遗失descriptor、预取消零gate、取证中取消后晚到的只读结果不触发mutation、提交中取消等所有unlink完成后才释放两把gate。全部使用临时root和生产lease实现，Host能力被显式拒绝。
- 恢复未收到完成回执时，错误明确说明元数据可能已改变，不把取消解释成回滚。已有14项硬退出/并发恢复测试仍保留，不用取消测试代替硬崩证据。
- `controller-io` 中4项纯恢复规则与实际Linux lease分离，`host-stop` 中2项实际lease用例加Linux门；纯规则和零副作用观察继续跨平台测试。这修复了此前未加平台门的路径，不声称已在macOS执行。

### Bun 1.3.14验证

使用本机已有的 **Bun 1.3.14（0d9b296a）**，仅为验证命令设置版本化PATH；未替换全局Bun、修改packageManager或升级依赖。`install --frozen-lockfile` 无依赖变化，typecheck/build通过。安装包suite在最终root组运行：6 pass、179 assertions，包含实际隔离安装后的Node20 CLI。

| 完整文件分组 | 结果 |
| --- | --- |
| Root / CLI / kernel，91文件 | 927 pass，0 fail |
| box-runtime A，前75文件 | 522 pass，3 skip，0 fail |
| box-runtime B，随后75文件 | 397 pass，4 skip，0 fail |
| box-runtime C，其余70文件 | 561 pass，8 skip，0 fail |
| 合计311文件 | **2407 pass，15 skip，0 fail；22380 assertions** |

相对初始2370通过数，增加5项取消测试、4项分离的Linux lease测试、28项由单一帮助测试拆分出来的命令组；通过数增加不表示新增了37项产品能力。15项原生资格skip未变化。依然是完整清单的分组执行，不声称单进程全库运行或跨平台CI通过。

### 失败记录与复验

目标版本首次root大组出现local-shim两项超时；单独复跑2/0，但同组复跑仍出现help与shim超时。进一步定位到全部leaf的help断言共用一个5秒test，超时后异步循环可能继续影响后续用例。`4663b5e` 将同一完整leaf/option-set断言按29个顶级命令组划分，保留原断言并检查每组非空，没有延长生产超时或删除用例。随后help+shim组合66/0，最终原91文件root大组927/0。早期失败JUnit保留在machine-local scratch；不能把单独成功回填成最初大组成功，也不将shim超时的全部深层原因视为已证明。

### 独立审查与未执行范围

固定模型独立审查的主通道3次、已配置备用通道1次均以HTTP 503退出；其中最后一次针对`4663b5e`。没有返回审查发现或签收报告，不能标为“零缺陷”或独立review通过。由于当前环境不提供Herdr，本窗口使用同步有界Pi调用而非后台等待；未派出实现者、未让审查任务修改代码、未读取实际Host/账号材料。

目标Bun工具链离线门在本窗口关闭；独立固定提交review仍是非live阻断，macOS实际执行仍未证明。分支在本窗口结束时未合入v2、未push、未切Host/modeld、未做真实Bot推理；后续集成与现场窗口仍按[LIVE唯一入口](../tickets/LIVE-integration-validation.md#live-host-capability-recovery)的授权和资格执行。
