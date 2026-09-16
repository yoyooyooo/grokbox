# 运行结果与 App 警告观测

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

当前用途：本机 managed 推理的 STEP 排障、失败归因和有界证据查询。合同归 [产品合同 §7.3/§7.4](../product-contract.md) 与 [Spec S0.4.1](../roadmap/box-runtime-impl-spec.md)，Host 流合同归 [T26](../tickets/T26-runtime-host-fullstream.md)，发布事实归 [readiness](t32-live-enable-readiness.md)。本页是观测入口/含义，不另定义执行器、重试器或任务数据库。投影实现是 `packages/cli/src/outcome.ts`；`SEND_OUTCOME_STATES` 或 nonce-first join 变更时重审本页。

## v5 失败摘要与受控模型恢复

当前源码实现的 Host/modeld 使用 wire v5；这不证明已驻留进程已升级。`FailureSummary` 由 kernel 的同一纯合同分类，保留安全 HTTP 状态/请求 ID/Retry-After、资格/规范化/预算事实及执行身份。正常摘要由 modeld 直接传给 Host；Host 增补其实际观察到的输出和工具释放，不反查 journal 生成错误，不复制 provider 原始 message/body/headers。错误摘要缺失、版本未知、身份不符时保留原错误码并记录 `failureSummaryStatus`，不将诊断损坏当成新的 `invalid_stream`。严格成功终态、工具和 binding 检查不放宽。

结束审计分开记录 `finishAudit` 与 `terminalAudit`。字段缺失、null、空串、空白、已知结束枚举、未知非空值和错误类型不混同；未知字符串只保留长度/摘要。首次/末次有效终态、首次/末次不支持值与冲突均有记录；后来的 stop 不能洗掉先前异常。旧 `providerFinishObserved` 的语义不变，历史记录不能倒推新字段。DONE/EOF/取消/异常退出独立结算工具参数的可解析性、缺失和最终对象一致性；主失败不被二次审计覆盖。无工具为 `not_applicable`，无有效 finish 的合法参数也不等于可执行调用。

路由 ID 摘要由 endpoint、Chat/Responses、模型与凭据引用命名空间组成，不含密钥；普通日志不输出 endpoint。HTTP 关联 ID 仅来自白名单响应头，限长且限制字符。Retry-After 接受整数秒或严格 IMF-fixdate，记录缺失/非法/合法日期/秒数；它是等待建议，不是上游未执行或未计费的证明。

默认不进行自动模型请求恢复。显式设置以下环境用于启动 modeld，作用域是该 modeld 服务的 managed 请求，而不是任意 Host 或用户消息：

```sh
GROKBOX_MODELD_PROVIDER_RECOVERY=pre-output-http
GROKBOX_MODELD_RECOVERY_EXTRA_REQUESTS=2
GROKBOX_MODELD_RECOVERY_WINDOW_MS=90000
GROKBOX_MODELD_RECOVERY_BASE_DELAY_MS=1000
GROKBOX_MODELD_RECOVERY_MAX_DELAY_MS=10000
```

`off` 为默认。开启即接受重复上游推理/费用可能性；这不是未知工具副作用重放许可。策略按逻辑 STEP 限定额外调用支出和等待，不是服务累计请求配额；本 STEP 原墙钟预算仍然有效。仅明确的 HTTP 429（排除 insufficient_quota）、502/503/504，且未发布非空文本、思考或任何工具材料，才进入等待。其他失败均保留为原始失败，不以 retry 修复坏 JSON/未知 finish。每次 attempt 的身份、保留声明和完成事实写入原执行去重库；失败结算无法可靠写入时停止，不退回内存授权。进程退出不自动恢复旧 STEP。

`model_recovery_progress` 记录 running/waiting/succeeded/stopped/cancelled 及策略、attempt 身份、HTTP 状态和最近的安全上游关联信息；`runtimeRecovery` 按实际 STEP 展示最后观察，不冒充当前存活租约。失败终态复用摘要里的恢复历史，避免同一事件重复放大。恢复等待可取消，不调用工具，不创建新的 TURN，不绕过 ownership/auth/configuration；异步复核之后必须重新检查恢复期限。成功 terminal 在 attempt 持久结算完成后才交给 Host，只有一个批次可以放行。

升级先确认旧服务身份、空闲状态和制品，再用显式 replace/Host 恢复流程成套切换。`runtime modeld status` 可以报告旧 v4 服务的有限读取结果和 `protocolCompatible:false`，但生产 Host 不借此调用旧服务；`replace --expect-epoch ... --confirm` 的兼容读取也不拥有自动重试权。不能把发布 v5 变成“混用 v4/v5 时放开 extra_keys”，也不能删除去重库来迁移。旧数据读取、源码构建、原生 profile 资格和实际部署分别验收。

`runtime status` 的 modeld facet 与 `runtime modeld status` 共用可用性投影，保留 `wireVersion`、`expectedWireVersion`、`protocolCompatible`、liveness、admission 和 executionGap。`protocolComparison=observer_to_modeld` 明确比较的是本次 CLI/观察器与 modeld，不是已经加载的 Host；缺少该 Host 的直接证据时 `hostProtocolCompatibility=not_observed`。旧服务即使没有 execution-status，也可凭其合格 service-info 报告协议不匹配，执行能力另报 not_instrumented；这不满足 replace 的更严格身份/空闲门槛。两次读取跨 service generation 时不拼接旧身份与新执行计数，不显示 ready；scope_mismatch、protocol_mismatch、generation_changed 和单纯未观测分别保留。所有读取均不重启、不替换、不发起 STEP。

## 三类证据不能互相替代

| 表面 | 实际 owner / 生命周期 | 能证明什么 |
|---|---|---|
| `Gateway.getTrays` / `tray` 事件 | 当前 Host `TrayManager` 的内存列表，非 SQLite 任务表。当前源码最多20条 tray、每条最多20个发生时间；会去重、dismiss、evict、新发送清理、重启丢失 | App 当前警告及推送/移除；空列表不能证明成功，不能回查已丢失告警 |
| `Gateway.getAgentTranscriptTail` | 当前目标的 display transcript，明确 nonce、requestId、entry | 用户输入被记录、SendToUser 内容被记录；进度/ack 也在这里，不等于最终业务结果或整个 run 完成 |
| `run/log/events.ndjson` | grokbox Host/modeld 的既有本机持久日志，投影有界，读取可能 truncated | 同一 Agent/TURN/STEP 的准入、推理、Host拒绝/终态；不直接证明用户已读或最终业务成功 |

2026-09-12 对 Host source `307de399…` 检查：trays-service 的 `TrayManager` 只有数组/EventEmitter/去重/上限逻辑；Gateway `getTrays` 委托其 list，Host通过 singular `tray` channel 发布事件。这不否定 App 自己可能有缓存，但本功能不依赖未知客户端存储。源码变化时重审 API、事件形状及生命周期。

## 金丝雀路径（唯一）

Agent 只打这两条。主句柄是 send 回执里的 `clientNonce`。不要用 `alerts list --nonce`（该旗标不存在），也不要发明 `correlationId`。

```sh
grokbox send <agent-id> --text '<text>' --json
# 记下 data.clientNonce。data.accepted / data.status=accepted 只表示已入队，不是回复成功。

grokbox history outcome <agent-id> --nonce <clientNonce> --runtime [--wait-ms 60000] --json
```

`--runtime` 把本机 journal 当作失败权威。查询顶层 `ok:true` 只表示查询成功，必须读 `data.state`、`assessment` 与 `evidence`。若 modeld 是用显式 `GROKBOX_RUN_ROOT` 拉起的（活狗粮是 `$HOME/.grokbox/run`），`history outcome --runtime` 必须用同一个值；以 `evidence.runtimeRoot` 核对实际读取根。根选错、不可读、schema 不识别与窗口缺失是不同缺口，不能只凭 `runtimeGap=invalid` 断言根选错。旧 reader 还会把超过 1 MiB 的整本日志拒读；当前改为有界后缀读取，详见下节。**outcome 无 `accepted` 成功词**；旧 `acceptedObserved` 已改为 `echoObserved`。`data.requestId` 在早期 admit 失败时可为 null，这不表示没发出去。

| `data.state` | 含义 |
|---|---|
| `recorded` | 仅有 user echo 或 journal bind，无终态证据。等待中。不是成功。 |
| `failed` | 命中 durable 拒绝 / 相关 terminal error / 相关 live tray。空 `alerts` 不得改回 `recorded`。 |
| `progress` | 有 delivery，`--expect-text` 未匹配 |
| `delivered` | 有同请求 send-message；显式请求 runtime 时，还要求本次 runtime 读取没有已知缺口。仍不证明 run 完成 |
| `expected_result_observed` | 精确预期内容出现。`executionCompleted` 仍为 `not_proven` |
| `unknown` | 证据缺失、冲突、harness 变化或协议未知 |

默认 `--wait-for delivery` 只把 `failed|delivered|expected_result_observed` 当 settled；`recorded` 继续等。`--wait-for execution --runtime` 不因进度 SendToUser 提前结束：目前仅明确失败可提前结算，否则等待至有界 deadline，不制造原生 run-completed 事实。`executionCompleted:"not_proven"` 始终明确：该命令没有另造原生 run-completed 权威。预期内容只能验证业务断言，不能替代工具是否实际运行、模型身份、checkpoint/reload 等独立证据。

已知 runtime 缺口不会抹掉已观察到的 `delivery`，但没有明确失败时，顶层保持 `unknown`，避免在进度回复上提前结束排障。已确定身份且实际看到的失败仍为 `failed`，即使其余窗口不完整；不把 `runtimeGap` 一律覆盖成 unknown。`assessment.delivery/mainRun/auxiliary/evidence` 分开表达投递、主运行、辅助推理和证据质量；工具材料释放数量不是工具执行凭据，`toolExecution/checkpointCommit` 未接通时明确 `not_instrumented`。

Join（与投影器一致，不另造状态机）：echo 按 nonce 或 requestId；journal 按 `clientNonce` 命中或已在种子里的 turnId/stepId；trays 只按种子里的 requestId/stepId 关联，禁止只按 agentId 模糊匹配。身份冲突 → `unknown`；关联 durable 拒绝 / terminal / live tray → `failed`；runtime/告警证据有缺口且没有明确失败 → `unknown`（仍保留真实 delivery）；证据可用时 delivery → `delivered` / `progress` / `expected_result_observed`；仅 echo 或 journal bind → `recorded`；否则 `unknown`。transcript 窗口没有 echo、但 journal 已有该 nonce 的 reject 时，仍是 `failed`。

## 稳定命令

在源码工作树可用 `bun run grokbox`；实际打包版本可用 `node dist/index.js`；安装版本为 `grokbox`。金丝雀不必打下面这些；它们不是第二套观测入口。

```sh
# 仅读当前警告，不 dismiss/clear，不输出 rawDetail、actions 或私密 URL。没有 --nonce。
grokbox alerts list --agent <agent-id> --json

# 自发送开始之前订阅可捕获短暂出现又被清除的警告；沿用既有事件游标/gap。
grokbox events --channels transcript,tray

# 可选：等一个明确的最终预期内容。--runtime 已隐含 --expect-harness box。
grokbox history outcome <agent-id> --nonce <clientNonce> \
  --runtime --expect-text 'EXPECTED_FINAL_RESULT' --wait-ms 60000 --json

# 次查找：从已有 requestId 解析到同一 SendAttempt，不是第二主键。
grokbox history outcome <agent-id> --request-id <id> --runtime --json

# 截图给的是失败 STEP，而不是首个 display request-id；不要混用。
grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
```

`--runtime` 只允许明确本机 local/auto Profile，拒绝 remote/SSH/daemon/gateway Profile，避免用本机日志给远端任务背书。普通 alerts/outcome 通过 typed Gateway 和 daemon 两种实现；daemon 添加 `grok.alerts.read`，旧 daemon 未提供时不能伪造支持。

同一 Bot 的两份历史不能混算：`agents show/list` 和 roster 事件保留 `harness: box|temporal|unknown`，结果查询用同一 Gateway 的 roster 在每次采样前后校验。`--expect-harness box|temporal` 声明要验的入口，`--runtime` 默认要求 box；路由变化/未知/不符保持 unknown，不返回借另一份历史匹配出来的成功。`evidence.transcriptRoute` 明确声明来源、前后值、非原子采样以及桌面 replica 未观测。完整边界与双账本区别见 [Transcript harness](transcript-harness-box-vs-server.md#acceptance-must-not-mix-transcript-sources)。这不是修复 App 缓存或同步两套 store。

观测等待最多120秒，RPC受剩余预算约束，每次最多5页/1000项，间隔2秒，不在超时后发最后一轮多余请求。匹配失败优先于已发进度；Host明确拒绝优先于其后 modeld 的断连取消。Gateway代变化、nonce关联多个request或未知告警结构保持unknown。无原始body/密钥/操作action进告警投影。事件脱敏保留安全requestId/clientNonce、started/ended身份信息；ended仍不是成功。

## STEP 事故观测闭环（当前实现）

`--nonce`、`--request-id`、`--step-id` 必须三选一，后者要求 `--runtime`。STEP 查找只沿已写入的 Agent/STEP/TURN 身份扩展；不从同名 Bot、时间邻近、正文或 native parentRequestId 猜关联。该命令仍需要当前 Gateway/roster 来限定目标与 transcript route，不是一个可离线查询已删除 Bot 的档案工具。

### 失败诊断与流摘要

`normalizeCause` 和 `rejectSite` 来自实际拒绝分支，不解析自由错误文本。可区分：未声明工具、SDK invalid tool、工具身份冲突/清洗碰撞、完整参数非法/前后不一致、结束时未闭合工具、缺少或不支持的 finish、坏事件、终态 binding 不匹配、预算超限等。外层 `invalid_stream` 文案可保持稳定，精确诊断通过 kernel → backend → modeld → journal 白名单 → CLI 贯通。

每个 provider attempt 使用独立 `StreamEvidence`：固定类型计数、字节数、相对时间、最近 32 条事件描述。成功只附摘要，失败保留相同有界诊断；不保存事件正文、推理文本、参数内容、工具名称或原始异常。未观测字段保持缺失，不伪造零。真实 HTTP fetch 次数与实际 `attempts` 由 modeld 记录，Host 不再把所有 STEP 硬写为 attempt 0。

Provider SSE 审核在 SDK 丢失信息之前记录受限 finish 原因，并校验完整工具参数。合法 JSON 前缀加非法尾部不能通过，特殊资源/上游中断与用户取消分别分类；不补 JSON、不丢多工具调用、不重试、不合成成功终态。SDK 的内部主动预读也受当前消费需求门控，传输字节/帧/参数有界；已有 Host 串行门仍在完整成功前暂存全部工具材料。

本地 IPC 的 EOF、deadline、caller abort 与 socket/write error 使用 `transport_error / transport` 和 `host_modeld_ipc` 侧别。provider body 错误使用 `provider_http`。先检测到的具体 backend 失败不会被随后连接关闭/清理改写；其后事件放入 `followup/transport`。这不宣称知道远端因果顺序。

### 时间、触发来源与构建身份

`observation.writerId/sequence/eventId` 建立生产者本地顺序；`observedAt` 是采集时刻，`startedAt/detectedAt/durationMs` 是本次工作生命周期。不同进程的 monotonic 值不可直接比较，`runtimeTrace.order` 明确为追加顺序而非跨进程因果顺序。

Host 的现有 `sessionOptions.requestSource/lineage` 被投影为 `nativeTurn`，无需扩大 createSession 接缝。source 仅接受 `turn/agent/automation/handoff-resume/connector/voice-call`；未知值标 unknown。原生 parent/root request UUID 可保留，但绝不重命名为 kernel STEP/TURN；原生工具调用 ID 仅记录存在性，不复制潜在控制字符/正文。缺失字段不以正文推断；后续新 TURN 不是自动认定的重试。

打包构建向 CLI 与 preload 注入同一个公共源码/lock/build-input digest，以及编译器和实际安装的 SDK 版本；源码直跑标 `kind:source`。它是构建输入指纹，不是产物自身 SHA。部署仍需核对真正加载的 CLI/preload 文件摘要、Host profile/source 与 service epoch；重建 dist 不重启服务。

### Reader、retention 与 writer 健康

普通 tail 最多读 1 MiB；精确请求查找最多读 16 MiB，最多返回 4096 条相关事件。只打开 regular、no-follow 描述符并固定读取起始大小；支持 UTF-8 切边、并发末行未完成和轮转/缩短检测。每行最多 64 KiB，扫描最多 65536 行。`runtimeCoverage` 报告字节范围、prefix omission、partial append 和变化情况；未找到是窗口内未找到，不证明不存在。

watchdog 的既有 compact 入口保留近期控制/流事件，并额外优先保留最多 128 个、七天内事故 TURN 的失败核心、hook/STEP 身份与有限上下文；总保留字节上限 8 MiB。年龄、数量或容量外没有永存承诺。读取不 compact，compaction 不触碰执行去重账本。准备/应用 receipt 先后发布，跨文件不是事务；中途失败保留 `prepared` 不确定性。查询命中精简过的旧前缀时显示 `retained_subset`，不能把事故摘要当成完整执行记录。后续新追加、未被精简的请求不继承旧前缀缺口。

writer 健康快照在 `state/journal-health/`，与可能损坏的事件日志分开。记录写入/投影失败、pending/峰值、observer 失败及最近成功时间；无 timer、无隐式修复。快照自身写失败也保留进程内计数，但全盘不可写时不承诺新进程能恢复未落盘计数。读取返回的 writer snapshot 是有时间戳的历史事实，不是当前 PID 存活或准入许可。过多历史 writer 时返回 partial/truncated，不做无界目录扫描。

### 尚不能从本闭环推导的事实

原生工具真实执行、checkpoint/blob/mirror 跨层提交、App replica 显示和未插桩唤醒分支，仍需各自 qualified consumer 证据。失败前释放过工具不能重放整个 TURN；被观察到的 native lineage 不能绕过现有 retry/ownership/STEP fences。原历史事故没有记录的 finish/工具名无法由新补丁回填。

### 本轮验证边界（2026-09-16）

源码/打包相关的 41 个明确选定测试文件：386 pass / 0 fail；包括真实 pinned SDK 合成 SSE、实际临时 Unix modeld/Host 链路、32 条安全摘要、SDK 内部预读背压、工具参数尾部、全批并行拒绝、严格终态/binding、上下文连续性、辅助推理、旧 journal 回归与 owned packed preload。全仓 TypeScript 检查和 Node 语法检查通过。Bun 1.3.14 两次同输入构建的 CLI/preload SHA 完全相同；E09 pin 仅在此验证后更新，不修改原生 Host source pin。

不能据此签全仓或生产绿：`test/incident-observability.test.ts` 的新增大日志/retention/健康/CLI 综合矩阵执行被工具安全检查拦截，只有代码和类型检查，待补跑；原请求的只读现场 STEP 查询也被工具拦截，没有现场查询修复的成功回执。另外两项原生 Host 资格测试仍钉住旧 source SHA，当前安装版本不同，原断言保持不变且未通过；owned fixture/packed 通过不能替代这项资格。没有 deploy、Host/modeld 重启、真实 provider 重放、线上 compact 或策略/任务变更。

## 历史 App 反例及永久修复

Synthetic regression scenario: an earlier progress message is not a final result. A later Host rejection must remain `state:failed` even when live trays have already disappeared. The owned regression fixtures carry the public proof; private transcripts and execution identities are not distributed.

桥的历史策略是 `parallel:fail-closed`，先补过 `parallel_tool_calls:false`，但这个改动只减少触发，并没有让合法多调用批次可运行。当前生产改为 `validated-batch`：保留单调用生成偏好（以及明确传入的选项），不把它当成 Host 的执行批次数量限制；在整个流和批次通过后，按首次出现顺序保留全部 start/delta/complete 与 response 调用，让原生 Host 自己执行并归并结果。任何坏成员、未闭合、终态错误或提交前取消均不释放工具材料；不丢第二个调用、不自动重试，也不宣称工具副作用具有原子性或被强制串行化。显式单调用 helper 仍可用 fail-closed，但生产 hook 不再选择它。

新的 Host terminal `diagnostic.stream` 包含 `hostToolPolicy`、`requestedParallelToolCalls`、`toolBatchState`，以及 `toolsStarted/toolsCompleted/openTools/hostToolsReleased`。区分“请求生成单调用但收到合法批次”和“坏批次被拒绝”，也能查明仍加载旧 single-tool 策略。旧记录缺这些字段时保持未知，不能从缺字段推导当前部署。对应组合测试是 `validated-tool-batch.test.ts` 与 `validated-tool-batch-unix.test.ts`，后者通过真实 SDK、Unix 和 production hook 验证 Chat/Responses 的批次及后续结果回填；工具执行为 owned fixture，不冒充现役原生 Host 资格。

Host终态持久投影新增terminalClass/errorCode/toolCallCount/modelId，拒绝记录增加stepId。这样以后可以分清Host的 `parallel_tools` 与模型端被关socket后的 `disconnected`，不用再依赖用户截图。该新增Host写入逻辑只有新preload被加载之后才生效，不能回填旧历史。

## AH-92.5 wave D：早期 admit 拒绝

现场 catalog 里的可选模型都是 openai*，`models use` 对未登记 id 会在写入前拒绝（`Unknown model … Add it to models.json first.`）。因此不能再用 `models use <非 openai*>` 复现原始狗粮班。最小负例是：只给一个 box Bot 临时写入非 openai 赋值 `ah92-admit-deny/none`（provider `acme`），然后跑金丝雀两条命令，最后还原 `models.json`。不新增 CLI 面。维护入口：

```sh
bun scripts/verify-ah92-admit-observation.mjs --confirm --agent <name-or-id> --protected-agent-id <uuid>
```

缺 `--confirm`、显式 `--agent` 或有效 `--protected-agent-id` 时，在读取运行配置前拒绝且不写盘。没有默认生产目标，也不发布真实保护对象 ID。运行者必须从受控本机配置取得保护对象 ID；名称为 `grokbox` 或解析后 ID 与保护对象相同的目标一律拒绝。观察后必须恢复原先赋值；未开始变更的拒绝不触发配置重写。

准入失败的稳定消息为 `route admits only stub/echo or openai* in this slice.`。

Public acceptance assertions: early admit denial remains `failed`, including with a null display request ID or empty alerts; the durable rejection must be nonce-bound and stable across readers. This is a synthetic test recipe, not a published live receipt.

失效条件：Host preload 丢 nonce 绑定、catalog 出现 CLI 可 `models use` 的非 openai 模型、或 outcome 又把空 alerts 当成成功。

## 换模防回归（AH-97）

立刻绿不够。以下使用合成示例名称 `model-dogfood`；运行者须显式选择已批准的非保护目标，并按顺序验证：

```sh
grokbox models use <model-id> --for model-dogfood
grokbox send model-dogfood --text '<text>' --json
# 记 data.clientNonce。入队不是回复。

grokbox history outcome model-dogfood --nonce <clientNonce> --runtime [--wait-ms 60000] --json
grokbox agents show model-dogfood --json
# data.agent.title （App Label）须含 m=<alias-or-model>

grokbox agents title sync
# 再等至少一轮 daemon title-sync（~120s），再 show；m= 仍须在。
```

仍只打金丝雀两条观测命令；send 回执 / 空 alerts / 第一秒 title 不得当成换模成功。运行者文案见 [skill](../../skills/grokbox/SKILL.md#prove-a-model-switch)。禁止打长期金丝雀 `grokbox` Bot。

## STEP 事故查询与结构化诊断（当前实现）

只有截图 STEP、Gateway 已停、Bot 改名或 tray 已清空时，使用现有本机 journal 的离线查询：

```sh
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" grokbox runtime incident <step-id> --agent <agent-id> --json

# 需要同时核对展示历史时，仍由同一个 outcome projector 给出判断：
GROKBOX_RUN_ROOT="$HOME/.grokbox/run" grokbox history outcome <agent-id> --step-id <step-id> --runtime --json
```

离线命令不依赖 Gateway、不读取/修改 Bot 业务库、不重新发送、不创建新的执行 ID、不清 tray、不 compact，也不产生恢复授权。Agent 和 STEP 必须是明确 ID。`--step-id` 不被冒充为展示 transcript 的 requestId；只有已记录的 TURN/nonce 关联才能连接到原发送。关联保留 generation/service epoch 冲突供投影器拒绝，不按时间接近、同名或同 Bot 拼接新 TURN。

`observations` 把 delivery、execution、runtimeEvidence、工具释放下界与原生执行/checkpoint 证据分开。已有进度回复加 unreadable/truncated runtime 不再返回可被当作运行结论的 `delivered`；已观察到的同 STEP 失败仍优先于局部日志缺口或不相关 tray schema 失败。没有 Host 释放记录时数量是 null，不是零。工具释放计数不是物理执行/回滚证明。辅助 purpose/parent 只来自 Host 明确记录，不按无工具/短 prompt 猜测。

`runtimeFailure.diagnostic` 的固定 `normalizeCause`/`rejectSite` 区分：missing/unsupported finish、未声明工具、ID/名称冲突、ID 清洗碰撞、参数不合法/不一致、结束时工具未闭合、SDK invalid part、坏 wire/terminal、binding 不匹配、输出预算。具体诊断贯通 BackendFailure → modeld outcome → 安全 projector → reader → outcome；Host 自己发现的拒绝也保留其站点。转发 modeld 失败的 Host terminal 不另造一个本地原因。

每个 attempt 的 `stream` 仅含固定类型计数、字节数、相对时序、最多 32 项结构 ring、provider/SDK finish 枚举及编译进入制品的 SDK 版本/adapterRevision/pipeline。未安装 SSE reader 时 finish/done 观测是缺失，不是 false；仅真正安装后才初始化观测。成功 Host 摘要不携带 ring 正文。`at` 是记录决策时刻，`recordedAt` 是 modeld 持久化时刻；各进程的日志行序不是跨进程因果证明。`backendAttempts` 是实际消费 infer 的次数，不再硬写 attempt=0；并非 HTTP redirect 或原生多 TURN 旅程计数。

取消和清理不再覆盖已取得的具体 normalize/provider failure：`cleanup.clientDisconnected/cancellationRequested/exitFailure` 独立呈现。`disconnected` 指 Host–modeld 本地连接，不等于 provider HTTP 先断。不能仅因发生顺序相近推导因果，后继 TURN 的 trigger/父关系未被合资格原生接点记录时，明确 `not_observed`。

## 精确预算与运行中资格复核

`diagnostic.budget` 记录实际拒绝层 `layer`、指标 `metric`、配置的 `limit` 与触发时 `measured`。语义输出、表示存储估算、原始传输字节、单帧字节和工具数是不同预算，不得只称作 stream safety limit。生产不设 4096 个累计事件门槛；显式调用方自设 maxParts 仍会披露 event_count。Replay 和暂存参数按块保留，每位 reader 的字符游标独立；原始分片大小与重放分片大小可以不同，拼接后的有序文本、工具 ID、参数和结果关联必须一致。整批释放前再预留 replay 表示空间，不能发生容量失败却已经放行半批工具。

`not_admitted` 在流中出现表示本地执行资格复核失败，不应被显示成 provider API 故障。`diagnostic.authority` 保存固定原因、实际 checkpoint（admission/before_dispatch/after_auth/tool_start/tool_complete/finish/recovery）与查询耗时；有依据时才保存 evidenceAgeMs。初始拒绝的顶层 phase 仍是 admission，运行中拒绝为 authority。Host/CLI 使用 authority-rejected，不声称已调用模型的请求从未发出。旧 model_error/provider 可按明确同 STEP 的 modeld not_admitted 细化，同时 `reported` 保留原始 Host 分类。没有记录的历史原因不回填。

### 归属读取失败的子诊断

`server_read_unavailable` 表示未取得可用的服务端归属观测，不表示已经证明账号没有权限，也不是模型 Provider 的鉴权失败。`diagnostic.authority.ownershipRead` 是可选的、version=1 的白名单观察：固定 source、state，以及原生读取返回的 `errorCode`（timeout / authorization_unavailable / unsupported_rpc / server_read_failed / invalid_response / busy / invalid_request / scope_unavailable / scope_changed）。可用时另记有限 RPC code（1–16），不记录异常 message、Cause、响应、URL、账户/机器/scope 标识或凭据。

`authority.checkpoint` 是 STEP 的检查点；嵌套 `ownershipRead.phase` 是原生 reader 的 input / scope_before / server / scope_after / complete，两者不是同一层。`serverRead` 区分未发起、实际 request、共享 pending read 与 cache。`authority.durationMs` 是整个资格检查耗时，`waitBudgetMs` 是外层读取预算；嵌套 durationMs/deadlineMs/serverWaitMs/serverEvidenceAgeMs 分别是原生读总耗时、预算、服务端等待和原始证据年龄。命中缓存或晚到响应不重置证据年龄。外层 Gateway/Effect 等待超时但未收到 native 结果时，只记录 `ownership_read_timeout` 与外层预算，不伪造 native timeout/RPC code。

这组事实通过同一 `FailureSummary` 从真实 admission/stream guard 传到 v5 Unix、Host 错误、三个终态日志、离线 incident、提醒关联及 monitor 的持久化执行证据。只有明确记录 `backendAttempts=0` 才提示“本 STEP 未发起模型请求”；没有 attempts 或仅有零输出不能得出该结论。流中 tool_start 等检查失败仍保留已发起模型的事实。工具释放、真实工具执行及 App 已渲染继续是独立观察。

旧 Host 的快照若已有有限子码/时间，可保留这些原始字段；旧 journal 只剩 `server_read_unavailable` 时不回填“超时”，不猜 HTTP/RPC 细节。可见提示明确指出底层读错误未记录。新增字段不要求为兼容观测放宽执行协议。

这些诊断不放松 ownership 新鲜度、scope、Host generation、撤销和取消的防线，不延长陈旧授权，不自动重发整个 STEP 或 TURN。

## 日志窗口、保留与写入健康

reader 固定打开一个 inode 的尾部快照，普通 tail 最多 1 MiB，身份查询最多 16 MiB、65536 个完整行，每行最多 64 KiB；目标查询先按 Agent/STEP/nonce/TURN 过滤，再应用 4096 事件返回预算。该返回预算不限制模型输出的累计事件数。身份查询同时保留明确关联的提醒生命周期和同代观测安装证据；窗口丢前缀且没有 TURN 起始锚点时，不因找到了某条记录就声称完整。`runtimeWindow` 报告文件/读取字节、offset、前缀遗漏、末尾半行、坏 UTF-8/schema 行、超长行、读中 inode/truncate 变化及保留 watermark。半行和坏行不会使已读到的完整失败消失；缺失/不可用/窗口外不提升为“没有失败”。这不是无限历史检索或永久事故存储承诺。

watchdog 的显式 writer 入口负责保留：优先失败核心、相关 STEP 和 nonce/TURN 锚点，再保留周边及近期活动；最多覆盖近 7 天内的 128 个事故，合计 8 MiB。预算优先，不是无条件完整 TURN 或 7 天 SLA。实际裁剪保留旧格式同文件 watermark，同时写入带 inode 身份的 prepared/applied 保留回执；跨文件发布不伪装成原子事务，未完成的回执明确退化。没有新回执的旧 watermark 仍参与缺口判断。读命令绝不做 retention。

`runtime watchdog run` 的回执增加 `observationMaintenance`；同时处理 durable controller root 与**显式** `GROKBOX_RUN_ROOT`。未显式指定 host run root 时不替自定义 durable root 去 compact HOME fallback，回执为 `not_configured`。本命令没有安装 scheduler；持续维护仍由正常 watchdog/部署生命周期调用，不能把一次维护或新源码当作服务已经部署。

Host/modeld 的 journal 写入仍是观察，不改变推理语义。角色化健康摘要位于 `state/journal-health/<role>-<pid>-<instance>.json`，分别记录 attempted/written/failed/unprojected/timedOut/dropped/pending/peakPending、观察器和健康摘要失败。实际 append 只计一次，modeld 不被外层包装再次计成 Host；投影拒绝不计成功写入，积压丢弃也不再填零。每根每角色最多 64 个 pending 约束的是并发观测积压，不是累计执行额度。缺少新目录时，只读兼容既有 `state/observability/<observer-id>.json`，来源标为 legacy；旧格式没采集的计数不补猜。新 reader 有界枚举并披露截断。文件或旧 PID 不是活性租约，`liveness:not_proven` 不被提升成健康；health 自身也无法写时 reader 应显示 unavailable/not_instrumented，不向同一本坏日志递归报错。任何日志失败都不授权自动重试、回退模型或隐式改配置。

## Provider 单次流与工具完整性边界

生产 backend 使用 SDK **公开 provider-v2 `doStream` 单次调用**，而非 `streamText` 自带的工具结果 fan-in。固定依赖中后者在 `ReadableStream.start` 里后台 `pipeTo/enqueue`，仅给下游 Effect Queue 加容量并不能阻止它提前读完整流。现在一条有界、可取消的链直接消费 provider stream，Effect Queue 容量 16 并 await offer，累计 canonical 预算在入队前检查；拒绝不能改为 drop。

原始 SSE 有透明、需求驱动的结构审计（无 tee、正文落盘或重写）。SDK 首次识别合法 JSON 前缀后忽略尾部的情况，由完整参数累计与 finish 校验拦截；Responses 参数 done 与完整 item 也对齐。单帧、传输字节、工具身份和实际保留资源继续有界，但不按累计 Host 事件数或参数/行碎片数拒绝生产流：参数、行和晚读者文本按分配块合并，UTF-8/CRLF 跨 chunk 正确处理。语义输出不重复计算每个 JSON 帧头或同一工具的最终参数副本；frame 数和编码字节仍原样观测。不补 JSON、不删除坏尾部、不把资源不足或 provider aborted 映射成成功。provider finish 字符串只保留安全枚举；未知为 other，不复制自由文本。

Host IPC 的异步解码与 EOF 使用同一串行路径，避免已经到达的 terminal 被 EOF 回调先行丢弃；socket 暂停随消费者需求，而不只是随解码速度。慢读者至多等待一帧已解码数据，不用累计 4096 帧拒绝代替背压。modeld 的 `attempts` 保存有界诊断细节并披露 `attemptsTruncated`；真实请求次数与持久 recovery 身份不因诊断采样被截短，早期 502 后最终成功仍能保留各自证据。

构建身份由源码、workspace/package 元数据、锁文件和构建入口计算，CLI/preload 注入同一纯 kernel 数据合同；不从 Host 引入 process IO，原生 LevelDB/SQLite 依赖仍以发布依赖装载。构建后源码指纹变化则拒绝资格，不把磁盘制品更新等同于进程已经重载。

canonical 成功 terminal 等 SDK stream EOF 后才释放，晚到参数/错误不得藏在一个已发出的成功后面。所有并行调用都传给 Host 的整批门禁，不再静默保留第一个。工具声明、身份、完整参数和 accepted/terminal binding 的防线都保留；Host 才执行工具。用户混合消息仅合并相邻同类块，不把后面的文本搬到工具结果前面。没有这些检测器的旧日志不能回填出历史原始工具名/参数或唯一根因。

这些上限约束受控 payload，不是 JS heap、OS buffer 或整个长期 Agent 生命周期的绝对内存证明。原生 trigger/checkpoint/Memory writer、App replica、TURN 退休与完整模型回程资格仍依各自 owning ticket；缺失证据被明确呈现，不把 schema 字段存在或 synthetic SDK/Unix green 当作 native closure。

## 验证与现场边界

2026-09-12本轮 scoped regression **123 pass / 0 fail**（含CLI/事件/管理/运行时合同、12个结果观测测试、5个工具准入/终态测试、持久凭据与原生outer retry回归）。真实只读结果查询也已完成。完整全仓测试调用及候选 profile-write/re-adopt 调用被工具安全检查拦截，未执行；未改路重试部署，没有宣称串行策略修复已在现场加载或真实工具链已验完。具体制品身份与后续待验项以readiness为准。
