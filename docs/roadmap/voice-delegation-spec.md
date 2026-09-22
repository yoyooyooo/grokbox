# Box-only 语音委托：自定义推理与结果交付 Spec

状态：**方向已接受，独立后续事项，尚未启动实施或真实通话验收。** 用户于 2026-09-20 要求先保存方案，在当前手头工作推进完后回访。本文拥有该后续能力的范围、骨架和验收边界；[Roadmap](README.md#voice-delegation)拥有排程，[VOICE 来源票](../tickets/README.md#voice-delegation)拥有实施差额。它不插入当前 HOST-01/CLI-05 优先链，不成为现有 W4/W5 或集中 LIVE 的新增门槛。

## 用户结果与非目标

在不修改官方桌面客户端的前提下，用户通过原生实时语音提出分析、判断、查询或操作请求；当请求实际委托给受管的 Box Bot 时，复用该 Bot 的自定义模型、原生上下文与工具执行，并把结果交回正确的通话。纯文本推理也是合法委托，不要求制造无意义工具动作。

这里的 Box-only 是**改动和执行接入边界**，不是承诺全部数据只留在 Box。官方语音模型仍理解音频、选择是否委托并组织最终说法；它仍可能接触委托及返回内容。本能力不把它降为纯 STT/TTS。

不修改 App/Electron/WebSocket/凭据入口，不代理或替换实时音频服务，不复刻通话 UI，不新增第二 Agent loop、业务调度系统或语音专用 provider。Bot 执行归属与语音 Harness 路由分别观察，不改 Server 登记的 harness 来凑通路。不承诺每句语音、实时转录或全部语义推理都经过 Box；不把当次通话记录当实时请求流。

## 研究基线与重新取证

以下为前轮客户端 0.57.1 拆包与 Host 磁盘来源的**研究线索**，不是本次文档提交重新执行的原生验收，也不证明当前账号配置、已加载 App/Host 或 backend 服务实现。原研究 Host SHA-256 为 `2380c2c7bc3bfe6dc661bfc2640df2a34d79b0e43b234a172abbe55d399b1548`；SHA/旧行号只能定位材料，不能单独充当行为证明。前轮聊天中的抽取回放与测试计数不签收本工作树。

私人研究入口由操作者提供 `grok-bot` 研究仓库根与当前安装的 Host 根；相对客户端根，Renderer 为 `references/src/_app-shell/renderer/assets/index.js`，Electron 为 `references/src/_app-shell/electron-main/main-app.cjs`；相对 Host 根读取 `host-main.cjs`。公共仓库只保留必要定位与语义，不记录机器私有绝对路径，不复制私人源码、转录、账号信息或凭据。源码更新后从符号及调用关系重新定位，不硬依赖旧行号。

| 待重新验证的研究结论 | 源入口与反证办法 |
| --- | --- |
| 转录回调更新客户端本地 turns，结束通话才提交完整记录；不是逐句 Box 推理入口 | Renderer `onTranscriptTurn` / `recordVoiceCall`；跟踪一次 partial/final 更新期间实际出站调用，区分记录与请求 |
| 本地 package + Box 经 Gateway `nudgeVoiceCall`；package + Temporal 的 `send_task` 特判走 backend；backend Harness 直接请求官方服务 | Electron `DesktopVoiceCallHarness.harnessFor` / `sendTaskStampsTheLoopOnTheBackend` / `relay`；分别回放路由，再观察目标通话的真实执行入口 |
| Host 即使收到 nudge，仍可能转交 server-loop 而没有本地推理 | Gateway `nudgeVoiceCall` 和 `VoiceCallRuntime.nudge`；证明实际 box-loop wake/steer 与受管推理关联，而非仅证明接口被调用 |
| request 是语音模型整理后的委托；本地 relay 的 spokenTurns 为空，研究版本 request.length 上限为 2000 | Electron `relay`，Host `VoiceCallRequests` / `MainLoopVoicePrompt.relayed`；测试边界和上下文缺失，不把此上限固化成未来协议 |
| 客户端 receipt 先于远端接受；Host 接受也可早于 steer 的 step-boundary 交付 | Renderer send_task 处理，Host `steerTheLiveTurn` / `queueIfTheSteerIsDropped`；延迟或丢弃交付，分别观察承接、接受、排队、执行 |
| 显式 voice channel 绑定通话；final-word 兜底按 Bot 当前通话选目标；emit 不等待实际播放确认 | Host `speak` / `readTheFinalWordOntoTheLine` / `deliverToLiveCall`，Renderer `ingestInboundNudge`；旧任务、新通话、插话和挂断的反例 |

当前公开代码提供可复用接缝：[live-slices](../../packages/box-runtime/src/internal/host/live-slices.ts)、[session-hook](../../packages/box-runtime/src/internal/host/session-hook.ts)、[turn-observation](../../packages/box-runtime/src/internal/host/turn-observation.ts)。它们是重新核验的实现入口，不证明语音原生闭环已经运行成功。客户端/backend 路由、Host 来源或运行代改变、模型选择/发送工具/事件语义改变时，重新核验受影响范围；不能只看 bundle 默认开关推断账号有效配置。

## 必须成立的核心链

```text
官方语音模型作出 send_task 委托
  → 识别实际客户端 Harness 路由与 Bot 权威归属
  → Box 原生 nudge（或有明确证据的 backend → Box 派发）
  → 原生 wake / 已有回合 steer / 原生队列
  → 原生 Runner → inference.createSession
  → 现有受管 session-hook → 独立 modeld → 自定义模型
  → 原生工具、会话与状态 writer
  → 显式发送到 voice:<originatingCallId>
  → Host 通话事件 → 客户端结果注入 → 原生语音组织与播放
```

1. 首个资格对象必须权威确认为 Box-owned，且当前来源/加载能力支持受管执行。Presence、落盘通话记录、一次 nudge ACK、模型自报身份都不能替代执行链证据。backend Harness 后续去向未知就保留 unknown，不推断必经 Box，也不强制绕到本地。
2. 模型选择沿用 [Execution](../runtime/execution.md) 与[模型关系](agent-first-cli/spec.md#模型选择)。语音新回合和普通文字回合消费同一 Bot 选择；语音 steer 继续已有回合捕获的模型及配置版本。不能只拦 requestSource=voice-call，也不能在 nudge handler 另起一次模型请求。受管失败不静默回官方。
3. 原生 Host 保留 Runner、工具调用、任务、会话/Memory/记录写入权；不直写产品 DB 或另建语音会话副本。自定义模型得到的是主工作上下文加已委托文本，不自动得到完整实时通话。委托应尽量自包含，保留目标、必要引用、限制和禁止事项；缺失背景明确不足，不能凭空恢复原话。
4. 首选显式原生发送工具的 voice channel，调用名/参数以当前能力资格为准，不靠 final text 猜测已交付。默认返回可说的结果和必要阶段结论，不把 token 流、内部思考或全部工具活动当播报流。既有 overheard 路径须单独审计内容暴露，不能因启用了自定义模型而扩大采集或公开。

## 关联、交付与失败合同

| 责任 | 要求 |
| --- | --- |
| 请求关系 | 记录实际可得的 agentId、callId、Box 委托关联 ID、原生 turnId/stepId、selectionRevision 与 Host generation；来源 ID 缺失显式记录。call、委托和 TURN/STEP 是不同对象：多个委托可进入同一回合，一个委托也可跨回合；不能按最新时间或 Bot ID 猜一一对应 |
| 接受与执行 | 语音承接话、Box accepted、queued/steer-delivered、执行开始、模型终态分别取证；客户端提前说话不由 Box 伪装成已经执行。steer 未交付的原生回退继续沿原请求关联，不重复展示或盲目重发 |
| 重复与 unknown | 当前入站若没有稳定客户端请求 ID，Box 新 ID 不冒充端到端幂等键。相同文本可能是合法再次请求，禁止永久按 callId+文本去重；副作用复用真实操作幂等能力。超时、断流、Host 重启后的 unknown 先对账，不能自动重跑 |
| 通话目标 | 特定语音委托默认绑定发起通话。旧通话关闭后，仍应交付的结果经原生文字聊天发送并核验；不自动投向同 Bot 的新通话。普通文字任务是否在电话里播报沿其原有独立语义，不一刀切禁用原生功能 |
| 最终文字兜底 | 显式 channel 与兜底不能重复播报；旧通话/新通话反例需要排除误投。关联不足时保持待核验/未确认，不按“当前通话”补造来源，也不靠关闭全部兜底吞掉结果 |
| 播放与打断 | provider 完成、Host 发出事件、客户端接收、用户听到分别记录。没有播放 ACK 就不宣称 delivered-to-human。插话停止声音不等于取消任务；只有用户明确任务指令才进入原生 steer/cancel。结束通话不隐式取消仍有效的工作 |
| 关闭与恢复 | 通话记录、原生 receipt、未交付结果和挂断后的 leftover wake 分别核对；已接受委托不能因挂断/重拨重复执行。Host/管理服务重启不能将旧代事件配给新通话，未知外部效果不因记录缺失被删除或重放 |
| 权限与隐私 | 接受语音请求不扩大工具许可。字段和观察有界，未知私有输入不复制到公共诊断；权限/scope/保留策略复用现有 owners，且关闭观察不得中断合法 modeld 执行 |

## 实施骨架与 import 边界

不新建包、常驻语音服务、数据库、CLI 通话命令或 Web 聊天面。先验证既有链；只有具体缺口需要时才增加以下文件，不能为目录对称创建空模块。

| 位置 | 职责与限制 |
| --- | --- |
| `packages/box-runtime/src/internal/host/session-hook.ts`、`live-slices.ts`、`turn-observation.ts` | 复用当前模型接缝、捕获选择和来源观察；不另造 voice executor |
| `packages/box-runtime/src/internal/host/voice-observation.ts`（新增） | 轻量原生边界见证与实际请求关联，进入现有 journal/OBS；不推理、不直接写产品状态、不成为 STEP 同步准入依赖 |
| `packages/box-runtime/src/internal/host/voice-slices.ts`（必要时新增） | 经证明需要的原生 observer/交付边界挂接；复用 source recipe、compile/witness 和 capability 资格，不另设宽松补丁加载器 |
| `packages/runtime-kernel/src/internal/voice/delivery-policy.ts`（需要修正交付时新增） | 纯通话目标/晚到结果/重复交付决策；不访问 Host、Gateway、provider 或存储。实际发送仍由原生 adapter/writer 执行 |
| `packages/box-runtime/src/internal/roots/`、现有 observation/provenance 存储 | 资源寿命、有界持久观察和重启代际；不另建语音 ledger，安全恢复所需关联与可回收诊断分别管理 |
| `packages/server/src/observations.ts`、`packages/client/src/observation-contract.ts`、CLI/Web 既有读面 | 如用户结果确需暴露缺口，复用统一管理用例和共享合同；页面不调用 Host/private RPC，也不通过 CLI 子进程执行领域规则 |
| `packages/box-runtime/test/voice-delegation.test.ts`、`packages/runtime-kernel/test/voice-delivery-policy.test.ts`（新增测试目标） | 公共合成调用者和独立反例；不复制私人函数来充当产品实现，不以 fixture 通过替代真实 App/Host |

新 Host 切片必须进入 [HOST-01](../tickets/HOST-01-patch-health-verifier.md) / [HCR](../tickets/README.md#host-capability-recovery) 的既有资格路径：具体来源、适用配方、加载和实际边界证据分开；源码不匹配或不支持就明确未获资格。复用 Rust/Oxc 的既有静态内核，不新增语音 sidecar，不要求先关闭所有无关 checker。纯 kernel 决策不反向 import box-runtime/server；Host adapter 不直接 import Server 业务用例；观察通路不成为第二执行 owner。

## 分段工作与证明

| 工作段 | 来源票 | 出口 |
| --- | --- | --- |
| 重新取证、定位实际路由与覆盖缺口 | [VOICE-01](../tickets/VOICE-01-route-and-host-qualification.md) | 当前来源与运行范围清楚，Box 入口可验证，公开反例可运行；不将未知 backend 路径判为通过 |
| 复用模型链、补关联与交付缺口 | [VOICE-02](../tickets/VOICE-02-managed-execution-and-delivery.md) | 唯一执行/状态 writer、受管选择、忙碌 steer、旧通话与 unknown 等机制通过离线和必要原生资格 |
| 真实官方客户端通话闭环与覆盖评估 | [VOICE-03](../tickets/VOICE-03-live-acceptance-and-coverage.md) | 委托→实际 provider→原生发送→通话播放的分层证据；异常故事通过或明确保留未完成 |

新增测试落盘后才登记可执行命令。现有 `turn-observation` / `host-session-hook` / `host-session` 测试作为相关回归，不以它们的通过签语音 E2E。声明 Host 挂接有效前需精确来源、同代加载/边界资格；实际通话另需目标、费用、权限及退路明确的窗口。届时由 VOICE-03 同批更新 LIVE、执行手册与 harness 的对应场景；本次不增加 LIVE 场景、不改变当前候选结果，也不建立第二份现场状态表。

每个窗口记录实际 App/Host/运行代、有效 Harness 路由、权威 Bot 归属、模型与配置 revision 和各段时序。不要预设未经测量的延迟承诺；至少分开用户说完→委托、委托→执行、首个有用结果→Host 提交与实际播报，不能把即时承接话算成自定义模型首答。

验收分别统计：预先定义的“应委托”问题中实际委托的比例；已委托请求中实际进入指定受管模型的比例；结果提交到正确通话及实际播放的情况。说明样本、分母和未观察项，不把后两项通过说成所有语音都已换模型，也不靠模型自报身份或孤立的测试口令证明调用路径。

## 独立候选：专业问题优先委托

复杂推理、项目分析和事实核验应能形成委托，但官方语音模型是否调用工具仍不受 Box 单方面强制控制。通过 Bot 正常角色描述提高专业问题委托率，是需单独评估的候选策略，不是基础闭环成功的先决条件或已验证能力；不默认改所有 Bot 的角色，不改执行归属，也不要求所有闲聊走工具。

需要实际评估时，以小范围、可恢复的正常角色配置比较前后行为：复杂推理、连续指代/纠偏、精确引用、包含禁止事项及超长背景、重复请求和闲聊。记录内容保真与漏委托，不只统计工具次数。角色描述即使被客户端消费，也不保证覆盖其固定提示词；不能通过伪造 context 字段、工具结果覆写系统指令、扩大 request 上限或改官方开关宣称强制接管成功。

首版核心目标与该候选的结果分别结案。若未来要求“每句语音都必须先经自定义模型，且原生服务只朗读”，那是扩大客户端/实时控制边界的新需求，不在本 Spec 内默许实现。
