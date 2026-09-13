# T38 — 身份写入收口与 test2 安全校准

## Status / scope

**Partial · 2026-09-12 CLI/direct/daemon已证；15:56 UTC候选源码已退出5个harness写入切片，未部署／未校准test2。** 本票关闭V21/V22。只以Server正式归属校准本地，不修改Server harness、不主动发起官方Box→Temporal迁移，不把资料更新当迁移。新建对象可请求box，但以官方创建确认和回读为准。

Spec：[Server归属优先](../roadmap/box-runtime-impl-spec.md#server-authority-rollout)。T37拥有证据/准入，T24拥有模型选择；本票只拥有可能改变身份的命令和Host writer退场、安全对齐。

## 当前保全与启动影响（2026-09-13）

本窗口已刷新原始Server归属，test2仍为temporal/local box；test0/1保持box/box和原角色。test2两库已做私有只读SQLite online backup（包含WAL），备份窗口无观测到的DB提交/普通文件变化/Host换代，且两次不运行投影一致。新进程SQLite integrity与root blob存在性通过，加密元数据和pending episode保留；**尚非原生reader恢复或Server Temporal分支副本保全，没有回写现场**。准确收据与上限见[readiness](../maintainers/t32-live-enable-readiness.md)。

当前原生源码/隔离运行确认startup通过`reconcileBeforeStartupResume`做全局身份同步，撤旧writer后可对齐test2。owner已单独允许完成保全、未知执行处理和审查后的受控启动同步窗口；不得把这次授权推广为任意身份修复、Server修改、历史合并或任务重放。两个未确认本地对象及remote-only/资料同步影响仍需诚实表达；仅枚举本地41个对象不证明全Server范围。该保全窗口时现役尚未切换。随后经Grok xhigh复看和单独同步授权，首次受控Host启动已由原生writer将test2本地对齐temporal；原Box root blob/展示计数/pending episode与保全一致。新一代Server确认被T37异步machine scope缺陷阻塞，修复后的回读仍需完成；不宣称T38整票Done或合并两历史。

## Current gap / reuse

当前`commands/management.ts`的普通资料更新已不携带harness；显式existing-harness修改在读Gateway之前拒绝，底层typed Gateway/daemon入口也拒绝。创建只执行一次，并用原operation/目标身份核对Server读回；不支持/错误/缺证输出已创建但未确认，不重复创建或删除。

当前候选已去除`harness-profile-rpc / harness-update-trim / harness-agent-write / harness-local-write / harness-server-write`。保留`harness-blank / harness-summary`只读观测与ownership桥。原生local/server writer原文在转换后不变，不再注入自定义本地优先策略；**现役Host未在本批次重新领养，不能据源码变化宣称现场已对齐**。

复用现有`createProfile / mergedProfile`、ConfigurationWrite/operation receipt、Host原生identity writer与T37证据。逐个列出相关slice的“保留观测/去除隐式写入/受控替代”判断；不批量删切片后在现场看会发生什么，不创建第二身份同步器或直接写产品SQLite。

## Required changes

### 1. 普通更新与新建

普通`agents update`的名称/说明/头像/notify/hidden变更不发送harness，也不从roster回填其旧值。对显式修改既有harness的请求应在写入前拒绝并说明不支持常规迁移；不能接受后仅改本地。CLI/help/registry/daemon/tests必须一起收口，历史“always sends box”预期改为能抓住意外字段的负例。

`agents create --harness box|temporal`仍是创建意图，不是结果证明。复用nonce；比较Server确认的公开UUID/行ID/harness并读回。确认缺失或相反时输出已创建但未确认/资格不符等真实结果，不再次create、回滚删除或强制改本地。未知创建结果以原nonce对账。新Bot不自动opt-in生产；合法temporal创建保留原生能力检查。

### 2. Host writer退场顺序

先有T37零副作用门与冲突保全，再撤销“本地归属总获胜”的拦截。普通本地资料写入仍保存现有合法身份绑定，但不能把普通参数转换为归属修改。Server身份同步由原生owner执行；只读ownership桥与诚实的明确box/temporal投影可以保留。

对所有可能受影响的Bot先做只读清单和影响范围判断。不能因去掉一个global patch就自动全局reconcile，把既存冲突全部改平。原生可用入口若仅支持全局reconcile，不得伪装成逐Bot；必须先展示全范围影响、确认授权与在途状态，条件不成立就保留冲突，不手改profile兜底。

### 3. test2两种完成态必须分开

**阻断回归是必需发布门；真实数据校准是单独确认后的操作。** test2不再作正向managed/heavy canary。先固定可重复的合成Server temporal/local box fixture，再保留私有、带来源的必要身份/执行/两分支历史及原生状态证据；不把真实正文/密钥搬进公共仓库。

- 保全要使用可验证的一致性备份/原生快照手段，考虑SQLite WAL和在途writer；任意复制一个打开中的db文件不构成可恢复快照。
- 在当前冲突上只读诊断；受控本地准入负例必须证明provider/tools/SendToUser零新增效果。不能从App向test2发一个真实任务期待Host拦下，因为App→Server可绕过Host。
- 有未知旧操作先按原身份对账，不以改harness重新执行；保全路径/摘要、恢复可行性和影响范围确认后，才允许原生安全对齐。
- 正式修复以Server的temporal登记为目标，让本地停止错误Box执行；用显式`runtime models reset --for <id>`撤掉该对象managed期望配置（不要求它先通过managed准入、不授予官方执行权），保留旧Box历史为独立归档。它不是模型上下文自动合并，也不能恢复冲突配置作为“回滚”。
- 修复后只读再确权；必要官方Temporal验证单独明确范围。UI可能恢复官方历史，不代表旧Box分支已迁入Server。不删Bot、不删任何一侧历史来取得绿灯。

本票允许先达到“实现/阻断已证、现场保留待确认校准”。索引与readiness须清楚分开这两者；未做真实修复不能标全部Done，也不能让选择保留诊断样本无限阻塞无关的干净Box生产候选。

## Planned commands / safety boundary

复用`agents create/update/ownership`，不新增泛化harness setter。若原生安全对齐确需产品化操作，须在本票先定义窄的preview→confirm→read-back合同和未知结果语义，不能将`ownership`只读命令变成自动repair。本轮不宣布任何新的alignment命令已存在。

## Acceptance

已加入`bun scripts/verify-runtime-rebuild.mjs identity-alignment`，当前证明普通资料body、direct/daemon拒绝和一次创建后的确认/不确定性；报告明确`notProven` Host writer退场、现场test2保全/修复、live创建更新及生产放行。打包安装测试通过不自动等于Node CLI所有identity行为已单独验证。完整本票仍需下列向量：

| oracle | 必须抓到的坏行为 |
|---|---|
| 更新资料的实际Gateway body | 未传harness却附加box/temporal、原字段省略却补默认 |
| 显式既有harness修改 | 写前拒绝，原生API/provider/signal次数0；help不再称迁移成功 |
| 创建box及反例 | Server确认后才qualified；未知、错ID、反向确认不二次create或默改 |
| writer切片关闭/替换 | 本地普通资料不改归属；Server正确binding可落地；错ID/未经确认不会强写 |
| test2合成冲突 | T37一直block；没有工具、摘要、Memory、SendToUser新效果 |
| 安全对齐中断 | 保留私有源证据、未知结果可读回；不重复调用、不假回滚 |
| 限域 / 全局入口 | 不以逐Bot文案调用有其它对象影响的操作；其它Bot无未授权修改 |
| 校准后 | Server登记不被本工具改、身份一致、旧执行不复活；两历史未拼接 |

## Module / dependencies / exit

主要涉及`packages/cli/src/commands/{management,agents}.ts`、registry/help/daemon及Host身份相关slices，复用原有命令权限与IO边界。`test/cli.test.ts`、`management.test.ts`、`host-harness-emit.test.ts`和新的合成alignment向量是证明入口；不得依赖私有dump运行公共CI。

依赖T37可执行gate和已校验的原生identity写入合同；T38开发可与T24选择单元测试并行，但同一文件始终单writer。完成后交T39使用不被隐式写入干扰的Box候选；T40发布单需报告test2“保留/已校准/未知”的准确状态。

### 当前source/packed退场证据（2026-09-12 15:56 UTC）

前轮被拦的尝试是历史；本轮直接运行更新后的同一`host-harness-stick.test.ts`，先得到0 pass / 8 fail，再实施退场后8/0。原生形状的local/server writer body逐字保持，合成记录证明普通rename保留原binding、原生server writer接受新的Server binding、不被旧本地box阻挡。它不证明存在公开反向迁移API，也没有调用真实writer。

旧五slice ID从允许集和production patch list移除；`harness-stick.ts`不再有运行hook或优先策略，只作为纯退休ID拒绝规则供profile校验使用。`applyPatchProfile / transformUnchecked`遇旧写入ID返回`retired-slice`；公开profile schema/authoring层也因允许集移除而拒绝，不保证各层使用同一个外层error code。不能用已有旧profile绕回旧策略。preload不再安装旧symbol；实际构建产物也核对无旧hook。当前`identity-alignment`整组31/0，相关slice/原生copy/syntax/transform另29/0（范围重叠不相加）。

部署必须先固定新的完整profile和T37可用门，取得native pause/独立review及冲突保全证据；**旧现场profile不能直接用于新候选**。原生启动同步可能影响既有冲突，不能因source通过立即全局reconcile或把test2压成任意一边。test2的私有状态保全/原生安全校准、本次新候选live读取仍未完成，保持未关闭。
