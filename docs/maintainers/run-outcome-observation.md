# 运行结果与 App 警告观测

> Publication note: operational identities below are synthetic examples. Private evidence locations and machine execution records are not distributed; historical observations do not qualify a current deployment.

当前用途：生产 grok-4.6 的 CLI 自测试闭环。合同归 [产品合同 §7.3/§7.4](../product-contract.md) 与 [Spec S0.4.1](../roadmap/box-runtime-impl-spec.md)，Host 流合同归 [T26](../tickets/T26-runtime-host-fullstream.md)，发布事实归 [readiness](t32-live-enable-readiness.md)。本页是观测入口/含义，不另定义执行器、重试器或任务数据库。投影实现是 `packages/cli/src/outcome.ts`；`SEND_OUTCOME_STATES` 或 nonce-first join 变更时重审本页。

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

`--runtime` 把本机 journal 当作失败权威。查询顶层 `ok:true` 只表示查询成功，必须读 `data.state`。若 modeld 是用显式 `GROKBOX_RUN_ROOT` 拉起的（活狗粮是 `$HOME/.grokbox/run`），`history outcome --runtime` 必须用同一个值；根选错、不可读、schema 不识别与窗口缺失是不同缺口，不能只凭 `runtimeGap=invalid` 断言根选错。旧 reader 还会把超过 1 MiB 的整本日志拒读；当前改为有界后缀读取，详见下节。**outcome 无 `accepted` 成功词**；旧 `acceptedObserved` 已改为 `echoObserved`。`data.requestId` 在早期 admit 失败时可为 null，这不表示没发出去。

| `data.state` | 含义 |
|---|---|
| `recorded` | 仅有 user echo 或 journal bind，无终态证据。等待中。不是成功。 |
| `failed` | 命中 durable 拒绝 / 相关 terminal error / 相关 live tray。空 `alerts` 不得改回 `recorded`。 |
| `progress` | 有 delivery，`--expect-text` 未匹配 |
| `delivered` | 有同请求 send-message |
| `expected_result_observed` | 精确预期内容出现。`executionCompleted` 仍为 `not_proven` |
| `unknown` | 证据缺失、冲突、harness 变化或协议未知 |

默认 `--wait-for delivery` 只把 `failed|delivered|expected_result_observed` 当 settled；`recorded` 继续等。`--wait-for execution --runtime` 不因进度 SendToUser 提前结束：目前仅明确失败可提前结算，否则等待至有界 deadline，不制造原生 run-completed 事实。`executionCompleted:"not_proven"` 始终明确：该命令没有另造原生 run-completed 权威。预期内容只能验证业务断言，不能替代工具是否实际运行、模型身份、checkpoint/reload 等独立证据。

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
```

`--runtime` 只允许明确本机 local/auto Profile，拒绝 remote/SSH/daemon/gateway Profile，避免用本机日志给远端任务背书。普通 alerts/outcome 通过 typed Gateway 和 daemon 两种实现；daemon 添加 `grok.alerts.read`，旧 daemon 未提供时不能伪造支持。

同一 Bot 的两份历史不能混算：`agents show/list` 和 roster 事件保留 `harness: box|temporal|unknown`，结果查询用同一 Gateway 的 roster 在每次采样前后校验。`--expect-harness box|temporal` 声明要验的入口，`--runtime` 默认要求 box；路由变化/未知/不符保持 unknown，不返回借另一份历史匹配出来的成功。`evidence.transcriptRoute` 明确声明来源、前后值、非原子采样以及桌面 replica 未观测。完整边界与双账本区别见 [Transcript harness](transcript-harness-box-vs-server.md#acceptance-must-not-mix-transcript-sources)。这不是修复 App 缓存或同步两套 store。

观测等待最多120秒，RPC受剩余预算约束，每次最多5页/1000项，间隔2秒，不在超时后发最后一轮多余请求。匹配失败优先于已发进度；Host明确拒绝优先于其后 modeld 的断连取消。Gateway代变化、nonce关联多个request或未知告警结构保持unknown。无原始body/密钥/操作action进告警投影。事件脱敏保留安全requestId/clientNonce、started/ended身份信息；ended仍不是成功。

## 这次 App 反例及永久修复

Synthetic regression scenario: an earlier progress message is not a final result. A later Host rejection must remain `state:failed` even when live trays have already disappeared. The owned regression fixtures carry the public proof; private transcripts and execution identities are not distributed.

桥的历史策略是 `parallel:fail-closed`，先补过 `parallel_tool_calls:false`，但这个改动只减少触发，并没有让合法多调用批次可运行。当前生产改为 `validated-batch`：保留单调用生成偏好（以及明确传入的选项），不把它当成 Host 的执行批次数量限制；在整个流和批次通过后，按首次出现顺序保留全部 start/delta/complete 与 response 调用，让原生 Host 自己执行并归并结果。任何坏成员、未闭合、终态错误或提交前取消均不释放工具材料；不丢第二个调用、不自动重试，也不宣称工具副作用具有原子性或被强制串行化。显式单调用 helper 仍可用 fail-closed，但生产 hook 不再选择它。

新的 Host terminal `diagnostic.stream` 包含 `hostToolPolicy`、`requestedParallelToolCalls`、`toolBatchState`，以及 `toolsStarted/toolsCompleted/openTools/hostToolsReleased`。区分“请求生成单调用但收到合法批次”和“坏批次被拒绝”，也能查明仍加载旧 single-tool 策略。旧记录缺这些字段时保持未知，不能从缺字段推导当前部署。对应组合测试是 `validated-tool-batch.test.ts` 与 `validated-tool-batch-unix.test.ts`，后者通过真实 SDK、Unix 和 production hook 验证 Chat/Responses 的批次及后续结果回填；工具执行为 owned fixture，不冒充现役原生 Host 资格。

Host终态持久投影新增terminalClass/errorCode/toolCallCount/modelId，拒绝记录增加stepId。这样以后可以分清Host的 `parallel_tools` 与模型端被关socket后的 `disconnected`，不用再依赖用户截图。该新增Host写入逻辑只有新preload被加载之后才生效，不能回填旧历史。

## AH-92.5 wave D：早期 admit 拒绝

现场 catalog 里的可选模型都是 openai*，`models use` 对未登记 id 会在写入前拒绝（`Unknown model … Add it to models.json first.`）。因此不能再用 `models use <非 openai*>` 复现原始狗粮班。最小负例是：只给一个 box Bot 临时写入非 openai 赋值 `ah92-admit-deny/none`（provider `acme`），然后跑金丝雀两条命令，最后还原 `models.json`。不新增 CLI 面。维护入口：

```sh
bun scripts/verify-ah92-admit-observation.mjs --confirm [--agent model-dogfood]
```

缺 `--confirm` 不写盘。禁止打长期金丝雀 `grokbox` Bot。默认目标是 `model-dogfood`（`00000000-0000-4000-8000-000000000119`），跑完必须把它付回原先赋值。

Expected message: `route admits only stub/echo or openai* in this slice.`. Public acceptance assertions: early admit denial remains `failed`, including with a null display request ID or empty alerts; the durable rejection must be nonce-bound and stable across readers. This is a synthetic test recipe, not a published live receipt.

失效条件：Host preload 丢 nonce 绑定、catalog 出现 CLI 可 `models use` 的非 openai 模型、或 outcome 又把空 alerts 当成成功。

## 换模防回归（AH-97）

立刻绿不够。金丝雀对长期狗粮 Bot（默认 `model-dogfood` / 当前 assigned Pi 模型）按顺序：

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

这些诊断不放松 ownership 新鲜度、scope、Host generation、撤销和取消的防线，不延长陈旧授权，不自动重发整个 STEP 或 TURN。

## 日志窗口、保留与写入健康

reader 固定打开一个 inode 的尾部快照，最多 8 MiB、32768 个完整行，每行最多 64 KiB；目标查询先按 Agent/STEP/nonce/TURN 过滤，再应用 4096 事件返回预算。`runtimeWindow` 报告文件/读取字节、offset、前缀遗漏、末尾半行、坏 UTF-8/schema 行、超长行、读中 inode/truncate 变化及保留 watermark。半行和坏行不会使已读到的完整失败消失；缺失/不可用/窗口外不提升为“没有失败”。这不是无限历史检索或永久事故存储承诺。

watchdog 的显式 writer 入口负责保留：最近 256 条 control + 256 条 seam，以及近 7 天内最多 128 个、合计 4 MiB 的失败 TURN 证据组。预算优先、不是无条件 7 天 SLA；实际裁剪留下同文件原子 watermark，包含丢弃记录下界与可能受影响的时间范围。读命令绝不做 retention。

`runtime watchdog run` 的回执增加 `observationMaintenance`；同时处理 durable controller root 与**显式** `GROKBOX_RUN_ROOT`。未显式指定 host run root 时不替自定义 durable root 去 compact HOME fallback，回执为 `not_configured`。本命令没有安装 scheduler；持续维护仍由正常 watchdog/部署生命周期调用，不能把一次维护或新源码当作服务已经部署。

Host/modeld 的 journal 写入仍是观察，不改变推理语义。独立的 `state/observability/<observer-id>.json` 安全计数记录 attempted/written/unprojected/writeFailed/timedOut/dropped/pending/peakPending 与最后成功/失败时间。事件写入请求进程内有界（每根最多 64 个 pending）；health 读取最多 32 个 writer 文件并披露截断。文件或旧 PID 不是活性租约，`liveness:not_proven` 不被提升成健康；health 自身也无法写时 reader 应显示 unavailable/not_instrumented，不向同一本坏日志递归报错。任何日志失败都不授权自动重试、回退模型或隐式改配置。

## Provider 单次流与工具完整性边界

生产 backend 使用 SDK **公开 provider-v2 `doStream` 单次调用**，而非 `streamText` 自带的工具结果 fan-in。固定依赖中后者在 `ReadableStream.start` 里后台 `pipeTo/enqueue`，仅给下游 Effect Queue 加容量并不能阻止它提前读完整流。现在一条有界、可取消的链直接消费 provider stream，Effect Queue 容量 16 并 await offer，累计 canonical 预算在入队前检查；拒绝不能改为 drop。

原始 SSE 有透明、需求驱动的结构审计（无 tee、正文落盘或重写）。SDK 首次识别合法 JSON 前缀后忽略尾部的情况，由完整参数累计与 finish 校验拦截；Responses 参数 done 与完整 item 也对齐。单帧、传输字节、工具身份和实际保留资源继续有界，但不按累计 Host 事件数或参数/行碎片数拒绝生产流：参数、行和晚读者文本按分配块合并，UTF-8/CRLF 跨 chunk 正确处理。语义输出不重复计算每个 JSON 帧头或同一工具的最终参数副本；frame 数和编码字节仍原样观测。不补 JSON、不删除坏尾部、不把资源不足或 provider aborted 映射成成功。provider finish 字符串只保留安全枚举；未知为 other，不复制自由文本。

canonical 成功 terminal 等 SDK stream EOF 后才释放，晚到参数/错误不得藏在一个已发出的成功后面。所有并行调用都传给 Host 的整批门禁，不再静默保留第一个。工具声明、身份、完整参数和 accepted/terminal binding 的防线都保留；Host 才执行工具。用户混合消息仅合并相邻同类块，不把后面的文本搬到工具结果前面。没有这些检测器的旧日志不能回填出历史原始工具名/参数或唯一根因。

这些上限约束受控 payload，不是 JS heap、OS buffer 或整个长期 Agent 生命周期的绝对内存证明。原生 trigger/checkpoint/Memory writer、App replica、TURN 退休与完整模型回程资格仍依各自 owning ticket；缺失证据被明确呈现，不把 schema 字段存在或 synthetic SDK/Unix green 当作 native closure。

## 验证与现场边界

2026-09-12本轮 scoped regression **123 pass / 0 fail**（含CLI/事件/管理/运行时合同、12个结果观测测试、5个工具准入/终态测试、持久凭据与原生outer retry回归）。真实只读结果查询也已完成。完整全仓测试调用及候选 profile-write/re-adopt 调用被工具安全检查拦截，未执行；未改路重试部署，没有宣称串行策略修复已在现场加载或真实工具链已验完。具体制品身份与后续待验项以readiness为准。
