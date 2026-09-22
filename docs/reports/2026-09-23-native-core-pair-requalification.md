# 新来源的有限核心配对资格

2026-09-23，AH-157 的核心阶段；base `14c5970656ae25c6aef801d0413db4b32229603b`。本报告交付有界的核心配方/原声明/worker 资格，**不签消息原生 ABI、整张 AH-157、AH-118 或 J2 完成**。技术 owner 沿用 [HOST-01](../tickets/HOST-01-patch-health-verifier.md)、[HCR-04](../tickets/HCR-04-capability-profile-upgrade.md)，原 [A1 窗口](2026-09-22-current-host-core-abi.md)仍仅说明原配对。

## 首次失败与实际修正

原配方按顺序匹配60/61片，完整 preflight 在 `continuity-native-session-owner` 返回 `anchor-missing`。新来源的 session-mutations 模块结束锚点为 fs87，而旧配方限定 fs85。只修改该边界；原 session 的 path138、原 AgentStore 的 awaiter45 均仍匹配。原生测试先按旧独立期望失败为 source mismatch，没有继承旧绿灯。

先推进独立测试期望、不改生产元组，原声明隔离测试26通过/2失败。两项duplicate测试仍提供旧fs77替身，当前原声明使用fs79；按准确依赖绑定修正后28/28通过。原共享schema描述符、awaiter、Serde、原AgentStore和变换后AgentStore摘要与前一窗口相同；worker codec依赖摘要变化单列，不把pin当行为证明。

之后在独占树推进唯一生产核心元组，保留原ebd92f0d/4c154a34为明确拒绝反例，再执行正式worker、全候选语义及Host有限行为验证。没有旧元组fallback、减少切片或放宽原生 opt-in。

## 当前固定输入与候选

| 对象 | SHA-256 |
| --- | --- |
| Host | `68fab3e2c8d53e08f7b89c95054808a360a9b7159afec92904239bc88416eadc` |
| worker | `da6796b285ea7e12f7b6979cabaf823c6aba8dbb0ad4a8efddad8fe3e5f1286c` |
| 完整Host candidate | `6dd3f7e725d1d10d6c0dd2c44786d242a30ed844394e1011a0384fcf251650f7` |
| worker candidate | `bf494d0cfba14c4911e488d9d9f95753cf86c33a3a917ea389b82ddab4b2c552` |
| 61片有序recipe | `c8f1313b3d8b08b88f78ce5872719ca654868e79cf0ded5d790b32880c74940a` |
| 作者candidate profile（未发布） | `c8c0a42dae639e7e041d5c9f67db27ab52b01c1e6adec8111aa6d00594b4d25e` |

`host-managed-current` 仍为唯一配方；schema `native-checkpoint-proto-20260918`、worker协议1。候选只是内存变换产物，未写入原生安装或发布profile。

| 原声明依赖 | SHA-256 |
| --- | --- |
| codecDeclarations | `50bdfaec1611d59699c241874726ee373f6b8ee0614c66a97fbc55bf7980b41d` |
| sharedDescriptors | `b57f70946fd86dc56a7e961f7d53a824512f004ff4008ffb9f38394e175ca10b` |
| awaiter | `e00ec39a24f9b34f800dc0f1b383f54a7e607f7f17b88ae2a05d7d647bac8848` |
| serde | `7f8177c0c3911d9174ab9ce27ca8f0b03230c9c5779c88e1f932871f0ec6ff06` |
| agentStore | `89dcb2d1cdaaf2e89a9a9bbf28928ebb068adb2ccc61f9ff3ed4ac273f1dadd0` |
| patchedAgentStore | `1da70d1213c5548a6a6cc16c5196143a23f839a2baa3a355ae22a4a3d8c53f68` |

Bun1.3.14、原Native Node22.14.0、Rust1.85.0；未改package/lock或协议。实际打包Rust binary摘要 `b0dd1cb7e65c093a5f132c183e570717ea2f257f1a623ee2048a454a8a107e63`，Node摘要 `1abce2374a485bddae3c27b17a3e3143e2780232026e627c4fe74ddde3f380a1`。

## 完整候选语义反例

原Node/只读FD/打包Rust运行四项规则，正例全部passed；每个反例从同一原来源重新执行完整有序变换并重新计算candidate hash。全部保持合法JavaScript且准确返回violated，不以parse失败或unknown来源代替语义拒绝。

| 破坏 | 返回code | candidate SHA-256 |
| --- | --- | --- |
| wrong-input-identity | `native-turn-identity-mismatch` | `749f6b2de54f173efdccdf955aa59d408cf4a4c1b4fda67d39352b9b70bce9e3` |
| managed-retry-reenabled | `guard-does-not-dominate-retry` | `558cb7ef6f4502d67bb49cadcdaefd9432c8875a4f16db67bf6ff2224606aeaa` |
| checkpoint-not-awaited | `checkpoint-lifetime-mismatch` | `48032da00e7493fb8cdb714e17a3617d6c294a13f05bc934bc5ae428562583ad` |
| lease-preflight-not-awaited | `lease-preflight-not-awaited` | `f2db9bd9124aabadf747fc0e08afeec972597bce17e4e20e09b3e5b7885f980a` |

## 已完成验证的边界

- 显式 `verify-host-health.mjs native-pair`：33通过/6文件，0失败/0跳过。包括原声明、生产checkpoint fence、原worker线程/自有SQLite、prepared/receipt/GC fence/重新打开读回及完整候选正反例。
- `test:native-host`：28通过/6文件；当前原retry/compact/辅助no-op与只读副本，不执行完整主Host。
- 直接Host/管理消息/client/gateway回归：288通过/35文件；其中消息Node HTTP/Effect19项使用owned fixture，不代签原生消息字段。
- `integration-host`：6个包装测试通过，内部Node98项；真实打包制品与合成业务事实。Rust39项通过。
- 正式构建通过。根/Web类型与协议、文档和公开性最终回执以及实际合流SHA见Linear AH-157，不从本报告的存在推定检查成功。

上述native-pair及直接交叉窗口的源码/测试/lock为1269文件，摘要 `881850f2d17b0647e6af3eb197e3281a165c1309b10104c1b9cb6d19a83cc636`。各窗口分别核对，不把不同运行或包装内外计数相加。本报告为文档补充，不变更该运行代码。

## 消息交付仍未完成的原生资格

本次允许的静态结构观察确认，当前 `createHostGatewayApi` 的sendPrompt包装调用原manager并返回有限accepted；用户条目工厂保留clientNonce，`createSendMessageEntry`工厂本身没有显式isStreaming字段。这里只描述已观察到的工厂，不推定其后metadata/持久化/同步链也省略该字段。factory摘要分别为 `bc68305cea738938e465e1ab1fcbb9d85db3eb7a4c742d934128df8e0244c4a2` 和 `77908805e0d4fef4279717ed18b2752c1f152dc81d49b3a127bc4001f746d852`。

进一步核验writer/metadata的工具调用被平台安全检查拒绝，已停止该具体操作，没有改通道或间接执行重试。读取既有来源说明/报告路由的另一调用也被拒绝；没有据此覆盖既有文档。新报告只记录已有实际证据，不是替代被拒检查。

AH-118目前要求明确非流式交付才能提升response-observed。该保守判定能拒绝缺证，但**尚未证明当前原生真实交付一定能通过**。不能把缺字段直接补false，不能只凭assistant、同线程、同nonce或工厂形状签SendToUser完成。还需原nonce→requestId绑定、持久交付字段、账号/ownership scope及App可观察标识的限定原生证明；这些仍由AH-157/AH-118的剩余合同承接。

核心配对阶段可以独立回流，AH-157及其现有下游依赖不因此自动Done或解除。实际Provider/App、现役loaded及完整可达风险分别归原LIVE/A2。没有使用真实模型、读取用户Bot transcript、发布profile、切换现役Host/modeld或修改Bot/桌面；`loadedProven=false`、`profilePublished=false`、整体`qualified=false`。
