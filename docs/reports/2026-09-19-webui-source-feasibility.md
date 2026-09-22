# Web UI 数据与原生客户端可行性研究

记录日期：2026-09-19。范围：本轮会话已检查的 grokbox v2 与私有上游研究材料。本文是固定版本的来源分析，不是当前安装状态或实现完成报告。目标页面见[Web UI 方案](../roadmap/future/webui-console.md)，视觉见[V0](../design/webui/v0/README.md)。

## 证据与公开边界

| 证据 | 固定范围 | 能证明什么 |
| --- | --- | --- |
| grokbox 源码 | commit `6f0473d54b16885568e85c2850bc1bde02f58579` | 当前注册入口、适配与 worker 的实际代码结构 |
| 私有 grok-bot 研究材料 | commit `98b308a9a2c3ee67c5d0ff60b81a8be774c84c0a`，Host 完整构建与拆解模块 | 被检查版本的内部行为；重建模块需回查完整构建 |
| 官方桌面客户端材料 | App 0.47.0，renderer 构建 `index-C57MhV1e.js` | 被检查版本的活动标签、形象及客户端动画机制 |
| 前期只读观察 | 本轮会话中的有限字段观察 | 辅助确认研究方向；未保存公开可复现回执，不作为现场验收 |

私有构建字节另以 SHA-256 固定，避免把研究仓库 commit 误当成未跟踪构建的内容证明：Host `host-main.cjs` 为 `2ede71e2db066b32dfe75b5073c0cac8052faf76d23ed34b8fea4567ea0e9baa`；App renderer 为 `15e2677c0f73eb93ea895a5350669c8bd39fcbe1ae67d9cda2018870f9f9ba73`。这些指纹只用于重验定位，不使私有构建成为本仓依赖。

本文只保留必要互操作事实、符号名、版本与本仓定位。私有客户端实现、bundle、原生 dump、用户 profile、真实 Memory/转录及机器私有路径不复制进公开仓库。构建、文档检查和普通测试不依赖私有研究仓库。

来源观察、可行推论、目标设计分开。源码有某字段不保证当前部署已加载，也不保证任意上游版本同样支持。以下上游接口均不是官方稳定公共 API 的承诺。

## Bot 形象可以重组到什么程度

被检查版本的 roster/profile 提供 `avatarShape`、`avatarColor`，自定义头像另有 `avatarVersion` 与 `avatarDataUrl`。原生 `getAgentNotificationAvatar` 可解析 shape/color，包括字段为空时按稳定 Agent ID 推导的默认形象。读取本机 profile 能看到显式配置，但单凭空字段不能还原最终默认形象。

客户端将有限几何形状、颜色、眼睛与状态动效组合显示。形状是程序化 SVG，眼睛及其运动由客户端渲染逻辑生成；头像资源本身不是一张包含全部动画帧的图片。未显式配置时存在基于 ID 的稳定 hash/伪随机默认选择，不能每次页面刷新随便挑一个伙伴。

被检查实现还具有按版本取自定义头像的 `/avatars/<id>?v=...` 路径和缓存校验。认证、图片大小/类型、缓存与不支持 shape 的处理须由自己的窄适配实现；浏览器不能直接获得 Gateway 凭据。

可行结论：保存真实 shape/color/version，优先使用原生解析结果，后续由自有 renderer 实现兼容几何与少量动效。若自行复刻默认解析，必须绑定版本并用自有合成 ID 核对结果。无需预制无限套角色，也不必把所有 Bot 变成机器人头。

限制：目前 V0 是生成式视觉参考，未通过官方 SVG 像素对照；自定义图片、所有几何、暗色主题与动画也未交付 Web renderer。官方身份色用于识别，运行/告警状态使用独立文字与标记，不能随状态改 Bot 本色。

## 官方 Working 文案来自什么

Host 的 `deriveActivityFromUpdate` 根据原生增量和待执行工具调用形成有限 activity。文本/思考增量可以映射为 thinking；工具活动保留 tool、有限 detail/target 与 callId；发送消息或回合结束等事件清除活动。被检查版本将 detail 限制为 80 字符，并短时保留有名称的工具活动，避免文本增量立即覆盖标签。

Shell 的“起草文件”是启发式。实现识别输出重定向、tee、sed 原地修改等模式，并排除几个丢弃/标准输出目标。这不证明文件成功写入，也不是完整 shell 解析。客户端再将有限 activity 投影成易读标签。

| 上游活动 / 工具例子 | 可显示的类别 | 不能据此声称 |
| --- | --- | --- |
| thinking 或文本增量 | 思考 / 生成中 | 知道 Bot 的真实内部计划 |
| WebSearch、WebFetch | 搜索网页 / 阅读网页 | 所有网页都已读完 |
| Read、BoxRead | 读取文件 | 已理解或完成核验 |
| Shell、BoxShell | 执行命令；有文件线索时起草文件 | 文件已成功保存或任务完成 |
| Await | 等待命令 | 发生错误或永久卡住 |
| GenerateImage、CloudAgent | 生成图片 / 编码 | 可计算准确完成百分比 |
| Task | 等待另一个 Bot | 子任务全链路终结已知 |
| Screenshot、Computer 等 | 使用电脑 | 实际执行主体和设备都能由标签确定 |
| request_user_form | 等待用户 | Web UI 应该承担表单回复 |
| SendToAgent、UpdateAgent 等 | 发送消息 | 消息已被接收方读取 |
| 缺失/未知 activity 且 running | 工作中 | 没有 activity 就是待命 |

官方显示还按 composing 区分 typing，并用短暂标签驻留减少闪烁。研究版本的标签驻留约 800ms，工作超过一定时间后显示 elapsed。它们是显示策略，不能充当任务进度。

推荐：保留真实 activity、来源及时间，中文版做透明分类；如增添摘要必须标记为派生说明。不读取或展示隐含思维链，不根据工具数量或经过时间生成固定计划、百分比、剩余时长。

## 运行、归属与来源健康

roster 的 `isRunning`、`isRunningTurn`、`isComposingMessage`、`isRetrying`、`awaitingUserResponse`、`currentActivity` 并非一个互斥枚举。父 TURN、子工作和回复缓冲可能同时存在。UI 可以给主标签，但后台必须保留这些事实的各自含义。

被检查 Host 的 `withRunStates` 对本地 Box 和 Temporal/Server 来源采用不同投影。Server 的 `serverUpdatedAt` 有陈旧处理，研究版本默认窗口约 90 秒；超期意味着本机观察过期，不证明云端停止运行。不能简单以最后到达的记录覆盖所有来源，更不能从 native App 过滤后的 roster 缺失推断归属。

机器在线、服务可达、执行资格、实际工作和观察新鲜度分别呈现。没有来源时是 unknown/unavailable；旧数据保留 lastKnown 与年龄。工作状态的新鲜度目标与低频归属核对分别定义，不把 monitor 的采样间隔宣传成原生逐事件实时。

原生 request lineage、子任务与 run/STEP 只在有真实关联 ID 时连接。相同 Bot、时间邻近或文本相似不能生成完整任务树。现有可选 Host 活动观察桥提供有限诊断，不需要为每个页面再造一套 Watch。

## Gateway 原本已有事件流

被检查 Gateway 已提供经过认证的 `GET /events?channels=...` SSE。agents 和 agent-upserted 可以提供 roster/activity 变化。轻量头像请求头 `x-sand-slim-avatars: 1` 移除 avatarDataUrl，不能因此推定 shape/color 也丢失。

研究版本没有保证初始完整 roster、SSE event ID、Last-Event-ID 或历史重放。心跳只表示传输存活。首次连接先取得快照，断线重连后有界校准，自己的服务再保存归一化事件与明确缺口。即使本地序列可恢复，也不能补造 collector 未收到的上游历史。

当前 grokbox 已有 [GatewayClient.openEventStream](../../packages/cli/src/gateway.ts)、[CLI event 消费](../../packages/cli/src/commands/events.ts) 与 [daemon EventManager](../../packages/cli/src/daemon/events.ts)。EventManager 的 Gateway loop 在第一次 read 时启动，随后随 manager 寿命运行；这还不是“无需读请求即可常驻的完整采集服务”。

当前 [redaction](../../packages/cli/src/redaction.ts) 的 roster 投影只保留有限字段，丢失了部分 activity/头像信息；其他 running 投影也不等于完整 activity DTO。扩充这些有界脱敏投影属于自有服务工作，不需要为已经存在的原生字段另打补丁。detail 可能带路径、搜索词等敏感内容，不能不加筛选地变成全局事件正文。

当前 CLI 允许的事件频道比原生内部集合窄。memory 频道也不能视为全账号 Memory 变化流，研究版本与活跃 Bot 视图有关。应按明确能力扩大 allowlist，不直接透传所有原生频道。

### 后台观察者的断开副作用需要单独处理

研究版本的 Gateway SSE close 会调用 `onEventStreamClosed`，经 Host 的 `noteEventStreamClosed` 进入 `transcript.setWindowFocused(false)`。因此后台观察连接断开可能改变原生客户端焦点相关状态。一个长连接能减少触发次数，不能消除此问题。

结论分两层：读取基本 Gateway 事件不需要新增事件功能补丁；把它作为长期后台观察者时，需要为被检查版本验证并处理连接角色/焦点语义。若上游没有独立观察者模式，可以设计最小兼容修补，但须精确绑定 Host profile 并独立资格验证，保留官方 App 的正常行为。不能全局禁用焦点逻辑，也不能在未部署修补时声明副作用已经消除。

补丁候选、字段透传修正、自己的采集器生命周期分别记账。模型运行钩子继续归真实 run；不得借全局最后一个 listener 注入合成 thinking 状态。

## 全局 Memory 和 Project 的边界

以下为上游数据布局约定，采用相对 data root 表示，不是本机用户资料快照。

| scope | 已观察布局 / 来源 | 含义与限制 |
| --- | --- | --- |
| agent | `agents/<id>/memory/profile.md`、`log/*.md` | 该 Bot 的本机材料 |
| user | `user-memory/by-agent/<id>/profile.md`、`log/` | 按 Bot 分片的用户共享层；可能经过异步同步 |
| project | `projects/<slug>/project.md`、`memory/by-agent/<id>/` | 原生 Project 描述与分片 Memory |
| membership | `agents/<id>/projects.json` | 明确的项目成员关联；不从 Git root 猜测 |
| ordinary files | 受控 Project 文件根 | 文件存在和修改时间不证明作者或任务交付 |

原生 Gateway 的 getAgentMemories 是 Bot 范围且有上限，不能直接成为全局 Memory 服务。扫描已授权文件、监听变化并定期有界校准，可形成全局只读视图；文件监听可能丢事件，必须保留覆盖与校准时间。读取正文应是明确动作，列表默认元数据。

研究实现从条目内容生成短 hash，并从条目日期取得 createdAt。跨 scope/source 相同内容可能同 hash，故公开引用需要来源范围；文件 mtime 不能替代条目时间。内部 dreaming 材料不应直接混入正常用户 Memory，也不能被当作完整因果溯源。

Server 存在 `GrokBotService.ListGrokBotMemoryShards` 和对应 shard 同步程序。被检查版本受 feature gate 控制，处理 profile/logs、harness、version，周期性拉取 Temporal 共享层并推送 Box 分片；不是全账号所有私人 Memory API。研究版本约五分钟轮询，单次请求有截止。当前 grokbox 尚未交付覆盖这些来源的统一查询 adapter，本机共享副本可能滞后。

“全局”在产品中必须定义为当前安装已授权、已接入的来源集合。区分 sourceCoverage、syncAge、stale 与 unavailable。存储中存在、Bot 属于某 Project，都不证明材料进入某次 TURN；研究版本的项目注入还有独立数量边界，不能自动推导运行上下文。

现有[受控 filesystem](../../packages/box-runtime/src/internal/io/governed-filesystem.node.ts)可复用 stat/list/read/download 和 named roots 思路，但现有限额与分页能力须逐项适配。未来 API 不提供任意路径读取、任意 SQL 或通用执行。历史版本和“由哪个 Bot 修改”只有实际记录后才可展示。

## modeld、monitor、alert 与统一服务

| 当前来源 | 已有责任 | 不应误写的结论 |
| --- | --- | --- |
| [monitor runtime](../../packages/box-runtime/src/internal/roots/monitor.runtime.ts) | 有界归属采样、本地 journal drain、存储维护，各有寿命与频率 | 不是不存在，也不是已提供所有实时 Bot 数据 |
| [daemon host](../../packages/cli/src/daemon/host.ts) | API/Job 等现有服务；启动通知与保护 worker | 通知 worker 已实现，不是纯计划；它不会自动代替 monitor 初始化 |
| [modeld runtime](../../packages/box-runtime/src/internal/roots/modeld.runtime.ts) | 独立模型执行、执行历史与结果 | 不应被 Web 请求或观察 SQLite 接管 |
| [outcome 命令](../../packages/cli/src/commands/outcome.ts) | 原生 tray/状态观察 | alert 消失或列表为空不证明成功 |
| [operations 合同](../runtime/operations.md) | incident、证据、ack/snooze、通知 work/attempt 与保留 | ack 不是 resolve，native accepted 不是人类已收到 |

统一后台是目标，当前仍存在不同入口和生命周期。建议长期采集归管理服务，UI/CLI 读取同一归一化读面；消息、运行与管理操作保留独立身份。后台关闭页面后继续工作，普通 GET 不初始化、清理、修复或启动 worker。

用户已指定独立 Effect-first API 与 TanStack Start 前端；具体 apps 拆分、monitor 接管、operation 索引和迁移步骤暂留在[实现影响占位](../roadmap/agent-first-cli/implementation-impact.md)，不在本研究里提前决定。

## 功能可行性矩阵

| UI 能力 | 可行性依据 | 实施前主要差额 |
| --- | --- | --- |
| 官方伙伴小形象 | roster/profile、原生解析和客户端程序化几何 | 自有 renderer、版本降级、自定义图安全读取 |
| Bot 工作/输入/重试与活动类别 | 原生 roster/activity + SSE | DTO 保留、来源判别、后台连接副作用资格 |
| 归属变化与 incident | 已有观察与持久运维程序 | 常驻接管、范围覆盖和实际安装证明 |
| 全局 Memory | 本机分层材料与受限共享 shard 同步 | 有界索引、去重身份、同步缺口与正文权限 |
| Project/文件 | 原生元数据、membership 与受控 FS | 根绑定、分页、更新校准；历史与作者需额外真实记录 |
| 模型/运行日志 | modeld 与现有诊断结果 | 有界归一化、关联身份和脱敏 |
| 任务百分比、自动计划、完整交付归因 | 缺少足够权威事实 | 不进入首版承诺 |
| Web 聊天/审批回复 | 与本次产品方向不符 | 明确排除，不因截图有按钮而实施 |

## 失效与后续验证

Host/App 构建变化、Gateway schema/频道/close 行为、头像默认解析、Memory 布局或 grokbox 投影变化时，重新核验相应事实。测试使用自有合成对象和窄兼容适配；不引入私有 bundle 依赖。来源分析不等于 adapter 测试，adapter 测试不等于真实 App/浏览器/持续运行通过。

本文没有执行部署、修改官方 App、新增 Host 补丁、发送消息或消耗模型额度。新的现场验证应另有固定候选和明确授权，结果只进入既有 LIVE 流程。
