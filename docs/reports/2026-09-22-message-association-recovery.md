# AH-118 消息关联与原请求恢复接续

2026-09-22。初始已提交 v2 为 `1ba79836`；公开反例从该版本实际执行。期间 v2 回流 `f622fb88` 的消息修复，本次在其之上内容级吸收原生 generation 保存、传递、换代拒绝及两个反例，保持单一消息 owner，没有留下两套关联算法。技术合同归 [CLI-03](../tickets/CLI-03-observation-and-wait.md#消息关联与对账2026-09-22)，排程和最终合流回执归 Linear AH-118。

## 已复现与修复

新增七个公开 HTTP/应用反例在原基线全部失败：按位置错配回复；streaming/错误收件人/歧义 nonce；delivery 未携带或复验 dispatch generation；lost receipt 未保留发送前来源代；原生发现离线导致原操作不可恢复；损坏记录被当不存在并二次发送；显式负 acceptance 被报 accepted。

当前消息 entry 保留原 kind、native requestId、streaming 标识和有界正文。只有 `kind=message/role=user/clientNonce` 找到唯一 requestId 后，同 requestId、显式 `isStreaming=false`、面向用户的 `send-message` 才是交付观察；缺最终性字段不默认为false。普通 assistant 即使位置、thread 或 nonce 相同也不是 SendToUser 证明；不能凭一次进度投递签完整 TURN/run/STEP/terminal。

发送前落盘已观察的 generation，delivery 将其送到原 continuity port 并校验返回来源；首次带 expectedGeneration 的 gateway 调用也独立校验实际响应，不只转传参数。缺派发代不读取其他代。发送 ACK 只保留有限 accepted/queued 字段，不泄漏原生任意 payload，也不代签 transcript recorded。

重复 request 先读持久原回执，再决定是否需要原生发现；错安装/主体、损坏/不相容记录拒绝而非清空后重发。记录以有界非 symlink 文件读取，claim/receipt 原子写与目录同步，文件失败清理本次临时文件。操作 Scope 拥有 gate 与 gateway signal，只有有限本地持久写不受中断；等待使用 Effect sleep，失败、取消或换代不重派。重启 Server 后原 unknown 仍可读且不重新发送。

## 公开隔离验证

`packages/server/test/messages.test.ts` 从当前源码打包 `messages.node.ts`，由实际 Node HTTP/Effect Server 与 shared client 执行，原生能力由自有 fixture 替换。覆盖上述失败以及并发一次发送、Scope 关闭、Server 重启、无来源代、有限等待、ACK 隐私和集成树既有反例。实际通过 19 项，0 fail/0 skip；这不是19次真实Bot或Provider调用。

`continuity-message-generation.test.ts` 验证首次 reply 的 expectedGeneration 与已 pin owner 的写前拒绝；原 legacy Memory capability 拒绝测试继续保留。结合 shared client 的 10 项测试，包装外清单为4文件14 pass，包装内Node19不重复累加。根 typecheck 已通过；最终构建、Web类型、Server交叉回归、docs/publication与准确源码摘要/合流 SHA 见本票最终回执，不借用旧计数签署全仓。

## 原生来源与未完成资格

本轮可执行的静态 AST 结构观察读到 Host SHA-256 `68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc`，worker SHA-256 `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c`。它们与 A1 已登记的 `ebd92f0d… / 4c154a34…` 不同。没有将新字节加入生产 pin，A1历史资格仍仅针对原窗口。

有限 AST 信息确认 `sendPrompt` API 转调 manager 并返回 accepted；该 wrapper 原声明摘要为 `db5a036867cd5e05d0909ab746cce01ec4145cec057d58d15c0c8c794fcede94`，`getAgentTranscriptTail` wrapper 为 `1eb2db7c38e254238220ca9169e2e7262bf8b2e6a6f493878f8acc3d3218ea2d`。只输出摘要和字段结构，没有执行 Host 顶层、读取真实 Bot transcript、付费调用或发布 profile。

后续私有原声明检查再次遭执行工具安全检查拒绝，该操作停止，未更换工具或改写私有读取来重试。管理侧公开反例和修复是独立执行的有限窗口，不能替代新来源下的原声明/worker/自有原生存储资格。新生产者任务 AH-157 已明确阻塞 AH-118、AH-117、AH-120 的相关原生资格，不让 A2 反向成为 D1 的开工前置。

AH-118 的管理侧修复可以回流，但整体原生联调未签收；账号/ownership scope、实际加载和原版 App 可观察字段仍须在相应来源与授权窗口核对。没有通过改状态、位置猜测或修改 fixture 的名称把这些缺口变为完成。


## 组合检查与范围

在 `f622fb88` 上吸收两边回归后，正式构建通过，根与Web类型检查通过；Web首轮缺少干净工作树尚未生成的 routeTree.gen，按原构建生成后复验通过，未改源码求绿。Server/client/gateway组合清单为23文件110 pass，0 fail；其中实际Node的管理Server36项和消息19项均0 fail/0 skip。文档16项及包括新增文件的公开性扫描通过。包装内外计数不重复累加。

这不是全仓/live最终候选签署，原生结构执行阻塞和AH-157依赖仍保留。原AH-114披露的旧CLI Gateway fixture迁移不在本次清单中，也未恢复旧writer。最终固定源码/测试摘要、提交与v2合流回执记录在AH-118；本报告仅固定本轮观察，不拥有Linear任务完成状态。

最终源码/测试/锁输入共1269文件，摘要 `7e62af1153db5d171a557d855532eae1651c7fa70854fad4312c6f51f1e55ca7`，上述最终组合执行前后完全一致。该摘要不覆盖生成dist或原生依赖，不能充当新Host资格。
