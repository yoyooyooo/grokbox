# 在官方前置条件之前选择 managed session

2026-09-27，AH-187。[当前来源与生命周期差额](2026-09-27-current-source-and-entrypoint.md)之后的独立源码包；现场进度以 [LIVE](../../tickets/LIVE-integration-validation.md) 为准。

## 实际变化

旧入口先解析官方模型并构造官方 session，之后才调用 managed hook。反例中，指定 Bot 会被无关的官方构造失败挡住。当前入口先选择：有逐 Bot assignment 时返回 managed session，选择错误直接抛出；未指定 Bot 或非 route 模式则返回 undefined，由调用方继续执行原生方法体。没有官方 fallback，也没有新增 Loop、模型配置 writer 或 session owner。

正式 literal recipe 和结构化 emitter 共用一个前置模板。emitter 用现有 Acorn 在有界方法窗口内保留 directive prologue；严格模式的实际执行反例通过。旧 originalSession 入参及相关调用方已迁移，最小 synthetic profile 也使用当前模板。native-selected/returned 只记录 hook 返回原生选择，不能证明随后官方构造成功；现有 witness 的有限证据边界保留。

## 证据与范围

当前原生来源仍为 `0b67642` / Host `7acd9a7e9272833758f2f7aad72a4a9146da7f6098a692fb4f60e16390978797`，worker `0488b49621476501b92693efebc3f974d5a21cee4d8acc1a4339dc818780d53d`。

- 迁移调用方组合中 152 项公共测试通过、1 项原生测试跳过；witness 对返回结果的严格检查曾失败，已修正为只记录 hook 返回选择，并通过后续实际打包 Node witness 的 26 项内层检查及 13 项外层定向回归。没有放宽 witness 的 outcome 验证。
- 固定原生函数配合真实 managed hook，在官方模型解析/构造被设置为不可用时，指定 Bot 得到 managed session，原生模型读取、session 构造和模型实验应用计数不增加；未指定 Bot 仍呈现原生错误。该入口及原生模型预览单文件 120 assertions 通过。
- 最终 native-pair 40 pass；native-runtime 4/4 commands、88 个外层测试；Local-first 原生声明和上述原生入口同时通过。typecheck、build、docs checks 通过。

最终隔离 63 切片候选 transformed SHA 为 `bb04f4c8b8776ade28dc9efa688ab267a35bdb5d7ab74b0f812c2d69f9f95dc2`，ordered recipe SHA 为 `a91148e6c3a9f92a649ac7dd6751e86467c75f1bdddaf133726808052fa2ecfb`。资格仍为 `qualified:false / passed-in-selected-scope`：没有执行完整 Host、提供者请求或 App 业务；本报告也不签安装、加载或 committed adoption。按最终固定制品重新发布 profile、采用与静默创建后，才继续业务与通知出口。

原失败操作、10 条 unknown 和恢复回执保留。费用仍 billing not observed。

## 正式采用前的来源重绑

固定 `94a16e81` 已安装并验证 99 个发布文件及原生 SQLite/Level 读写，但正式 observe 时发现官方自行更新为 `b77855a`。本轮没有发布 profile、采用 Host 或创建哨兵；上一来源的资格没有沿用为当前加载资格。

新 Host 为 `656b3b5dad14dcf5b0d7afcba00f2a97f46cf2dc6860ac7b5db5cedce00df6f0`，worker 未变。完整原文已保留；63 个锚点、局部模块绑定及 disposer 摘要重新核对。只更新当前配对 pin，没有增加旧版本 fallback。build、native-pair 40 pass、native-runtime 4/4 commands / 88 个外层测试、Local-first + 原生入口 2 pass / 161 assertions 均重新通过。

新隔离候选 transformed SHA 为 `0311a1509b2e30438b55bf193abbc81783e20bbbd780e7059e7f874bcb256595`，ordered recipe SHA 为 `fc2523e990cb6bcb238465cea3cfe052fb2a2a413f324bea80411570012e6b87`。范围仍为 passed-in-selected-scope，未加载、未创建、未推理。
