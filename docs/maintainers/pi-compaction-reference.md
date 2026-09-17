# Pi compact 实现参考与 grokbox 差异

**参考与包复用审查：2026-09-17；不是运行手册、最新版本声明或集成完成证明。** 当前[ADR](../decisions/2026-09-17-local-context-maintenance.md)接受实际复用优先，[Spec S12.0](../roadmap/box-runtime-impl-spec.md#pi-compaction-reuse)/[CTX-00](../tickets/CTX-00-pi-compaction-reuse.md)拥有资格与选择。本页区分coding-agent的用户行为参考和agent-core的真实库接口；不能因它们同版就混用存储/返回类型，也不能实例化Pi Agent代替Host会话维护。

## 固定参考，而非浮动 main

检查的发布包：`@earendil-works/pi-coding-agent@0.85.1`，声明 MIT。官方 [v0.85.1 release](https://github.com/earendil-works/pi/releases/tag/v0.85.1) 与 Git tag 解析到 `d981de1229ef899957bbe968bc8dcda02a21f477`。本次逐段检查的是该已安装发布包的 JS；以下源码链接用于公开定位，不声称 TS 与编译 JS 的字节相同。安装路径、用户模型配置、凭据和真实会话不进入本页。

| 发布包相对路径 | 本次检查字节 SHA-256 | 定位范围 |
|---|---|---|
| `dist/core/agent-session.js` | `fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f` | prompt 821–949；自动判定 1634–1728；执行/重建 1739–1867 |
| `dist/core/compaction/compaction.js` | `3d5f1f2a3e801c965214717b6abad1839239b4a030517bffdf0c8eff25df5c2a` | 默认/估算/阈值 74–165；切点/prepare/compact 函数 |
| `dist/core/session-manager.js` | `ccace64949db25379a43971ecea750c1b7ec6344e1bc31b9d5fe596ac2f1c9f3` | buildSessionContext 与 appendCompaction |

公开源码：[`agent-session.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts)、[`compaction.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/compaction.ts)、[`session-manager.ts`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts)、[compaction 文档](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/compaction.md)。版本升级须重读，不以这里的行号或浮动分支给新版本背书。

<a id="core-package-reuse"></a>
## Agent-core 0.85.1：可复用的库表面

在v2 `02a6d81`之后的复用调查中，直接核对 `@earendil-works/pi-agent-core@0.85.1` 与 `@earendil-works/pi-ai@0.85.1` 发布包的package.json、实际JS和声明；不以之前coding-agent路径代替core证据。本轮在线固定源码读取未成功，以下接口事实由实际安装包字节支持，未重新声称这些字节与Git tag构建一一等价。包来源/registry integrity在CTX-00的锁定依赖资格中仍须补证；本地SHA只是已读文件身份，不是供应链来源证明。

| core包相对文件 | 已核对SHA-256 | 内容 |
|---|---|---|
| `dist/index.js` | `4a551a8b128525e90f3da827f5c459a6f6ba39796c63b2ba73d0f0bfb7be9e72` | 根入口公开导出，第7行compact函数集合 |
| `dist/harness/compaction/compaction.js` | `fcaeb2e25d5cedca80e3487f8ec02014b0e780b68e67c33d579af7b80cc91dd7` | prepare/compact/caller-owned请求/默认重试包装 |
| `dist/harness/compaction/compaction.d.ts` | `e7636d4d807ffe8bd23c0248a26b8e0179d17a332eeb04ea6a8b76a8b2885609` | Entry/retainedTail/Models/SummaryRequest类型 |
| `dist/harness/compaction/utils.js` | `ab85613e2d299087a9882378da7d62adf77aa19130d16e502bbef45d82fc10b6` | 摘要材料序列化，第62行2000字符工具结果限制 |

公开定位使用同一[官方仓库](https://github.com/earendil-works/pi)的[agent package](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/package.json)、[agent入口](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/index.ts)、[core compact](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/compaction/compaction.ts)。链接是来源导航，不替代上述发布包核对或未来安装integrity验证。

| 已核对事实 | 影响 / 尚不能声称 |
|---|---|
| 根入口公开shouldCompact、estimateContextTokens、estimateTokens、findCutPoint、prepareCompaction、compact、generateSummaryWithUsage、serializeConversation | 可以从公共包起步；不能再把“compact必须搬CLI”作为前提 |
| `compactWithRequest`与`generateSummaryWithRequest`在内部JS/声明中存在，根入口未导出；package exports无compaction子路径 | 有caller-owned请求设计，但需公共Models桥/最小导出补丁资格；不能把deep import当公共接口 |
| core `prepareCompaction`返回Result；结果包含retainedTail，既有compaction记录也消费retainedTail | 先前coding-agent的firstKeptEntryId描述不是core API；映射回Host源引用，不直接持久化任何一种Pi格式 |
| `compact()`经过Models及completeSimpleWithRetries，内部caller-owned版本逐次调用request | 需要关闭库内重试并实测每个请求归属；单个compact可能产生history/prefix多个摘要请求 |
| serializer将每条工具结果截到2000字符并加提示 | 这是摘要输入的截断，不是删除磁盘历史；不满足S12材料覆盖时须在回调前解决，不能回调里补已丢内容 |
| 摘要生成对aborted/error返回错误，但contentText为空或length终态可能仍形成ok结果 | 我们必须独立验证非空、完整终态、预算/结构，不把库ok等同于可提交root |
| core和ai包均为ESM、声明Node>=22.19.0且带其他依赖 | 不自动符合grokbox当前Node>=20.17.0；只在Node22探针通过不是发行兼容证据 |
| pi-ai提供Provider/Models与可选fetch接口，Provider拥有auth/stream行为 | 可作为独立ModelBackend候选；具体Provider能否注入、取消/重试和凭据隔离仍须逐项验证 |

先前无网络公共导入/prepare探针只证明八个导出可调用、输入未突变及工具尾sentinel会被默认serializer省略；没有创建Pi Agent/会话，也没有通过真实摘要桥、Node20打包或Host端到端。CTX-00必须在项目隔离夹具中把这些检查重做成可复现向量，不能用这段调查记录直接标Done。

## Coding-agent 0.85.1：用户行为对应表

| Pi 0.85.1 中检查到的机制 | grokbox 采用 / 调整 | 证明入口 |
|---|---|---|
| `prompt()` 在构造新 user 消息前等待 `_checkCompaction(lastAssistant, false)`；该路径可检查中止响应 | 新输入是旧会话维护机会；额外覆盖没有 assistant 的首请求，并把本次输入/注入计入预算 | CTX-A01/A03 |
| agent loop 的 context transform 检查工具结果之后的待发消息 | 不只在 TURN 尾检查；下一次主模型 HTTP 前必须已经合格 | CTX-A04 |
| `shouldCompact` 比较 `contextTokens > contextWindow - reserveTokens`；默认 enabled，reserve=16384，keepRecent=20000 | 用本地窗口控制；保留易解释的预留/近期预算，但按真实输出预算及最终请求额外限制 | CTX-A02/A05 |
| 估算优先最近有效 usage + 后续消息；error/aborted/全零 usage 不作为基线；无 usage 可纯估算 | 错误不清零；基线还绑定 root/模型/编码/策略，unknown 不造精确值 | CTX-A03/A06 |
| 自动判定避免用最近 compact 之前的消息 usage/error 重触发；错误的旧模型也不能直接驱动新模型恢复 | 用 root revision/compaction boundary 而不只比较墙钟；切模型按新窗口重新 preflight | CTX-A06/A07 |
| 合法 cut point、近期保留与 split-turn prefix summary | Host 合法分区/工具组；不移植 Pi session 格式，不按数组下标盲切 | CTX-A08/A09 |
| `appendCompaction(summary, firstKeptEntryId, ...)` 后 `buildSessionContext()` | 映射到 Host archive/carrier/root/checkpoint；新进程回读验收 | CTX-A12 |
| overflow 恢复受一次尝试限制；失败消息保留历史但不污染恢复输入 | 复用 T32 更窄的零放行/同 STEP 合同；不照搬对 partial/length 的继续策略 | CTX-A13 |
| 手动和自动经过共享的摘要生成底层 | 共享一套维护程序，手动操作使用独立 operation，不伪造 native STEP | CTX-A14 |

以上是对代码行为的有界解释，不等于 Pi 能处理任意大小输入、所有错误或所有插件组合。尤其不能把“调用检查函数”提升为“每一次新消息都会进行摘要”。

## 必须补强，而非照抄

**完整待发输入。** Pi 上述 prompt 检查点早于追加新消息；grokbox 在旧历史维护时预留新输入，最终将 system/tools/pins/Memory/附件/工具结果及协议投影一起计量。没有最近 assistant 也不能跳过。

**估算与实际用量分开。** Pi 的字符启发式用于估计，不是跨 tokenizer 的上界证明。我们保留来源、误差/安全余量；有效 usage 的缓存字段按 adapter 语义避免重复累计，reasoning 是输出子集。Host 大窗口先有有界本地计量/分段，不能先制造超限 IPC 快照再请求维护。

**输出预留与目标预算。** 固定 reserve 不能小于本次实际允许的输出预算；小窗口配置不得产生负输入预算。新摘要必须在同一个最终编码器下低于目标，不仅更新 tokenBefore 或看到消息数下降。

**依赖与取消。** grokbox 的 Host/modeld 是两个进程，root 会被下一 STEP 复用；需要真实 root owner、generation/revision fence、摘要 source 与等待者寿命、有限请求/期限和 crash 对账。不能直接复制进程内布尔值或数组替换来承担这些职责。

**摘要路径和持久化。** 专用摘要请求拥有可信purpose、独立身份和预算、无业务工具；Host提供权威材料/合法分区和接受格式，Pi算法可生成合资格候选，不要求Host再总结一次。原始Host消息/metadata按源引用保留，Pi视图只读且短寿命；长期分段/合并不是新Agent loop，也不能以provider auto-compact掩盖Host仍过大的root。

## 当前 grokbox 复用与真实差额

基线：`7994b92`（包括统一配置和 reasoning schema v2/wire v7）。后续源码变化须重新核对下表；本页不记录运行中的 PID、endpoint 或原始事故标识。

| 当前源码 | 已有性质 | CTX 接收的差额 |
|---|---|---|
| `kernel/internal/inference/overflow-recovery.ts` | 同 tuple、零放行、一次恢复；无 HostCompact 即拒绝 | 主动/手动维护与失败重试账本分离，共用实际维护程序 |
| `kernel/internal/inference/step-program.ts` | 绑定/准入/auth/取消与模型调用 | 首请求/工具后预算门，摘要请求独立寿命，policy pin |
| `box-runtime/internal/host/compact.ts` | live slot、root owner guard、同连接新 snapshot | 不只接受 active STEP；pending 协调、目标预算、prepare/validate/accept/checkpoint 分层 |
| `box-runtime/internal/host/live-slices.ts` | provider 前注册；managed 活跃时抑制两处原生后台启动 | 不能只有抑制而无替代推进；补安全点维护并保留 official 对照 |
| `box-runtime/internal/roots/modeld.runtime.ts` | exact-1 环境开关接入现有恢复桥 | 新配置/资格取代普通功能开关；故障注入不随之开启 |
| `kernel/internal/selection/models.ts`、`host/session.ts` | 模型容量、selection pin、Host extendedUsage | 本地工作窗口不冒充模型能力；有效策略与模型选择独立按域计算 |
| `box-runtime/internal/backends/ai-sdk.ts` | 已有最终请求字节与工具声明门 | 增加预算复核，不能在 fetch 中直接改写历史或发 compact |

路径以 `packages/runtime-kernel/src` / `packages/box-runtime/src` 为根。上表是原调查基线的差额，不代表后续实现仍缺失：当前CTX已选择受控Pi纯代码提取，实际来源/差异/许可在 `internal/context/vendor/pi-compaction/PROVENANCE.md`，实现与证明见[CTX-00](../tickets/CTX-00-pi-compaction-reuse.md)及[离线报告](../reports/2026-09-17-context-maintenance-offline.md)。完整当前配置只看[配置指南](../configuration.md)。原始包证据不替新构建或现场能力签字。

## 参考与测试的边界

CTX-00先实现CTX-R01–R07复用资格，CTX-01–04消费真实选定算法并覆盖128000/16384、500K→128K、无usage/错误、源引用安全切点、工具第2000字符后事实、空/length摘要、取消迟到和持久重建。expected由独立golden给出，不能调用被测Pi函数自己生成正确答案。包依赖经项目锁文件与正常安装准备后可进入公共构建/测试；不依赖全局Pi、用户会话/配置、运行时下载或外网provider。需要patch/提取时保留许可原文/归属与精确差异，CTX-00明确单一选择；不是默认从头重写，也不引入Pi Agent/SessionManager。

进程内pi-ai替换AI SDK的资格由[PI-AI-01](../tickets/PI-AI-01-model-backend-qualification.md)独立承担，采用core算法不等于启用pi-ai的真实Provider传输；该票不阻塞CTX，不替代T30的RPC资格。

Pi包版本/exports/锁定闭包、源码补丁/提取、Node基线、serializer、meter、Host编码/root接缝、provider输出语义、配置默认值或选择pin变化，都会使相关CTX-R/CTX-A对照证明需要重验。源码比较、纯函数测试、完整 grokbox 离线链、原生资格及 live 结果是不同证据等级。
