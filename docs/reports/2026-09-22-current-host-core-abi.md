# 当前 Host/worker 核心接缝与有限 ABI 窗口

2026-09-22，AH-111 / A1（`grokbox-parallel-20260922/A1`）。基于 `0630039487dc3d5c718ac1980265b03f5c8797f1` 的独立 `feat/ah-111-current-host-abi` 实现。本报告固定观察，不复制任务状态；Q负责同源复核、串行合入v2与Linear签收。核心接口唯一说明在 [HOST-01](../tickets/HOST-01-patch-health-verifier.md#核心接缝交付合同)，作者/发布约束在 [HCR-04](../tickets/HCR-04-capability-profile-upgrade.md)。

## 范围与最初失败

只读当前安装的Host与companion worker，使用唯一维护配方在内存变换；执行选取的原声明、生产checkpoint fence及自有SQLite的原worker。没有加载主Host整入口、读取用户Bot材料、采用profile、切换现役Host/modeld、使用真实模型或外部投递。`loadedProven=false`、`profilePublished=false`、整体`qualified=false`。

起点是[较早来源漂移观察](2026-09-22-native-material-source-drift.md)，不是把[6be750…历史收束](2026-09-21-current-host-contract-convergence.md)当作新来源资格。实际首轮全配方在`continuity-native-blob-owner`返回`anchor-missing`；跳过失败的诊断还发现`continuity-native-checkpoint-fence`的`find-missing`。core39片仍匹配，但没有完整candidate，四个Rust检查均为`unsupported/no-exact-candidate`。

先推进独立测试预期而不改生产admission，按现行原声明更新await helper。首轮24项原生隔离测试22通过/2失败：duplicate测试仍提供旧路径依赖名。按原clone声明绑定修正后24项全过，才推进唯一生产配对并复验实际worker hook；没有增设旧布局fallback或删切片求绿。

当前修正包括blob owner边界的路径别名136→137、原AgentStore await helper43→45、session materialization原路径依赖137→138，以及duplicate测试原依赖127→128。两个原生测试入口共用独立期望而不从生产常量反推测试SHA；声明缓存命中之前仍重新读取并验证Host和worker字节。

## 精确来源与候选

以下SHA-256均来自本窗口实际字节。Host候选是39 core + 3 checkpoint + 19 current-state严格有序执行全部61片的结果；worker候选来自正式`transformNativeCheckpointWorker`。候选和原声明未写进仓库。

| 对象 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 原Host | 26667140 | `ebd92f0d14dd065b779524989dc15a7922c848f77227c69616257be6af6db8f0` |
| 原worker | 677631 | `4c154a3498de0a3fd211762a936a0f6ea5ee24760505fa2e021543f6a0f651e6` |
| Host完整candidate | 26690948 | `7eda7a15c4f6f938a9ffec36c64df7790eb12f1ebebc51ba7c2074db9934b1f1` |
| worker candidate | 678382 | `2a54e426bddaeb0f72ac002b0eb43e099b4f938c8aed22653b4ca1544f0977b5` |

`HOST_RECIPE.id=host-managed-current`，`canonicalJson`后的有序切片摘要为 `ceac7f72c5b979d9db80f31bb47f598bd13ee05c0ec43a348eefd68c36e7cb45`；相同id生成的候选profileDigest为 `ea75e3e4c4ed3c4d8d3c1af0e57b888c4d8082c88c72514c0cd68693b5d3ab37`。这是未发布、未采用的作者候选，不是审核签名。

只有该Host/worker对在当前实现常量中接受，schema仍为经原描述符校验的`native-checkpoint-proto-20260918`，worker协议1。旧Host e7031…、2380…、6be750…及上一worker作为拒绝反例；不保留可执行旧元组。文件、完整配方、生成工具或运行依赖变化都需要重新取得对应范围资格，`same-pinned-pair`本身不代替测试。

## 原声明及工具链依赖

`native-continuity-code.ts`只选取明确codec/引用图和原AgentStore依赖，不执行Host或worker顶层入口。Host存在的共享类型按原protobuf描述符逐个核对；明确worker-only的四个RequestContext类型不伪造Host对应项。报告只输出摘要，不输出schema私有内容。

| 实测依赖 | SHA-256 |
| --- | --- |
| 选取的worker codec及词法依赖 | `a4ede2279cea753c420b812f17f2953a148760d806cab5b26f0855142a38ce51` |
| 排序后的共享类型描述符集合 | `b57f70946fd86dc56a7e961f7d53a824512f004ff4008ffb9f38394e175ca10b` |
| 原await helper | `e00ec39a24f9b34f800dc0f1b383f54a7e607f7f17b88ae2a05d7d647bac8848` |
| 原ProtoSerde | `7f8177c0c3911d9174ab9ce27ca8f0b03230c9c5779c88e1f932871f0ec6ff06` |
| 原AgentStore | `89dcb2d1cdaaf2e89a9a9bbf28928ebb068adb2ccc61f9ff3ed4ac273f1dadd0` |
| 加入checkpoint fence后的同一AgentStore | `1da70d1213c5548a6a6cc16c5196143a23f839a2baa3a355ae22a4a3d8c53f68` |
| 原生Node可执行文件 | `1abce2374a485bddae3c27b17a3e3143e2780232026e627c4fe74ddde3f380a1` |
| `bun.lock` | `9a9aa90d6365d15d6804ac4b2b020228ce4db26bc43639850a9d85a756d6cdf0` |
| `Cargo.lock` | `b9c250e11041334bb16f5205d63001ee3e59cd0655f55bfd577fcbc4b00b811c` |
| 本工作树打包Rust verifier | `b0dd1cb7e65c093a5f132c183e570717ea2f257f1a623ee2048a454a8a107e63` |

使用声明的Bun1.3.14和Rust1.85.0；原worker运行时为Node22.14.0、内置SQLite3.47.2、Node modules ABI127。不是提升CLI既有Node20产品基线。Rust仍为Oxc0.75.0，buildId `bb2c3de8760071da273297f660381b8e200df4638ce7daddb9dabcac5378d2ab`，协议schemaDigest `8fbb644ff38372420dfb8bde1f4eb3fbebdab6c26941e8e5c61dbb4cd8a18aac`。

## 完整当前候选的语义反例

新增`native-current-candidate.test.ts`及其Node driver，使用正式打包的原Node/只读FD/Rust路径。不是另一套checker或合成Host。正例source/candidate/worker语法与semantic诊断为0，四项必需规则全通过。

反例只改指定维护切片的单一replacement，重新走完整有序preflight及`applyPatchProfile`、重新计算profile与candidate hash；原source/worker保持同一准确配对。四个candidate全部是合法JS且静态规则明确为`violated`，不是unknown-sha或parse失败：

| 破坏 | 规则 / 返回code | 新candidate SHA-256 |
| --- | --- | --- |
| 主session传错clientNonce | `session.main-binding@2` / `native-turn-identity-mismatch` | `9186ac2648cc93605407686e74a8c24e42f32c6223a59e2bef2d90fe7c0df0c3` |
| managed错误仍准许外层retry | `retry.turn-guard@2` / `guard-does-not-dominate-retry` | `d664ba76b512c7aecff2d9e1bad1b0feebd6041a2fd18efd69791c029ee4e761` |
| checkpoint丢失外层await | `context.checkpoint-await@2` / `checkpoint-lifetime-mismatch` | `769bbade31014021c6a7b8cbe0ede2d99fc24074167f881318c1dd62ddf1c0a5` |
| lease preflight丢失await | `context.lease-finally@1` / `lease-preflight-not-awaited` | `f013a74b3e816dc839f78afe10a27e69a4e174495832758c5da370103ababd29` |

早先测试作者用全bundle短片段定位，严格唯一性断言分别因相似identity/checkpoint片段失败；改为按准确slice限定修改，不放宽匹配或语义断言。驱动结束前重新核对磁盘原Host/worker，避免来源在测试过程中更新后沿用成功。

## 原生、fixture和读回的边界

新增变换后原AgentStore与实际`createNativeCurrentStateOwner`的联合验证：延迟原writer期间revision不能提前记录，in-flight时不能替换注册；prepared或旧store实例在写之前拒绝；无hook仍沿原生passthrough；原错误保持对象身份。revision写回失败即使发生在原生root及内存已改变之后，也返回`commit_unknown`，不会把已写当成未写。此部分使用自有blob/metadata替身，不冒充原生SQLite证明。

SQLite证明来自另一个实际原worker线程窗口：正式worker hook、原Node module loader、原事务与自有数据库，核对prepare只读、durable receipt、persistent GC fence、重启读回及后续B2保全。原schema/完整引用图、archive/历史root缺失、损坏/unknown field、startup/duplicate/disposal分别通过隔离声明测试。真实Bot材料和主Host未执行。

核心Host入口的只读副本与原声明测试还复验了原retry循环、compact lease、harness输出、辅助memory/episode空输出no-op；属于明确opt-in的有限原生观察，不是真实Provider成功。Host管理、编译、见证与授权场景的Node集成使用正式制品和公开合成业务输入，不能改写为真实账号验收。

## 固定验证与复现

最终core、integration-host、native-pair三个窗口前后都为1251个源码/测试/lock输入、SHA `a1037da635c2102060c4e1f8b82b1ce5d02f9c2a66051882595fd3539e79e4bd`。不包含生成dist或已安装依赖，故上文另列构建/原生依赖摘要。

| 验证入口 | 实际结果 |
| --- | --- |
| `node scripts/verify-host-health.mjs core` | Bun1457项/152文件，0失败；Rust39项，0失败；根/Web类型检查及协议生成一致性通过 |
| `node scripts/verify-host-health.mjs integration-host` | 6个Bun包装测试通过；内含Node98项：管理13、编译11、SQLite调度5、边界20、见证26、verifier23；0失败/0跳过 |
| 显式`native-pair` | 33项/6文件，0失败；包含1个完整候选正例与4个合法JS反例的包装测试 |
| 显式`test:native-host` | 28项/6文件，0失败 |
| `bun run build` | 正式Rust、CLI/preload/worker与Web构建通过；原生候选测试再次从本树构建，不借用其他worktree的dist |
| 独立`qualify-host-health.ts` | 最终准确配对、61片全适用、四规则passed；仍`applicable-not-reviewed`和`qualified=false` |
| `bun run check:docs` / `check:publication` / `git diff --check` | 文档15项通过；新增文件纳入git后公开性扫描0发现；无空白错误 |

不同窗口/包装内外计数不相加为独立场景总数。本窗口没有重跑完整integration-domains/integration-web、正式live采用或整仓最终候选签署。

在项目根目录使用Bun1.3.14；`NATIVE_NODE`为已核准原生Node，`HOST_SOURCE`/`WORKER_SOURCE`为明确读取的当前安装输入：

```sh
node scripts/verify-host-health.mjs core
node scripts/verify-host-health.mjs integration-host
GROKBOX_TEST_NATIVE_CONTINUITY=1 GROKBOX_TEST_NATIVE_NODE="$NATIVE_NODE" \
  node scripts/verify-host-health.mjs native-pair
GROKBOX_TEST_NATIVE_HOST=1 bun run test:native-host
bun scripts/qualify-host-health.ts --source "$HOST_SOURCE" --worker "$WORKER_SOURCE" \
  --binary-directory "$PWD/dist/native/x86_64-unknown-linux-gnu" --candidate-recipe current-state
```

公开测试不隐式读取私有源；native-pair缺少opt-in或指定Node必须拒绝。Core数据流、权限及未知效果边界仍由原产品owner负责，语义反例不产生业务副作用。

## 交付与剩余依赖

提交前观察到v2已从本窗口base推进至`89897a8fc420f9e133632105ec3a18b193d11563`（E1观察/安全worker合同）。检查其改动文件，与本批15个文件无重叠；没有把这个尚未组合验证的tip冒充本窗口输入。Q合并后仍需对实际组合复验。

A1交付当前来源身份、核心调用合同、当前唯一配方/worker admission及可执行资格。R/D/E/F使用[HOST-01合同](../tickets/HOST-01-patch-health-verifier.md#核心接缝交付合同)和[HCR-04原writer](../tickets/HCR-04-capability-profile-upgrade.md)，Q合入后再按自己的Issue复验；报告存在不解除Linear阻塞关系。

A2继续声明能力的完整语义/运行机会覆盖和真实采用后的同代证据；A3分别承接当前原生材料writer、continuity/退役新接缝。当前声明不足、未跟踪调用与独立投递仍须如实呈现。该窗口没有测现役加载身份，因此磁盘Host升级不能推导正在执行的新版本，更不能触发自动切Host。


## Q 集成与组合复验补充

A1 原实现 `af7c544f` 在接入当日最新 E/R/F/Q 变更后重放为 `23f93aa5`，`range-diff` 确认原补丁未变。以 `0ec602a334b9d62d8783c41aee985a652ced8213` 为集成基线，补上 Host envelope fixture 修正后的 `cb6d9dec33c583beb1539a720d221bb9e4dc36c2` 已由 Q 快进进入 v2。该提交的源码/测试/lock 输入摘要为 `94661ddb745812c30384c3fbe35dd307dedf73f2d611c71d38dc370ac57e7c97`（1259 文件）；core、Host integration 和 native-pair 各自前后稳定。

组合复验先发现旧 envelope fixture 显式强制 `lookup`，但返回文本且期望成功。当前 tool-choice 合同拒绝该响应是正确行为。fixture 改为当前响应中的真实 tool call，保留原上下文、选项、无执行和无自动 Transcript 写入断言，并增加“历史 lookup 不能满足当前强制调用”的拒绝反例。没有放宽生产 stream/工具合同。

| 组合验证入口 | 实际结果 / 事实层 |
| --- | --- |
| `verify-host-health.mjs core` | 1459 pass / 152 文件；Rust 39 pass；根/Web 类型及协议一致性通过 |
| `verify-host-health.mjs integration-host` | 6 个包装测试通过；内部 Node 98 项，真实打包制品与合成业务依赖 |
| `verify-host-health.mjs native-pair`，显式原生 opt-in | 33 pass / 6 文件；当前原声明、原 worker/自有 SQLite、完整候选及合法语义反例 |
| `bun run test:native-host` | 28 pass / 6 文件；当前原生 retry/compact/辅助 no-op 与只读副本 |
| `verify-modeld-core.mjs tool-contract` | 扩展后的 16 文件、193 pass；真实程序、合成 Provider/capability/自有资源，不是 native 工具权限或现场成功 |
| installation/controller 三文件 | 首次 35 pass / 1 opt-in skip；随后显式开启只读 systemd parser 检查，36 pass / 0 skip；manager 始终是自有 fake，没有改现役服务 |

随后相邻路由回归发现 `modeld-core-verifier.test.ts` 仍在 LIVE 的来源列寻找结果，并要求已经退出的固定分支文字。测试改为核对当前第二列的实现/结果、第四列的来源及原拓扑路由，接受当前 `not-run`/`excluded` 词汇，不修改 LIVE 结果或把未运行写成通过。修正后相关五文件 77 pass。此收尾仅变更该测试、本文及两处安装文档的字段列表分隔符（斜杠列表触发了个人路径检测，并非实际机器路径），运行时/原生配方及上述候选字节与 `cb6d9dec` 相同；不把不同输入摘要的窗口混称一次运行，包装内外和重跑计数不相加。

全部命令使用仓库声明的已安装 Bun 1.3.14，不替换系统默认 Bun；Q 早先在默认 1.4.2 上遇到的 verifier 工具链阻断未被绕过，以上是满足原工具链门的重新执行。原 Native Node、Host/worker、协议和调用合同仍按本报告前文限定。最终文档/公开性检查和实际回流 SHA 记录在 Linear AH-111 的签收回执中。

A1 核心交付完成不代表 A2 的所有可达补丁覆盖、A3 材料/退役或 J2/真实采用完成。没有执行完整 Host、收费模型或 Bot/桌面操作，没有发布 profile 或切换现役服务，整体 `qualified=false`。独立产品审查和 LIVE 仍由各自后续门拥有。集成树的并行消息 API 未提交改动未纳入本次固定验证，也未被修改或提交。
